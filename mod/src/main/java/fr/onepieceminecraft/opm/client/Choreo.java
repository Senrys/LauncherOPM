package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.GlStateManager;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.BufferBuilder;
import com.mojang.blaze3d.vertex.BufferUploader;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.MeshData;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.Tesselator;
import com.mojang.blaze3d.vertex.VertexFormat;
import com.mojang.blaze3d.vertex.VertexSorting;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;
import org.joml.Matrix3f;
import org.joml.Matrix4f;
import org.joml.Matrix4fStack;
import org.joml.Vector3f;
import org.lwjgl.opengl.GL11;

/**
 * La scène de chargement, en vraie 3D, à la résolution de l'écran.
 *
 * <p>Une chorégraphie <b>déterministe</b> : tout se déduit de l'horloge de la
 * scène (secondes depuis son début, partagée avec le launcher par
 * {@code opm/session.json}), si bien que le launcher (launcher/src/assets/js/
 * components/loadingScene.js, le même calcul) et le jeu montrent la même chose
 * au même instant — le passage de l'un à l'autre ne se voit pas.
 *
 * <p>Ce qui s'y passe, en boucle de {@link #CYCLE} secondes : Xenodys façonne un
 * monde de blocs entre ses mains ; sur le circuit, à gauche, un joueur s'imprime
 * (un skin de la galerie) ; il se change en orbe, qui monte ; Xenodys vole jusqu'à
 * lui, le saisit, le rapporte et le dépose dans le monde, qui gagne un bloc. Ses
 * mains visent vraiment ce qu'elles touchent (cinématique inverse des bras), sa
 * tête regarde ce qu'elle fait, son corps se penche dans le sens du vol. Deux
 * assistants : l'un travaille au circuit, l'autre fait sa ronde et trébuche
 * parfois.
 *
 * <p>Dessin : le shader {@code position_tex_color} (le seul de la 3D disponible
 * pendant le chargement), l'ombrage cuit dans la couleur des faces, une passe
 * additive pour les parties lumineuses (glowmask).
 */
public final class Choreo {
    public static final double CYCLE = 10.0;
    private static final float FOV = 12f;
    private static final float PITCH = 8f;
    private static final Vector3f TARGET = new Vector3f(0, 64, 0);
    /** Hauteur visible au plan z = 0, en unités du modèle. */
    private static final float VIEW = 150;
    private static final float DIST = (float) (VIEW / 2 / Math.tan(Math.toRadians(FOV / 2)));
    private static final int N = 4;
    private static final float BLOCK = 7f;
    /** Les joueurs imprimés et leur socle, agrandis pour qu'on les voie. */
    private static final float PLAYER = 1.5f;
    private static final float BOT = 1.4f;

    private final GeoModel xen = Xen.model();
    private final GeoModel bot = GeoModel.load("xenodys_assistant", "animation.xenodys_assistant");
    private final GeoModel socle = GeoModel.load("socle", null);
    private final GeoModel player = GeoModel.load("joueur", null);
    private final GeoModel playerSlim = GeoModel.load("joueur_fin", null);
    private final GeoModel block = GeoModel.load("bloc", null);

    private Matrix4f view;
    private Matrix3f viewNormal;
    private float aspect = 16 / 9f;

    // État lissé (d'une image à l'autre).
    private final float[] armR = new float[4];
    private final float[] armL = new float[4];
    private Vector3f handTargetR;
    private Vector3f handTargetL;
    private float headYaw;
    private float headPitch;
    private float bodyYaw;
    private final float[] shownAt = new float[N * N * N];
    /** Courbure des doigts, lissée : elle passe du travail à la prise sans à-coup. */
    private final float[] curls = new float[8];
    private final float[] solvedR = new float[4];
    private final float[] solvedL = new float[4];
    private int shown;
    private double lastT = -1;

    /* ------------------------------------------------------------------ outils */

    private static double ease(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    private static double seg(double t, double a, double b) {
        return Math.max(0, Math.min(1, (t - a) / (b - a)));
    }

    private static float damp(float cur, float target, double rate, double dt) {
        return (float) (target + (cur - target) * Math.exp(-rate * dt));
    }

    private static Vector3f damp(Vector3f cur, Vector3f target, double rate, double dt) {
        if (cur == null) return new Vector3f(target);
        float k = (float) (1 - Math.exp(-rate * dt));
        return cur.lerp(target, k, new Vector3f());
    }

    /** Hasard reproductible : le même dans le launcher. */
    static double hash(int n) {
        int h = n * 374761393 + 668265263;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) & 0xFFFFFFFFL) / 4294967296.0;
    }

    private static final Map<String, ResourceLocation> TEX = new HashMap<>();

    /** Une texture du mod, lue dans le jar (indépendante des packs de ressources en rechargement). */
    static ResourceLocation tex(String name) {
        return TEX.computeIfAbsent(name, n -> {
            ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/tex/" + n);
            try (InputStream in = Choreo.class.getResourceAsStream("/assets/opm/textures/entity/" + n + ".png")) {
                Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(NativeImage.read(in)));
            } catch (Exception e) {
                Opm.LOG.warn("Texture « {} » illisible", n);
            }
            return id;
        });
    }

    /* ------------------------------------------------------------ le dessin */

    private void begin(int w, int h) {
        aspect = w / (float) Math.max(1, h);
        double p = Math.toRadians(PITCH);
        Vector3f eye = new Vector3f(TARGET.x, TARGET.y + (float) (Math.sin(p) * DIST), (float) (Math.cos(p) * DIST));
        view = new Matrix4f().lookAt(eye, TARGET, new Vector3f(0, 1, 0));
        viewNormal = new Matrix3f(view);
        Matrix4f proj = new Matrix4f().perspective((float) Math.toRadians(FOV), aspect, 60f, 4000f);
        RenderSystem.backupProjectionMatrix();
        RenderSystem.setProjectionMatrix(proj, VertexSorting.DISTANCE_TO_ORIGIN);
        Matrix4fStack mv = RenderSystem.getModelViewStack();
        mv.pushMatrix();
        mv.identity();
        RenderSystem.applyModelViewMatrix();
        RenderSystem.enableDepthTest();
        RenderSystem.depthFunc(GL11.GL_LEQUAL);
        RenderSystem.depthMask(true);
        RenderSystem.clear(GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);
        RenderSystem.disableCull();
        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
    }

    private void end() {
        Matrix4fStack mv = RenderSystem.getModelViewStack();
        mv.popMatrix();
        RenderSystem.applyModelViewMatrix();
        RenderSystem.restoreProjectionMatrix();
        RenderSystem.enableCull();
        RenderSystem.depthMask(true);
        RenderSystem.defaultBlendFunc();
        RenderSystem.setShaderColor(1, 1, 1, 1);
        // L'interface 2D se dessine ensuite par-dessus.
        RenderSystem.clear(GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);
    }

    private PoseStack stack(Matrix4f world) {
        PoseStack ps = new PoseStack();
        ps.last().pose().set(view).mul(world);
        ps.last().normal().set(viewNormal).mul(new Matrix3f(world));
        return ps;
    }

    /** Un modèle : passe opaque ombrée, puis passe lumineuse additive. */
    private void draw(GeoModel m, GeoModel.Pose p, Matrix4f world, ResourceLocation tex, ResourceLocation glow,
                      float alpha, int rgb) {
        if (m == null || alpha <= 0.003f) return;
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        RenderSystem.setShader(GameRenderer::getPositionTexColorShader);
        RenderSystem.setShaderTexture(0, tex);
        RenderSystem.depthMask(alpha > 0.98f);
        BufferBuilder bb = Tesselator.getInstance().begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_TEX_COLOR);
        m.renderShaded(stack(world), bb, p, null, (a << 24) | (rgb & 0xFFFFFF));
        MeshData mesh = bb.build();
        if (mesh != null) BufferUploader.drawWithShader(mesh);
        RenderSystem.depthMask(true);
        if (glow != null) {
            RenderSystem.setShaderTexture(0, glow);
            RenderSystem.blendFunc(GlStateManager.SourceFactor.SRC_ALPHA, GlStateManager.DestFactor.ONE);
            RenderSystem.depthMask(false);
            bb = Tesselator.getInstance().begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_TEX_COLOR);
            m.render(stack(world), bb, p, null, 0, (a << 24) | 0xFFFFFF);
            mesh = bb.build();
            if (mesh != null) BufferUploader.drawWithShader(mesh);
            RenderSystem.depthMask(true);
            RenderSystem.defaultBlendFunc();
        }
    }

    private static Matrix4f at(Vector3f pos, float yawDeg) {
        return new Matrix4f().translate(pos).rotateY((float) Math.toRadians(yawDeg));
    }

    /* ------------------------------------------------------------ la scène */

    /**
     * @param t      horloge de la scène (secondes)
     * @param ratio  avancement du chargement, 0 → 1
     * @param outro  secondes depuis la fin du chargement (l'envol), ou négatif
     */
    public void render(int fbW, int fbH, double t, float ratio, String etat, double outro) {
        if (xen == null) return;
        double dt = lastT < 0 ? 0 : Math.max(0, Math.min(0.1, t - lastT));
        lastT = t;
        boolean corrupted = "corrompue".equals(etat);
        begin(fbW, fbH);
        try {
            float wv = VIEW * aspect;
            Vector3f S = new Vector3f(-0.30f * wv, 5 * PLAYER, 6);
            Vector3f H = new Vector3f(0, 22, -34);
            Vector3f W = new Vector3f(0, 72, -8);
            Vector3f P = new Vector3f(S.x + 50, 30, -14);

            int n = Skins.gallerySize();
            int k = (int) Math.floor(t / CYCLE);
            double c = t - k * CYCLE;
            Skins.Printed printed = n > 0 ? Skins.galleryAt(Math.floorMod(k, n)) : null;
            boolean active = printed != null && outro < 0;

            // --- Xenodys : où elle est, et comment elle vole.
            Vector3f B = baseAt(H, P, c, active);
            Vector3f ahead = baseAt(H, P, c + 0.05, active);
            Vector3f vel = new Vector3f(ahead).sub(B).div(0.05f);
            double travel = active ? Math.max(seg(c, 2.6, 3.2) * (1 - seg(c, 4.0, 4.4)), seg(c, 5.0, 5.5) * (1 - seg(c, 6.4, 7.0))) : 0;
            if (outro >= 0.35) {
                double o = outro - 0.35;
                B = new Vector3f(H).add(0, (float) (o * o * 90 + o * 15), 0);
                travel = 1;
            }
            float bob = (float) Math.sin(t * 1.3) * 1.5f;
            B.y += bob;
            float targetYaw = 180 + Math.max(-30, Math.min(30, vel.x * 0.6f));
            bodyYaw = damp(bodyYaw == 0 ? 180 : bodyYaw, targetYaw, 3, dt);
            float leanX = (float) Math.min(18, vel.length() * 0.35);
            float roll = Math.max(-16, Math.min(16, -vel.x * 0.25f));
            Matrix4f xenWorld = new Matrix4f().translate(B).rotateY((float) Math.toRadians(bodyYaw))
                    .rotateX((float) Math.toRadians(-leanX)).rotateZ((float) Math.toRadians(roll));

            GeoModel.Pose pose = xen.pose(corrupted ? "corrupted_idle" : "idle", (float) t);
            if (outro >= 0.35) {
                pose = xen.pose("fly", (float) t);
            } else if (travel > 0.01) {
                // En vol : les ailes battent, la jupe flotte derrière elle.
                float flap = (float) (Math.sin(t * 9) * 18 * travel);
                GeoModel.add(pose, "wing_left", new float[]{0, flap, 0}, null);
                GeoModel.add(pose, "wing_right", new float[]{0, -flap, 0}, null);
                GeoModel.add(pose, "skirt_front", new float[]{(float) (-20 * travel), 0, 0}, null);
            }

            // --- L'orbe du joueur imprimé.
            Vector3f orb = null;
            boolean held = false;
            float orbScale = 0;
            if (active) {
                Vector3f chest = new Vector3f(S).add(0, 20 * PLAYER, 0);
                Vector3f high = new Vector3f(S).add(0, 40 * PLAYER, 0);
                if (c >= 2.2 && c < 4.8) {
                    orbScale = (float) ease(seg(c, 2.2, 3.0));
                    orb = new Vector3f(chest).lerp(high, (float) ease(seg(c, 3.0, 3.6)));
                    orb.y += (float) Math.sin(t * 3) * 0.8f;
                } else if (c >= 4.8 && c < 8.0) {
                    held = true;
                    orbScale = (float) (1 - ease(seg(c, 7.6, 8.0)));
                }
            }

            // --- Ses mains : ce qu'elles visent.
            double ph = t * 2.4;
            Vector3f shapeR = new Vector3f(W).add((float) (-15 + 3 * Math.cos(ph)), (float) (2 + 3 * Math.sin(ph)), 5);
            Vector3f shapeL = new Vector3f(W).add((float) (15 + 3 * Math.cos(ph + Math.PI)), (float) (2 + 3 * Math.sin(ph + Math.PI)), 5);
            Vector3f wantR = shapeR;
            Vector3f wantL = shapeL;
            boolean ik = outro < 0.35;
            if (active) {
                if (c >= 3.6 && c < 4.8 && orb != null) {
                    wantR = new Vector3f(orb).add(0, 2, 2);
                    wantL = new Vector3f(B).add(16, 44, 12);
                } else if (c >= 4.8 && c < 7.0) {
                    wantR = new Vector3f(B).add(-8, 52, 18);
                    wantL = new Vector3f(B).add(16, 44, 12);
                } else if (c >= 7.0 && c < 8.0) {
                    wantR = new Vector3f(W).add(0, 8, 6);
                } else if (c >= 2.6 && c < 3.6) {
                    wantR = new Vector3f(B).add(-14, 44, 14);
                    wantL = new Vector3f(B).add(16, 44, 12);
                }
            }
            handTargetR = damp(handTargetR, wantR, 5, dt);
            handTargetL = damp(handTargetL, wantL, 5, dt);

            // Doigts : en griffe quand elle tient l'orbe, au travail sinon.
            for (int f = 0; f < 4; f++) {
                float work = (float) (22 * Math.max(0, Math.sin(ph * 2 + f)));
                curls[f] = damp(curls[f], held ? 55 : (active && c >= 3.6 && c < 4.8 ? -12 : work), 8, dt);
                curls[f + 4] = damp(curls[f + 4], (float) (22 * Math.max(0, Math.sin(ph * 2 + f + 2))), 8, dt);
                float curlR = curls[f];
                float curlL = curls[f + 4];
                GeoModel.add(pose, "finger_right_" + f, new float[]{curlR, 0, 0}, null);
                GeoModel.add(pose, "finger_right_" + f + "_tip", new float[]{curlR * 0.8f, 0, 0}, null);
                GeoModel.add(pose, "finger_left_" + f, new float[]{curlL, 0, 0}, null);
                GeoModel.add(pose, "finger_left_" + f + "_tip", new float[]{curlL * 0.8f, 0, 0}, null);
            }

            // --- Ce qu'elle regarde.
            Vector3f look = new Vector3f(W);
            if (active) {
                if (c < 2.6) look = new Vector3f(S).add(0, 28 * PLAYER, 0);
                else if (c < 4.8 && orb != null) look = orb;
                else if (c < 7.0) look = new Vector3f(W);
            }
            Vector3f headWorld = xenWorld.transformPosition(xen.point(pose, "head"), new Vector3f());
            Matrix4f inv = new Matrix4f(xenWorld).invert();
            Vector3f d = inv.transformDirection(new Vector3f(look).sub(headWorld), new Vector3f());
            float wantYaw = (float) Math.max(-60, Math.min(60, Math.toDegrees(Math.atan2(d.x, -d.z))));
            float wantPitch = (float) Math.max(-35, Math.min(45, Math.toDegrees(Math.atan2(-d.y, Math.hypot(d.x, d.z)))));
            headYaw = damp(headYaw, outro >= 0.35 ? 0 : wantYaw, 4, dt);
            headPitch = damp(headPitch, outro >= 0.35 ? -20 : wantPitch, 4, dt);
            GeoModel.add(pose, "head", new float[]{headPitch * 0.7f, headYaw * 0.7f, 0}, null);
            GeoModel.add(pose, "neck", new float[]{headPitch * 0.3f, headYaw * 0.3f, 0}, null);

            if (ik) {
                // La solution de l'IK, puis le bras qui la rejoint en douceur : jamais
                // de saut d'une image à l'autre, même quand la cible change.
                solve(pose, xenWorld, "right", handTargetR, solvedR);
                solve(pose, xenWorld, "left", handTargetL, solvedL);
                for (int i = 0; i < 4; i++) {
                    armR[i] = damp(armR[i], solvedR[i], 10, dt);
                    armL[i] = damp(armL[i], solvedL[i], 10, dt);
                }
                apply(pose, "right", armR);
                apply(pose, "left", armL);
            }

            String xt = "xenodys_" + etat + (Xen.blinking(t, 5) ? "_blink" : "");
            draw(xen, pose, xenWorld, tex(xt), tex(xt + "_glowmask"), 1f, 0xFFFFFF);
            // Xenodys reste toujours DERRIÈRE les autres modèles (monde, circuit,
            // joueurs, assistants, orbe), où qu'elle vole.
            RenderSystem.clear(GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);

            // --- Le monde : un cube de blocs qui se construit.
            int inserted = active || n > 0 ? Math.min(8, k + (c >= 8.0 ? 1 : 0)) : 0;
            int target = outro >= 0 ? N * N * N : Math.min(N * N * N, (int) Math.floor(Math.max(0, Math.min(1, ratio)) * 56) + inserted);
            while (shown < target) shownAt[shown++] = (float) t;
            Matrix4f worldRot = new Matrix4f().translate(W).rotateX((float) Math.toRadians(15)).rotateY((float) (t * 0.3));
            int drawn = 0;
            for (int kk = 0; kk < N && drawn < shown; kk++) {
                for (int s = 0; s <= 2 * (N - 1) && drawn < shown; s++) {
                    for (int i = 0; i < N && drawn < shown; i++) {
                        int j = s - i;
                        if (j < 0 || j >= N) continue;
                        float fresh = (float) Math.max(0, 1 - (t - shownAt[drawn]) / 0.5);
                        float pop = 1 + fresh * 0.35f;
                        Matrix4f m = new Matrix4f(worldRot).translate((i - 1.5f) * BLOCK, (kk - 1.5f) * BLOCK, (j - 1.5f) * BLOCK)
                                .scale(BLOCK / 16f * pop);
                        draw(block, block.pose(null, 0), m, tex("bloc_" + etat), tex("bloc_" + etat + "_glowmask"), 1f,
                                fresh > 0 ? 0xFFFFFF : 0xFFFFFF);
                        drawn++;
                    }
                }
            }

            // --- Le circuit et le joueur imprimé.
            draw(socle, socle.pose(null, 0), at(S, 210).scale(PLAYER), tex("socle_" + etat), tex("socle_" + etat + "_glowmask"), 1f, 0xFFFFFF);
            Skins.Printed shownPlayer = null;
            float playerAlpha = 0;
            double reveal = 0;
            if (outro >= 0.4 && Skins.own() != null) {
                shownPlayer = Skins.own();
                reveal = ease((outro - 0.4) / 1.6);
                playerAlpha = (float) reveal;
            } else if (active && c < 3.0) {
                shownPlayer = printed;
                reveal = ease(c / 1.8);
                playerAlpha = (float) reveal;
            }
            // L'aspiration : le joueur tourne, s'étire et se resserre jusqu'à son orbe.
            double suck = active && outro < 0 ? ease(seg(c, 2.3, 3.0)) : 0;
            if (shownPlayer != null && playerAlpha > 0.01f && suck < 0.99) {
                GeoModel model = shownPlayer.slim() ? playerSlim : player;
                float thin = (float) (1 - 0.94 * suck);
                float stretch = (float) (1 + 1.3 * Math.sin(suck * Math.PI));
                Matrix4f pm = new Matrix4f().translate(S.x, S.y + (float) (suck * 16 * PLAYER), S.z)
                        .rotateY((float) Math.toRadians(210 + suck * 540))
                        .scale(PLAYER * thin, PLAYER * thin * stretch, PLAYER * thin);
                draw(model, playerPose(model, t, false), pm, shownPlayer.texture(), null, playerAlpha, 0xFFFFFF);
                if (reveal < 1) {
                    // Le balayage de l'imprimante, qui monte.
                    Matrix4f scan = new Matrix4f().translate(S.x, S.y + (float) (33 * PLAYER * reveal), S.z).rotateY((float) Math.toRadians(210))
                            .scale(22 * PLAYER / 16f, 0.4f / 16f, 22 * PLAYER / 16f);
                    draw(block, block.pose(null, 0), scan, tex("bloc_" + etat + "_glowmask"), tex("bloc_" + etat + "_glowmask"), 0.8f, 0xFFFFFF);
                }
            }

            // --- L'orbe (à terre, aspirée dans sa paume, puis dans le monde).
            Vector3f palm = xenWorld.transformPosition(xen.point(pose, "hand_right"), new Vector3f()).add(0, -5, 3);
            if (active && c >= 4.4 && c < 4.8 && orb != null) {
                orb = new Vector3f(orb).lerp(palm, (float) ease(seg(c, 4.4, 4.8)));
            }
            if (held) {
                orb = new Vector3f(palm);
                if (c >= 7.3) {
                    // Aspirée par le monde : une spirale qui se resserre.
                    double e = ease(seg(c, 7.3, 8.0));
                    Vector3f into = new Vector3f(W).add(0, 3, 0);
                    orb.lerp(into, (float) e);
                    float r = (float) (12 * (1 - e));
                    orb.add((float) (Math.cos(e * 4 * Math.PI) * r), 0, (float) (Math.sin(e * 4 * Math.PI) * r));
                }
            }
            // Le flot de lumière du joueur vers son orbe.
            if (active && c >= 2.2 && c < 3.2) {
                Vector3f chest = new Vector3f(S).add(0, 20 * PLAYER, 0);
                for (int i = 0; i < 14; i++) {
                    double q = ease(seg(c, 2.2 + i * 0.035, 2.75 + i * 0.035));
                    if (q <= 0 || q >= 1) continue;
                    Vector3f from = new Vector3f(S).add((float) ((hash(i + k * 31) - 0.5) * 14 * PLAYER),
                            (float) ((0.1 + hash(i * 3 + k * 17) * 0.85) * 32 * PLAYER), (float) ((hash(i * 5 + k) - 0.5) * 8));
                    Vector3f p2 = new Vector3f(from).lerp(chest, (float) q);
                    float sw = (float) Math.sin(q * Math.PI) * 6;
                    p2.add((float) Math.cos(i + q * 8) * sw, 0, (float) Math.sin(i + q * 8) * sw);
                    Matrix4f m = new Matrix4f().translate(p2).rotateY((float) (t * 3 + i)).scale(1.4f / 16f * (float) (1 - q * 0.6));
                    draw(block, block.pose(null, 0), m, tex("orbe_" + etat), tex("orbe_" + etat + "_glowmask"), 1f, 0xFFFFFF);
                }
            }
            if (orb != null && orbScale > 0.01f) {
                float pulse = 1 + (float) Math.sin(t * 6) * 0.08f;
                // Étirée dans le sens de l'aspiration quand le monde l'avale.
                float squash = active && c >= 7.3 ? (float) (1 + Math.sin(seg(c, 7.3, 8.0) * Math.PI) * 0.8) : 1f;
                Matrix4f m = new Matrix4f().translate(orb).rotateY((float) (t * 2)).rotateX((float) (t * 1.3))
                        .scale(6f / 16f * orbScale * pulse, 6f / 16f * orbScale * pulse * squash, 6f / 16f * orbScale * pulse);
                // Un cœur lumineux : le bloc, éclairci à la couleur de l'état, et sa lueur.
                draw(block, block.pose(null, 0), m, tex("orbe_" + etat), tex("orbe_" + etat + "_glowmask"), 1f, 0xFFFFFF);
                Matrix4f halo = new Matrix4f(m).scale(1.6f);
                draw(block, block.pose(null, 0), halo, tex("orbe_" + etat), null, 0.25f, 0xFFFFFF);
            }

            // --- Les assistants.
            drawBots(t, etat, wv, S, outro);
        } catch (Exception e) {
            Opm.LOG.debug("Scène 3D : {}", e.toString());
        } finally {
            end();
        }
    }

    /** La position de Xenodys : chez elle, ou en route vers l'orbe et retour. */
    private static Vector3f baseAt(Vector3f H, Vector3f P, double c, boolean active) {
        if (!active) return new Vector3f(H);
        if (c < 2.6 || c >= 7.0) return new Vector3f(H);
        if (c < 4.4) return new Vector3f(H).lerp(P, (float) ease(seg(c, 2.6, 4.4)));
        if (c < 5.0) return new Vector3f(P);
        return new Vector3f(P).lerp(H, (float) ease(seg(c, 5.0, 7.0)));
    }

    /* ---------------------------------------------------- les bras (IK) */

    private static void apply(GeoModel.Pose p, String side, float[] a) {
        GeoModel.add(p, "arm_" + side, new float[]{a[0], a[1], a[2]}, null);
        GeoModel.add(p, "forearm_" + side, new float[]{a[3], 0, 0}, null);
    }

    private float error(GeoModel.Pose base, Matrix4f world, String side, Vector3f target, float[] a) {
        GeoModel.Pose p = base.copy();
        apply(p, side, a);
        Vector3f hand = world.transformPosition(xen.point(p, "hand_" + side), new Vector3f());
        return hand.distanceSquared(target) + 0.004f * (a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
    }

    /**
     * L'épaule (3 axes) et le coude d'un bras, pour que la main atteigne sa cible :
     * une descente coordonnée, repartie de la solution de l'image précédente — le
     * bras glisse d'une pose à l'autre, sans saut.
     */
    private void solve(GeoModel.Pose base, Matrix4f world, String side, Vector3f target, float[] state) {
        float[] best = state.clone();
        float bestE = error(base, world, side, target, best);
        float step = 10;
        for (int it = 0; it < 6; it++) {
            for (int i = 0; i < 4; i++) {
                for (int sign = -1; sign <= 1; sign += 2) {
                    float[] cand = best.clone();
                    cand[i] = Math.max(-150, Math.min(150, cand[i] + sign * step));
                    if (i == 3) cand[3] = Math.max(-140, Math.min(10, cand[3]));
                    float e = error(base, world, side, target, cand);
                    if (e < bestE) {
                        bestE = e;
                        best = cand;
                    }
                }
            }
            step *= 0.6f;
        }
        System.arraycopy(best, 0, state, 0, 4);
    }

    /* ------------------------------------------------- joueurs, assistants */

    /** Un joueur au repos : il respire, ses bras se balancent, sa tête regarde autour de lui. */
    static GeoModel.Pose playerPose(GeoModel m, double t, boolean fear) {
        GeoModel.Pose p = m.pose(null, 0);
        double ph = t * 2 * Math.PI / 2.7;
        if (fear) {
            double shake = Math.sin(t * 21) * 2.5;
            GeoModel.add(p, "head", new float[]{(float) (14 - shake * 0.5), (float) (8 * Math.sin(t * 1.5) + shake), 0}, null);
            GeoModel.add(p, "right_arm", new float[]{(float) (-105 - 6 * Math.sin(t * 2.2) - shake), 0, 18}, null);
            GeoModel.add(p, "left_arm", new float[]{(float) (-95 + 6 * Math.sin(t * 2.2) + shake), 0, -18}, null);
            return p;
        }
        GeoModel.add(p, "head", new float[]{(float) (4 - 3 * Math.sin(ph * 2)), (float) (14 * Math.sin(ph)), 0}, null);
        GeoModel.add(p, "right_arm", new float[]{(float) (-5 * Math.sin(ph)), 0, (float) (3 + 2 * Math.sin(ph * 2))}, null);
        GeoModel.add(p, "left_arm", new float[]{(float) (5 * Math.sin(ph)), 0, (float) (-3 - 2 * Math.sin(ph * 2))}, null);
        GeoModel.add(p, "body", null, new float[]{0, (float) (Math.sin(ph * 2) * 0.35), 0});
        return p;
    }

    private void drawBots(double t, String etat, float wv, Vector3f S, double outro) {
        if (bot == null) return;
        ResourceLocation bt = tex("xenodys_assistant_" + etat);
        ResourceLocation bg = tex("xenodys_assistant_" + etat + "_glowmask");
        double ph = t * 2 * Math.PI;

        // L'assistant du circuit : il travaille (et salue l'envol).
        GeoModel.Pose work = bot.pose("idle", (float) t);
        if (outro >= 0.3) {
            work = bot.pose("wave", (float) ((outro - 0.3) % 2.4));
        } else {
            GeoModel.add(work, "arm_left", new float[]{(float) (-80 + 25 * Math.sin(ph * 0.9)), 0, -10}, null);
            GeoModel.add(work, "arm_right", new float[]{(float) (-80 + 25 * Math.sin(ph * 0.9 + Math.PI)), 0, 10}, null);
            GeoModel.add(work, "head", new float[]{10, 0, 0}, null);
        }
        draw(bot, work, at(new Vector3f(S.x - 36, 0, 16), -90).scale(BOT), bt, bg, 1f, 0xFFFFFF);

        // L'assistant qui fait sa ronde : il arrive par la droite, et trébuche parfois.
        Walker w = walker(t, wv);
        GeoModel.Pose wp = bot.pose("idle", (float) t);
        float rootX = 0;
        if (w.fall >= 0) {
            double f = w.fall;
            double fallK = f < 0.6 ? ease(f / 0.6) : f < 1.4 ? 1 : 1 - ease((f - 1.4) / 0.9);
            rootX = (float) (-88 * fallK);
            GeoModel.add(wp, "arm_left", new float[]{(float) (-140 * fallK), 0, -20}, null);
            GeoModel.add(wp, "arm_right", new float[]{(float) (-140 * fallK), 0, 20}, null);
        } else {
            double s = Math.sin(w.walk * 2 * Math.PI * 1.2);
            GeoModel.add(wp, "leg_left", new float[]{(float) (35 * s), 0, 0}, null);
            GeoModel.add(wp, "leg_right", new float[]{(float) (-35 * s), 0, 0}, null);
            GeoModel.add(wp, "arm_left", new float[]{(float) (-30 * s), 0, 0}, null);
            GeoModel.add(wp, "arm_right", new float[]{(float) (30 * s), 0, 0}, null);
            GeoModel.add(wp, "body", null, new float[]{0, (float) Math.abs(s) * 0.8f, 0});
        }
        Matrix4f m = at(new Vector3f(w.x, 0, 18), w.dir > 0 ? -90 : 90).rotateX((float) Math.toRadians(rootX)).scale(BOT);
        draw(bot, wp, m, bt, bg, 1f, 0xFFFFFF);
    }

    record Walker(float x, int dir, double walk, double fall) {}

    /** La ronde de l'assistant, déduite de l'horloge seule (la même dans le launcher). */
    static Walker walker(double t, float wv) {
        double window = 9;
        int idx = (int) Math.floor(t / window);
        double paused = 0;
        for (int i = 0; i < idx; i++) if (hash(i * 7 + 3) < 0.45) paused += 2.3;
        double local = t - idx * window;
        double fall = -1;
        if (hash(idx * 7 + 3) < 0.45) {
            if (local >= 3 && local < 5.3) fall = local - 3;
            if (local >= 5.3) paused += 2.3;
            else if (local >= 3) paused += local - 3;
        }
        double walk = t - paused;
        double speed = 14;
        double xEnter = 0.62 * wv;
        double xb = 0.40 * wv;
        double xa = 0.16 * wv;
        double enterTime = (xEnter - xb) / 26;
        float x;
        int dir;
        if (walk < enterTime) {
            x = (float) (xEnter - walk * 26);
            dir = -1;
        } else {
            double span = xb - xa;
            double q = ((walk - enterTime) * speed) % (2 * span);
            if (q < span) {
                x = (float) (xb - q);
                dir = -1;
            } else {
                x = (float) (xa + (q - span));
                dir = 1;
            }
        }
        return new Walker(x, dir, walk, fall);
    }
}
