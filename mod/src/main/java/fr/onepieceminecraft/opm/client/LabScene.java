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
import com.mojang.blaze3d.vertex.VertexBuffer;
import com.mojang.blaze3d.vertex.VertexFormat;
import com.mojang.blaze3d.vertex.VertexSorting;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
 * Le laboratoire de Xenodys, en 3D, à la résolution de l'écran : l'écran de
 * chargement, l'écran titre, le fond des menus.
 *
 * <p>Pendant le chargement, la salle s'assemble bloc par bloc autour de la
 * plateforme ; un joueur flotte dans la grande cuve, dont le liquide monte avec
 * l'avancement ; Xenodys va d'un poste à l'autre — elle règle le réacteur,
 * construit avec des blocs, manipule l'hologramme, observe ses cuves. Le
 * chargement fini, la cuve descend dans la plateforme et la caméra glisse vers
 * le menu : c'est la même salle, il n'y a pas de coupure.
 *
 * <p>La chorégraphie se déduit de l'horloge de la scène (partagée avec le
 * launcher), le hasard est reproductible. Dessin : le shader
 * {@code position_tex_color}, le seul de la 3D disponible pendant le chargement.
 */
public final class LabScene {
    /** Durée d'un poste de Xenodys, trajet compris. */
    static final double SLOT = 11;
    private static final double TRAVEL = 2.2;
    private static final double DROP = 0.65;
    private static final int CHUNK = 64;
    /** Xenodys, les joueurs, les assistants : blocs par unité de modèle. */
    private static final float XS = 1.9f / 16;
    private static final float PS = 1.22f / 16;
    private static final float BOT = 1.3f / 16;
    private static final float CX = 15.5f;
    private static final float CZ = 12.5f;
    private static final float TOP = 3f;
    private static final float TANK_FLOOR = 3.72f;
    private static final float TANK_TOP = 6.75f;

    enum Post { HOME, TANK, REACTOR, BUILD, HOLO, SPECIMEN }

    private static final Post[] LOADING = {Post.TANK, Post.REACTOR, Post.BUILD, Post.HOLO, Post.TANK, Post.BUILD, Post.SPECIMEN};
    private static final Post[] MENU = {Post.HOME, Post.BUILD, Post.HOME, Post.HOLO, Post.HOME, Post.SPECIMEN};

    /** Ce que l'écran demande à la scène. */
    public static final class View {
        public float ratio = 1;
        public String etat = "creatrice";
        /** 0 : caméra du chargement ; 1 : caméra du menu. */
        public float menu;
        /** 0 : cuve en place ; 1 : cuve descendue dans la plateforme. */
        public float tankDown;
        /** Avancement de la vidange (0 → 1). */
        public float drain;
        /** Point de l'écran qu'elle regarde (−1 … 1), ou NaN. */
        public float lookX = Float.NaN;
        public float lookY = Float.NaN;
        /** Secondes depuis qu'elle salue, ou négatif. */
        public double greet = -1;
        /** Le départ : 0 → 1, le joueur se défait en lumière. */
        public float leave;
        public boolean waiting;
        public boolean away;
        /** Au menu, elle suit son programme de menu (elle reste près du joueur entre deux tâches). */
        public boolean inMenu;
        /** Assembler la salle au fil de `ratio` ; sinon elle est entière. */
        public boolean assemble;
    }

    private static final class Chunk {
        final int from;
        final int to;
        /** Par état (créatrice, corrompue), puis par couche. */
        final VertexBuffer[][] vb = new VertexBuffer[2][];

        Chunk(int from, int to) {
            this.from = from;
            this.to = to;
        }
    }

    private static LabScene instance;

    public static LabScene get() {
        if (instance == null) instance = new LabScene();
        return instance;
    }

    private final LabData data = LabData.get();
    private final Rig xen = Xen.model();
    private final Rig graine = Rig.assistant("graine");
    private final Rig luciole = Rig.assistant("luciole");
    private final Rig fileuse = Rig.assistant("fileuse");
    private final GeoModel player = GeoModel.load("joueur", null);
    private final GeoModel playerSlim = GeoModel.load("joueur_fin", null);
    private final List<Chunk> chunks = new ArrayList<>();
    /** L'état d'avant, et l'instant de la bascule : elle court depuis la plateforme, bloc après bloc. */
    private boolean before;
    private double switchedAt = -10;
    private final double[] shownAt;
    private int shown;
    private int tankIndex = -1;

    private Matrix4f view = new Matrix4f();
    private Matrix3f viewNormal = new Matrix3f();
    private Matrix4f proj = new Matrix4f();
    private Vector3f eye = new Vector3f();
    private boolean corrupted;
    private String etat = "creatrice";
    private double t;

    // État lissé de Xenodys.
    private double lastT = -1;
    private Vector3f handR;
    private Vector3f handL;
    private final float[] armR = new float[4];
    private final float[] armL = new float[4];
    private final float[] solvedR = new float[4];
    private final float[] solvedL = new float[4];
    private final float[] curls = new float[8];
    private float headYaw;
    private float headPitch;
    private float bodyYaw = 180;
    private float armWeight;
    private float level = TANK_FLOOR;

    /** Développement : une salle neuve, à assembler. */
    static void reset() {
        instance = null;
    }

    private static final long FALLBACK = System.currentTimeMillis();

    private static double smooth = -1;
    private static long smoothAt;

    /**
     * L'horloge de la scène (secondes) : celle du launcher, quand il l'a transmise.
     * Une image qui tarde (le jeu charge) ne fait pas sauter la scène : elle reprend
     * là où elle en était, puis rattrape son retard en douceur.
     */
    public static double clock() {
        long epoch = OpmSession.get().sceneStart > 0 ? OpmSession.get().sceneStart : FALLBACK;
        double real = (System.currentTimeMillis() - epoch) / 1000.0;
        long now = System.nanoTime();
        if (smooth < 0) {
            smooth = real;
        } else {
            double dt = Math.min(0.05, (now - smoothAt) / 1e9);
            smooth += dt * (1 + Math.max(-0.1, Math.min(0.1, (real - smooth) * 0.1)));
        }
        smoothAt = now;
        return smooth;
    }

    private LabScene() {
        int n = data != null ? data.entries.size() : 0;
        shownAt = new double[n];
        java.util.Arrays.fill(shownAt, Double.NaN);
        for (int i = 0; i < n; i += CHUNK) chunks.add(new Chunk(i, Math.min(n, i + CHUNK)));
        for (int i = 0; i < n; i++) if ("cuve".equals(data.entries.get(i).post())) tankIndex = i;
    }

    /* ------------------------------------------------------------------ outils */

    static double ease(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    static double seg(double t, double a, double b) {
        return Math.max(0, Math.min(1, (t - a) / (b - a)));
    }

    private static float damp(float cur, float target, double rate, double dt) {
        return (float) (target + (cur - target) * Math.exp(-rate * dt));
    }

    private static Vector3f damp(Vector3f cur, Vector3f target, double rate, double dt) {
        if (cur == null) return new Vector3f(target);
        return cur.lerp(target, (float) (1 - Math.exp(-rate * dt)), new Vector3f());
    }

    /** Hasard reproductible : le même dans le launcher. */
    static double hash(int n) {
        int h = n * 374761393 + 668265263;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) & 0xFFFFFFFFL) / 4294967296.0;
    }

    private static final Map<String, ResourceLocation> TEX = new HashMap<>();

    /** Une texture du paquet (indépendante des packs de ressources en rechargement). */
    static ResourceLocation tex(String name) {
        return TEX.computeIfAbsent(name, n -> {
            ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/tex/" + n);
            try (InputStream in = Pack.open("entity/" + n + ".png")) {
                Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(NativeImage.read(in)));
            } catch (Exception e) {
                Opm.LOG.warn("Texture « {} » illisible", n);
            }
            return id;
        });
    }

    private static ResourceLocation white;

    private static ResourceLocation white() {
        if (white == null) {
            white = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/blanc");
            NativeImage img = new NativeImage(1, 1, false);
            img.setPixelRGBA(0, 0, -1);
            Minecraft.getInstance().getTextureManager().register(white, new DynamicTexture(img));
        }
        return white;
    }

    private int accent() {
        return corrupted ? 0xF0506E : 0x7FE9DC;
    }

    private int core() {
        return corrupted ? 0xFFD3DD : 0xEFFFFC;
    }

    private static Vector3f v(double x, double y, double z) {
        return new Vector3f((float) x, (float) y, (float) z);
    }

    /* ------------------------------------------------------------ le dessin */

    private void begin(int w, int h, float menu) {
        float aspect = w / (float) Math.max(1, h);
        float k = (float) ease(menu);
        eye = v(CX - 3.2 * k, 5.6 - 0.3 * k, 25.4 + 0.2 * k);
        Vector3f target = v(CX - 2.7 * k, 6.0 + 0.2 * k, 0);
        view = new Matrix4f().lookAt(eye, target, new Vector3f(0, 1, 0));
        viewNormal = new Matrix3f(view);
        // Au menu, l'image se décale vers la droite : le cadre prend la gauche.
        float shift = 0.17f * k * Math.min(1, aspect / 1.6f);
        proj = new Matrix4f().translation(shift, 0, 0).perspective((float) Math.toRadians(56), aspect, 0.4f, 70f);
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
        RenderSystem.setShaderColor(1, 1, 1, 1);
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
        RenderSystem.clear(GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);
    }

    private static BufferBuilder quads() {
        return Tesselator.getInstance().begin(VertexFormat.Mode.QUADS, DefaultVertexFormat.POSITION_TEX_COLOR);
    }

    private static void flush(BufferBuilder bb) {
        MeshData mesh = bb.build();
        if (mesh != null) BufferUploader.drawWithShader(mesh);
    }

    private static void texture(ResourceLocation id) {
        RenderSystem.setShader(GameRenderer::getPositionTexColorShader);
        RenderSystem.setShaderTexture(0, id);
    }

    private static void additive(boolean on) {
        if (on) RenderSystem.blendFunc(GlStateManager.SourceFactor.SRC_ALPHA, GlStateManager.DestFactor.ONE);
        else RenderSystem.defaultBlendFunc();
        RenderSystem.depthMask(!on);
    }

    private PoseStack stack(Matrix4f world) {
        PoseStack ps = new PoseStack();
        ps.last().pose().set(view).mul(world);
        Matrix3f n = new Matrix3f(world);
        ps.last().normal().set(viewNormal).mul(n);
        return ps;
    }

    private void model(GeoModel m, GeoModel.Pose p, Matrix4f world, ResourceLocation tex, ResourceLocation glow, float alpha,
                       int rgb) {
        if (m == null || alpha <= 0.003f) return;
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        texture(tex);
        RenderSystem.depthMask(alpha > 0.98f);
        BufferBuilder bb = quads();
        m.renderShaded(stack(world), bb, p, null, (a << 24) | (rgb & 0xFFFFFF));
        flush(bb);
        RenderSystem.depthMask(true);
        if (glow != null) {
            RenderSystem.setShaderTexture(0, glow);
            additive(true);
            bb = quads();
            m.render(stack(world), bb, p, null, 0, (a << 24) | 0xFFFFFF);
            flush(bb);
            additive(false);
        }
    }

    /** Xenodys ou un assistant, en couches : la matière, ses lueurs, le verre et l'énergie. */
    private void rig(Rig m, Rig.Pose p, Matrix4f world, Rig.Options options, int rgb) {
        m.solve(p, new Matrix4f(view).mul(world), options);
        ResourceLocation tex = Xen.texture(m.id(), etat, false);
        texture(tex);
        RenderSystem.depthMask(true);
        BufferBuilder bb = quads();
        m.emitFlat(bb, Rig.Layer.BASE, true, rgb, 1);
        flush(bb);
        RenderSystem.setShaderTexture(0, Xen.texture(m.id(), etat, true));
        additive(true);
        bb = quads();
        m.emitFlat(bb, Rig.Layer.GLOW, false, 0xFFFFFF, 1);
        flush(bb);
        additive(false);
        RenderSystem.setShaderTexture(0, tex);
        RenderSystem.depthMask(false);
        bb = quads();
        m.emitFlat(bb, Rig.Layer.GLASS, true, rgb, 1);
        m.emitFlat(bb, Rig.Layer.ENERGY, false, 0xFFFFFF, 1);
        flush(bb);
        RenderSystem.depthMask(true);
    }

    /** Un rectangle libre, texturé en blanc. */
    private void rect(BufferBuilder bb, Vector3f a, Vector3f b, Vector3f c, Vector3f d, int rgb, double alpha) {
        int col = ((int) Math.round(Math.max(0, Math.min(1, alpha)) * 255) << 24) | (rgb & 0xFFFFFF);
        for (Vector3f p : new Vector3f[]{a, b, c, d}) {
            Vector3f q = view.transformPosition(p, new Vector3f());
            bb.addVertex(q.x, q.y, q.z).setUv(0.5f, 0.5f).setColor(col);
        }
    }

    /** Un petit cube de lumière. */
    private void spark(BufferBuilder bb, Vector3f p, float size, int rgb, double alpha) {
        Vector3f q = view.transformPosition(p, new Vector3f());
        int col = ((int) Math.round(Math.max(0, Math.min(1, alpha)) * 255) << 24) | (rgb & 0xFFFFFF);
        float s = size / 2;
        bb.addVertex(q.x - s, q.y + s, q.z).setUv(0.5f, 0.5f).setColor(col);
        bb.addVertex(q.x - s, q.y - s, q.z).setUv(0.5f, 0.5f).setColor(col);
        bb.addVertex(q.x + s, q.y - s, q.z).setUv(0.5f, 0.5f).setColor(col);
        bb.addVertex(q.x + s, q.y + s, q.z).setUv(0.5f, 0.5f).setColor(col);
    }

    /** Un rayon de gros pixels, qui court de `from` à `to`. */
    private void beam(BufferBuilder bb, Vector3f from, Vector3f to, float size, double alpha, int seed) {
        float len = from.distance(to);
        size *= 1.35f;
        int n = Math.max(2, (int) (len / (size * 1.15f)));
        for (int i = 0; i <= n; i++) {
            float k = i / (float) n;
            Vector3f p = new Vector3f(from).lerp(to, k);
            double sway = Math.sin(k * Math.PI) * 0.12;
            p.add((float) (Math.sin(t * 9 + i * 0.9 + seed) * sway), (float) (Math.cos(t * 7 + i * 1.3 + seed) * sway), 0);
            double run = (k * 6 - t * 3.2 + seed * 0.37) % 1;
            if (run < 0) run += 1;
            spark(bb, p, size, run < 0.25 ? core() : accent(), alpha * (run < 0.25 ? 1 : 0.55));
        }
    }

    /** Un bloc de la scène (construction) : ses six faces, texture de l'atlas. */
    private void block(BufferBuilder base, BufferBuilder glow, Matrix4f world, String side, String top) {
        for (int f = 0; f < 6; f++) {
            String tile = f < 2 ? top : side;
            int[] c = data.cell(tile);
            float u0 = c[0] / (float) data.atlasW;
            float v0 = c[1] / (float) data.atlasH;
            float u1 = (c[0] + 16) / (float) data.atlasW;
            float v1 = (c[1] + 16) / (float) data.atlasH;
            Vector3f[] p = FACE[f];
            float shade = f == 0 ? 1f : f == 1 ? 0.45f : f == 2 ? 0.92f : f == 3 ? 0.6f : 0.75f;
            int s = Math.round(255 * (corrupted ? shade * 0.85f : shade));
            float[][] uv = {{u0, v0}, {u0, v1}, {u1, v1}, {u1, v0}};
            for (int pass = 0; pass < (data.glows(tile) && glow != null ? 2 : 1); pass++) {
                BufferBuilder bb = pass == 0 ? base : glow;
                for (int i = 0; i < 4; i++) {
                    Vector3f q = new Vector3f(p[i]);
                    if (pass == 1) q.mul(1.004f);
                    world.transformPosition(q);
                    view.transformPosition(q);
                    if (pass == 0) bb.addVertex(q.x, q.y, q.z).setUv(uv[i][0], uv[i][1]).setColor(s, s, s, 255);
                    else bb.addVertex(q.x, q.y, q.z).setUv(uv[i][0], uv[i][1]).setColor(-1);
                }
            }
        }
    }

    private static final Vector3f[][] FACE = {
            {v(-.5, .5, -.5), v(-.5, .5, .5), v(.5, .5, .5), v(.5, .5, -.5)},
            {v(-.5, -.5, .5), v(-.5, -.5, -.5), v(.5, -.5, -.5), v(.5, -.5, .5)},
            {v(-.5, .5, .5), v(-.5, -.5, .5), v(.5, -.5, .5), v(.5, .5, .5)},
            {v(.5, .5, -.5), v(.5, -.5, -.5), v(-.5, -.5, -.5), v(-.5, .5, -.5)},
            {v(-.5, .5, -.5), v(-.5, -.5, -.5), v(-.5, -.5, .5), v(-.5, .5, .5)},
            {v(.5, .5, .5), v(.5, -.5, .5), v(.5, -.5, -.5), v(.5, .5, -.5)},
    };

    /* ------------------------------------------------------------ la scène */

    public boolean ready() {
        return data != null && xen != null;
    }

    public void render(int fbW, int fbH, double time, View s) {
        if (!ready()) return;
        long began = System.nanoTime();
        double dt = lastT < 0 ? 0 : Math.max(0, Math.min(0.1, time - lastT));
        lastT = time;
        t = time;
        boolean was = corrupted;
        etat = "corrompue".equals(s.etat) ? "corrompue" : "creatrice";
        corrupted = "corrompue".equals(etat);
        if (was != corrupted) {
            before = dt == 0 ? corrupted : was;
            switchedAt = dt == 0 ? -10 : t;
        }
        Skins.pump();
        begin(fbW, fbH, s.menu);
        try {
            ResourceLocation atlas = data.atlas(etat, false, t);
            ResourceLocation atlasGlow = data.atlas(etat, true, t);
            assemble(s);
            room(s, atlas, atlasGlow);
            screens(s);
            Xenodys x = xenodys(s, dt);
            build(x, atlas, atlasGlow);
            GeoModel.Pose pp = people(s, dt, x);
            bots(s);
            translucent(s, atlas, dt);
            effects(s, x, pp);
        } catch (Exception e) {
            Opm.LOG.debug("Laboratoire : {}", e.toString());
        } finally {
            end();
        }
        profile(began);
    }

    private static final boolean PROFILE = !System.getProperty("opm.debug.profile", "").isEmpty();
    private long profileFrames;
    private long profileNs;
    private long profileMax;
    private long profileLast;
    private long profileGap;

    /** Développement ({@code -Dopm.debug.profile=1}) : le coût de la scène, et les images en retard. */
    private void profile(long began) {
        if (!PROFILE) return;
        long now = System.nanoTime();
        long cost = now - began;
        profileNs += cost;
        profileMax = Math.max(profileMax, cost);
        if (profileLast != 0) profileGap = Math.max(profileGap, now - profileLast);
        profileLast = now;
        if (++profileFrames == 300) {
            Opm.LOG.info("[OPM:PERF] {} ms/image en moyenne, {} au pire ; plus long intervalle {} ms ; {} images/s",
                    String.format("%.2f", profileNs / 300e6), String.format("%.2f", profileMax / 1e6), profileGap / 1000000,
                    Minecraft.getInstance().getFps());
            profileFrames = profileNs = profileMax = profileGap = 0;
        }
    }

    /* ------------------------------------------------- la salle */

    private void assemble(View s) {
        int n = shownAt.length;
        if (!s.assemble) {
            if (shown < n) {
                for (int i = 0; i < n; i++) if (Double.isNaN(shownAt[i])) shownAt[i] = t - 10;
                shown = n;
            }
            return;
        }
        // La plateforme et sa cuve sont là dès le début ; la salle est entière à 92 %.
        int first = data.foundation;
        int target = Math.min(n, (int) (first + Math.max(0, Math.min(1, s.ratio / 0.92)) * (n - first)));
        // Ce que le launcher a déjà assemblé est en place : la scène continue, elle ne recommence pas.
        if (shown == 0) first = Math.max(first, target);
        int fresh = 0;
        while (shown < target) {
            // Un long saut d'avancement se lit comme une vague, pas comme un éclair.
            shownAt[shown] = shown < first ? t - 10 : t + (fresh++) * 0.0016 + hash(shown) * 0.12;
            shown++;
        }
    }

    private boolean settled(Chunk c) {
        for (int i = c.from; i < c.to; i++) if (!(t - shownAt[i] >= DROP)) return false;
        return true;
    }

    /** L'état d'un groupe de blocs : la bascule court depuis la plateforme. */
    private boolean corruptedAt(int chunk) {
        return t - switchedAt > chunk / (double) chunks.size() * 1.4 ? corrupted : before;
    }

    private void buildChunk(Chunk c, boolean dark) {
        VertexBuffer[] out = new VertexBuffer[3];
        c.vb[dark ? 1 : 0] = out;
        for (int layer = 0; layer < 3; layer++) {
            BufferBuilder bb = quads();
            boolean any = false;
            for (int i = c.from; i < c.to; i++) {
                if (i == tankIndex) continue;
                int[] q = data.entries.get(i).quads()[layer];
                if (q[1] > 0) {
                    data.emit(bb, layer, q[0], q[1], dark, null, 1, 1);
                    any = true;
                }
            }
            MeshData mesh = bb.build();
            if (!any || mesh == null) {
                if (mesh != null) mesh.close();
                continue;
            }
            VertexBuffer vb = new VertexBuffer(VertexBuffer.Usage.STATIC);
            vb.bind();
            vb.upload(mesh);
            VertexBuffer.unbind();
            out[layer] = vb;
        }
    }

    private Matrix4f dropMatrix(int i) {
        double k = (t - shownAt[i]) / DROP;
        double e = ease(k);
        Vector3f c = data.entries.get(i).center();
        double a = (1 - e) * (2.2 + hash(i) * 2);
        double r = (1 - e) * 1.6;
        // Il monte en spirale et s'emboîte (comme les apparitions d'OPMTech).
        return new Matrix4f().translate((float) (c.x + Math.cos(a + i) * r), (float) (c.y - (1 - e) * (1.5 + hash(i * 3) * 1.5)),
                        (float) (c.z + Math.sin(a + i) * r))
                .rotateY((float) ((1 - e) * 2.5)).scale((float) Math.max(0.02, e)).translate(-c.x, -c.y, -c.z);
    }

    private void drawLayer(int layer, boolean glow) {
        for (int state = 0; state < 2; state++) {
            boolean dark = state == 1;
            List<Chunk> loose = new ArrayList<>();
            boolean bound = false;
            // Les blocs en place, en un envoi par groupe…
            for (int i = 0; i < chunks.size(); i++) {
                Chunk c = chunks.get(i);
                if (c.from >= shown) break;
                if (corruptedAt(i) != dark) continue;
                if (!bound) {
                    bound = true;
                    texture(data.atlas(dark ? "corrompue" : "creatrice", glow, t));
                }
                if (!settled(c)) {
                    loose.add(c);
                    continue;
                }
                if (c.vb[state] == null) buildChunk(c, dark);
                VertexBuffer vb = c.vb[state][layer];
                if (vb == null) continue;
                vb.bind();
                vb.drawWithShader(view, proj, RenderSystem.getShader());
            }
            VertexBuffer.unbind();
            // … et ceux qui arrivent, un par un.
            if (loose.isEmpty()) continue;
            BufferBuilder bb = quads();
            for (Chunk c : loose) {
                for (int i = c.from; i < Math.min(c.to, shown); i++) {
                    if (i == tankIndex || !(t >= shownAt[i])) continue;
                    int[] q = data.entries.get(i).quads()[layer];
                    if (q[1] == 0) continue;
                    Matrix4f m = new Matrix4f(view);
                    if (t - shownAt[i] < DROP) m.mul(dropMatrix(i));
                    data.emit(bb, layer, q[0], q[1], dark, m, 1, 1);
                }
            }
            flush(bb);
        }
    }

    private float tankOffset(View s) {
        return (float) (-4.4 * ease(s.tankDown));
    }

    private void tank(View s, int layer) {
        if (tankIndex < 0 || s.tankDown >= 1) return;
        int[] q = data.entries.get(tankIndex).quads()[layer];
        if (q[1] == 0) return;
        BufferBuilder bb = quads();
        data.emit(bb, layer, q[0], q[1], corrupted, new Matrix4f(view).translate(0, tankOffset(s), 0), 1, 1);
        flush(bb);
    }

    private boolean visible(int i) {
        return i < shown && t - shownAt[i] >= DROP;
    }

    /** Secondes de travail de Xenodys à un poste, depuis le début : la machine s'emballe quand elle s'en occupe. */
    private double boost(LabData.Entry owner) {
        if (owner.post() == null) return 0;
        Post p = switch (owner.post()) {
            case "reacteur" -> Post.REACTOR;
            case "hologramme" -> Post.HOLO;
            case "specimen" -> Post.SPECIMEN;
            default -> null;
        };
        if (p == null) return 0;
        double total = 0;
        int k = (int) Math.floor((t - origin) / SLOT);
        for (int i = Math.max(0, k - 24); i <= k; i++) {
            if (postAt(i) != p) continue;
            double c = t - origin - i * SLOT;
            total += Math.max(0, Math.min(SLOT - 0.6, c) - TRAVEL);
        }
        return total;
    }

    private Matrix4f pieceMatrix(LabData.Piece p, double ticks) {
        Matrix4f m = p.parent != null ? pieceMatrix(p.parent, ticks) : new Matrix4f(p.base);
        m.translate(p.pivot);
        for (LabData.Anim a : p.anims) {
            double w = a.period() > 0 ? ticks / a.period() + a.phase() : 0;
            double s = Math.sin(w * 2 * Math.PI);
            switch (a.type()) {
                case "tourne" -> rotate(m, a.axis(), a.speed() * ticks);
                case "balance" -> rotate(m, a.axis(), a.amp() * s);
                case "regard" -> rotate(m, 'y', a.amp() * s);
                case "pas" -> {
                    double step = Math.floor(w);
                    rotate(m, a.axis(), a.amp() * (step + ease((w - step) * 3)));
                }
                case "pulse" -> m.scale((float) (1 + a.amp() * s));
                case "monte" -> move(m, a.axis(), a.amp() / 16 * s);
                case "defile" -> move(m, a.axis(), a.amp() / 16 * (w - Math.floor(w)));
                case "presse" -> move(m, 'y', -a.amp() / 16 * Math.pow(Math.max(0, s), 3));
                default -> { }
            }
        }
        return m.translate(-p.pivot.x, -p.pivot.y, -p.pivot.z);
    }

    private static void rotate(Matrix4f m, char axis, double deg) {
        float a = (float) Math.toRadians(deg % 360);
        if (axis == 'x') m.rotateX(a);
        else if (axis == 'z') m.rotateZ(a);
        else m.rotateY(a);
    }

    private static void move(Matrix4f m, char axis, double d) {
        m.translate(axis == 'x' ? (float) d : 0, axis == 'y' ? (float) d : 0, axis == 'z' ? (float) d : 0);
    }

    private final Map<LabData.Piece, Matrix4f> pieceCache = new HashMap<>();

    private void pieces(View s, int layer) {
        BufferBuilder bb = quads();
        for (LabData.Piece p : data.pieces) {
            int[] q = p.quads[layer];
            if (q[1] == 0 || (p.state != null && !p.state.equals(etat))) continue;
            if ("cuve".equals(p.owner.post()) || !visible(p.ownerIndex)) continue;
            Matrix4f m = pieceCache.get(p);
            if (m != null) data.emit(bb, layer, q[0], q[1], corrupted, m, 1, 1);
        }
        flush(bb);
    }

    private void room(View s, ResourceLocation atlas, ResourceLocation atlasGlow) {
        pieceCache.clear();
        for (LabData.Piece p : data.pieces) {
            double ticks = t * 20 + boost(p.owner) * 50;
            pieceCache.put(p, new Matrix4f(view).mul(pieceMatrix(p, ticks)));
        }
        drawLayer(LabData.BASE, false);
        texture(atlas);
        tank(s, LabData.BASE);
        pieces(s, LabData.BASE);
        RenderSystem.depthMask(false);
        drawLayer(LabData.GLOW, true);
        texture(atlasGlow);
        tank(s, LabData.GLOW);
        pieces(s, LabData.GLOW);
        RenderSystem.depthMask(true);
    }

    /** Les écrans du fond : le logo, et des données qui défilent. */
    private void screens(View s) {
        if (shown < shownAt.length * 0.75) return;
        float z = 1.06f;
        float on = (float) seg(shown / (double) shownAt.length, 0.75, 0.85);
        texture(white());
        BufferBuilder bb = quads();
        int bezel = corrupted ? 0x1B1020 : 0x33454A;
        int dark = corrupted ? 0x12060F : 0x071311;
        float[][] zones = {{3.6f, 12.0f, 7.6f, 10.8f}, {19.0f, 27.4f, 7.6f, 10.8f}};
        for (float[] r : zones) {
            rect(bb, v(r[0] - .2, r[3] + .2, z), v(r[0] - .2, r[2] - .2, z), v(r[1] + .2, r[2] - .2, z), v(r[1] + .2, r[3] + .2, z), bezel, 1);
            rect(bb, v(r[0], r[3], z + .02), v(r[0], r[2], z + .02), v(r[1], r[2], z + .02), v(r[1], r[3], z + .02), dark, 1);
        }
        // Les données : des lignes qui s'écrivent et remontent.
        float[] r = zones[1];
        int scroll = (int) Math.floor(t * 2.2);
        for (int line = 0; line < 13; line++) {
            int id = scroll - line;
            float y = r[2] + 0.2f + line * 0.23f;
            float x = r[0] + 0.25f;
            int words = 1 + (int) (hash(id * 5) * 5);
            double typed = line == 0 ? (t * 2.2 - scroll) * 1.2 : 1;
            for (int w = 0; w < words; w++) {
                float len = 0.3f + (float) hash(id * 17 + w) * 1.3f;
                if (x + len > r[1] - 0.2f || w / (double) words > typed) break;
                int col = hash(id * 31 + w) > 0.75 ? (corrupted ? 0xC77DFF : 0xF1D58A) : accent();
                rect(bb, v(x, y + .11, z + .04), v(x, y, z + .04), v(x + len, y, z + .04), v(x + len, y + .11, z + .04), col, 0.9 * on);
                x += len + 0.16f;
            }
        }
        // Une courbe, au pied de l'écran du logo.
        flush(bb);
        Sprites.Sheet banner = Sprites.get(corrupted ? "bandeau_960_corrompue" : "bandeau_960");
        if (banner != null && on > 0) {
            float[] a = zones[0];
            float w = a[1] - a[0] - 0.9f;
            float h = w * banner.h() / banner.w();
            float mx = (a[0] + a[1]) / 2;
            float my = (a[2] + a[3]) / 2;
            texture(banner.texture());
            bb = quads();
            Vector3f[] p = {v(mx - w / 2, my + h / 2, z + .05), v(mx - w / 2, my - h / 2, z + .05), v(mx + w / 2, my - h / 2, z + .05),
                    v(mx + w / 2, my + h / 2, z + .05)};
            float u = banner.w() / (float) banner.texW();
            float vv = banner.h() / (float) banner.texH();
            float[][] uv = {{0, 0}, {0, vv}, {u, vv}, {u, 0}};
            int al = Math.round(on * 255);
            for (int i = 0; i < 4; i++) {
                view.transformPosition(p[i]);
                bb.addVertex(p[i].x, p[i].y, p[i].z).setUv(uv[i][0], uv[i][1]).setColor(255, 255, 255, al);
            }
            flush(bb);
        }
        // Le balayage des écrans.
        texture(white());
        additive(true);
        bb = quads();
        for (float[] q : zones) {
            float y = q[3] - (float) ((t * 0.5) % 1) * (q[3] - q[2]);
            rect(bb, v(q[0], y, z + .06), v(q[0], Math.max(q[2], y - .35), z + .06), v(q[1], Math.max(q[2], y - .35), z + .06),
                    v(q[1], y, z + .06), accent(), 0.10 * on);
        }
        flush(bb);
        additive(false);
    }

    /* ------------------------------------------------------- Xenodys */

    private final class Xenodys {
        Post post;
        Post from;
        double c;
        int slot;
        Vector3f base;
        Matrix4f world;
        Rig.Pose pose;
        Vector3f right;
        Vector3f left;
        /** 0 → 1 : elle est à l'ouvrage. */
        double work;
    }

    private boolean menuProgram;
    /** Le début du programme en cours : au menu, elle commence près du joueur. */
    private double origin;

    private Post postAt(int k) {
        Post[] seq = menuProgram ? MENU : LOADING;
        return seq[Math.floorMod(k, seq.length)];
    }

    private static Vector3f place(Post p) {
        return switch (p) {
            case HOME -> v(CX + 0.9, 3.6, 7.6);
            case TANK -> v(CX, 3.6, 8.8);
            case REACTOR -> v(6.9, 1.9, 5.8);
            case BUILD -> v(18.9, 1.9, 7.2);
            case HOLO -> v(6.7, 1.7, 7.4);
            case SPECIMEN -> v(21.6, 1.9, 5.8);
        };
    }

    private Vector3f focus(Post p) {
        Vector3f q = switch (p) {
            case REACTOR -> data.posts.getOrDefault("reacteur", v(9.6, 1, 2.4));
            case HOLO -> data.posts.getOrDefault("hologramme", v(10.4, 1, 6.4));
            case SPECIMEN -> data.posts.getOrDefault("specimen", v(24.8, 1, 2.4));
            case BUILD -> v(21.6, 1, 6.2);
            default -> v(CX, TOP, CZ);
        };
        float up = switch (p) {
            case REACTOR -> 1.7f;
            case HOLO -> 2.0f;
            case SPECIMEN -> 2.0f;
            case BUILD -> 2.2f;
            default -> 2.0f;
        };
        return new Vector3f(q).add(0, up, 0);
    }

    private static float yawTo(Vector3f from, Vector3f to) {
        return (float) Math.toDegrees(Math.atan2(-(to.x - from.x), -(to.z - from.z)));
    }

    private Vector3f baseAt(double time) {
        int k = (int) Math.floor((time - origin) / SLOT);
        double c = time - origin - k * SLOT;
        Vector3f a = place(postAt(k - 1));
        Vector3f b = place(postAt(k));
        double e = ease(c / TRAVEL);
        Vector3f p = a.lerp(b, (float) e);
        if (postAt(k - 1) != postAt(k)) p.y += (float) (Math.sin(e * Math.PI) * 0.9);
        return p;
    }

    private Xenodys xenodys(View s, double dt) {
        if (menuProgram != s.inMenu) {
            menuProgram = s.inMenu;
            origin = s.inMenu ? t : 0;
        }
        Xenodys x = new Xenodys();
        x.slot = (int) Math.floor((t - origin) / SLOT);
        x.c = t - origin - x.slot * SLOT;
        x.post = postAt(x.slot);
        x.from = postAt(x.slot - 1);
        Vector3f base = baseAt(t);
        Vector3f vel = baseAt(t + 0.05).sub(base).div(0.05f);
        boolean held = s.greet >= 0 || s.leave > 0 || s.away;
        // Le joueur s'en va, ou le serveur ne répond pas : elle revient près de lui.
        home = damp(home, held || (s.menu > 0 && s.menu < 1) ? 1 : 0, 1.6, dt);
        base.lerp(place(Post.HOME), home);
        if (home > 0.5f) {
            x.post = Post.HOME;
            vel.zero();
        }
        base.y += (float) Math.sin(t * 1.3) * 0.12f;
        x.base = base;
        x.work = x.post == Post.HOME ? 0 : seg(x.c, TRAVEL - 0.2, TRAVEL + 0.8) * (1 - seg(x.c, SLOT - 0.9, SLOT - 0.2)) * (1 - home);

        Vector3f aim = focus(x.post);
        float wantYaw = x.post == Post.HOME ? 180 + 12 : x.post == Post.TANK ? 180 : yawTo(place(x.post), aim);
        float diff = (float) (((wantYaw - bodyYaw + 540) % 360 + 360) % 360 - 180);
        bodyYaw += diff * (float) (1 - Math.exp(-2.6 * dt));
        float speed = vel.length();
        // Elle se penche dans le sens du vol.
        float yawR = (float) Math.toRadians(bodyYaw);
        float ahead = (float) (-vel.x * Math.sin(yawR) - vel.z * Math.cos(yawR));
        float side = (float) (vel.x * Math.cos(yawR) - vel.z * Math.sin(yawR));
        x.world = new Matrix4f().translate(base).rotateY(yawR).rotateX((float) Math.toRadians(-Math.max(-14, Math.min(16, ahead * 4))))
                .rotateZ((float) Math.toRadians(-Math.max(-14, Math.min(14, side * 4)))).scale(XS);

        // Au repos, les mains en coupe autour du monde qu'elle crée ; à l'ouvrage, elles servent.
        float rest = 1 - armWeight;
        Rig.Pose pose = Rig.blend(xen.pose(corrupted ? "corrupted_idle" : "idle", t), xen.pose(corrupted ? "vol_corrompu" : "vol", t), rest);
        float travel = Math.min(1, speed / 2.5f);
        if (travel > 0.02f) {
            float flap = (float) Math.sin(t * 8) * 14 * travel;
            Rig.add(pose, "wing_left", new float[]{0, flap, 0}, null);
            Rig.add(pose, "wing_right", new float[]{0, -flap, 0}, null);
            Rig.add(pose, "skirt_front", new float[]{-16 * travel, 0, 0}, null);
        }
        boolean gripping = corrupted && s.inMenu && x.post == Post.HOME && s.greet < 0;
        busy = damp(busy, s.greet >= 0 || (s.waiting && x.post == Post.HOME) || gripping ? 1 : 0, 5, dt);
        if (s.greet >= 0) {
            pose = Rig.blend(pose, xen.pose("greet", s.greet * 1.6), (float) Math.min(1, s.greet * 4));
        } else if (s.waiting && x.post == Post.HOME) {
            pose = Rig.blend(pose, xen.pose("greet", 1.0), 0.8f);
        }
        // Près des machines, les ailes se replient : elles ne traversent rien.
        fold = damp(fold, x.post == Post.TANK || x.post == Post.HOME ? 0 : 50 * (1 - travel * 0.3f), 2.2, dt);
        Rig.add(pose, "wing_left", new float[]{0, 0, fold}, null);
        Rig.add(pose, "wing_right", new float[]{0, 0, -fold}, null);
        Rig.add(pose, "body", new float[]{10 * (float) x.work, 0, 0}, null);
        Rig.add(pose, "chest", new float[]{x.post == Post.HOME ? 7 : 4 + 8 * (float) x.work, 0, 0}, null);

        // Ses mains : ce qu'elles visent, selon l'ouvrage.
        Vector3f wr = null;
        Vector3f wl = null;
        double w = x.c - TRAVEL;
        switch (x.post) {
            case REACTOR -> {
                double a = t * 1.7;
                wr = new Vector3f(aim).add((float) (Math.cos(a) * 0.5 + 1.2), (float) (Math.sin(a) * 0.5), 1.1f);
                wl = new Vector3f(aim).add((float) (Math.cos(a + Math.PI) * 0.4 + 1.5), (float) (0.8 + Math.sin(a + Math.PI) * 0.4), -0.1f);
            }
            case HOLO -> {
                // Elle écarte puis resserre les mains : l'hologramme grandit et rapetisse.
                double open = 0.75 + 0.4 * Math.sin(w * 1.1);
                wr = new Vector3f(aim).add(0.7f, 0.2f, (float) -open);
                wl = new Vector3f(aim).add(0.7f, 0.2f, (float) open);
            }
            case SPECIMEN -> {
                wr = new Vector3f(aim).add((float) (-0.7 + 0.25 * Math.sin(w * 0.9)), (float) (0.5 * Math.sin(w * 0.7)), 1.25f);
                wl = new Vector3f(aim).add(-1.3f, (float) (0.9 + 0.15 * Math.sin(w * 2)), 1.6f);
            }
            case BUILD -> {
                Vector3f cur = buildFocus(x);
                wr = new Vector3f(cur).lerp(new Vector3f(base).add(0, 5.2f, 0), 0.35f);
                wl = new Vector3f(base).add(1.5f, (float) (5 + 0.3 * Math.sin(w * 2.2)), 1.4f);
            }
            case TANK -> {
                double press = 0.5 + 0.5 * Math.sin(w * 0.8);
                wr = v(CX - 1.3, 7.3 + 0.12 * Math.sin(w * 1.3), 10.4 + 0.15 * press);
                wl = v(CX + 1.3, 7.3 + 0.12 * Math.sin(w * 1.3 + 2), 10.4 + 0.15 * press);
                if (w > 3.2 && w < 6.2) {
                    // Elle forme une étincelle de vie au-dessus de la cuve, et l'y laisse tomber.
                    wr = v(CX - 0.5, 7.9, 10.1);
                    wl = v(CX + 0.5, 7.9, 10.1);
                }
            }
            default -> { }
        }
        armWeight = damp(armWeight, wr != null ? (float) x.work : 0, 4, dt);
        if (wr == null) {
            wr = new Vector3f(base).add(-1.5f, 4.2f, 1.2f);
            wl = new Vector3f(base).add(1.5f, 4.2f, 1.2f);
        }
        handR = damp(handR, wr, 5, dt);
        handL = damp(handL, wl, 5, dt);
        for (int f = 0; f < 4; f++) {
            float busy = (float) (x.work * 26 * Math.max(0, Math.sin(t * 5 + f)));
            curls[f] = damp(curls[f], busy, 8, dt);
            curls[f + 4] = damp(curls[f + 4], (float) (x.work * 26 * Math.max(0, Math.sin(t * 5 + f + 2))), 8, dt);
            Rig.add(pose, "finger_right_" + f, new float[]{curls[f], 0, 0}, null);
            Rig.add(pose, "finger_right_" + f + "_tip", new float[]{curls[f] * 0.8f, 0, 0}, null);
            Rig.add(pose, "finger_left_" + f, new float[]{curls[f + 4], 0, 0}, null);
            Rig.add(pose, "finger_left_" + f + "_tip", new float[]{curls[f + 4] * 0.8f, 0, 0}, null);
        }
        if (gripping) {
            // L'emprise : la main droite en griffe au-dessus du joueur, les fils tendus.
            float pull = (float) Math.sin(t * 2.1) * 6;
            Rig.add(pose, "arm_right", new float[]{-62 + pull, -18, 24}, null);
            Rig.add(pose, "forearm_right", new float[]{-28 - pull, 0, 0}, null);
            for (int f = 0; f < 4; f++) {
                float c = 38 + (float) Math.sin(t * 3 + f) * 10;
                Rig.add(pose, "finger_right_" + f, new float[]{c, 0, 0}, null);
                Rig.add(pose, "finger_right_" + f + "_tip", new float[]{c * 0.8f, 0, 0}, null);
            }
        }

        // Ce qu'elle regarde.
        Vector3f look = x.post == Post.HOME ? v(CX, TOP + 2.2, CZ) : x.post == Post.BUILD ? buildFocus(x) : new Vector3f(aim);
        if (x.post != Post.HOME && x.work < 0.3 && x.c < TRAVEL) look = focus(x.post);
        if (x.post == Post.HOME && !Float.isNaN(s.lookX)) look = unproject(s.lookX, s.lookY, 12);
        if (s.away) look = v(40, 12 + Math.sin(t * 0.7) * 3, 16);
        Vector3f headWorld = x.world.transformPosition(xen.point(pose, "head"), new Vector3f());
        Vector3f d = new Matrix4f(x.world).invert().transformDirection(new Vector3f(look).sub(headWorld), new Vector3f());
        float yaw = (float) Math.max(-58, Math.min(58, Math.toDegrees(Math.atan2(d.x, -d.z))));
        float pitch = (float) Math.max(-35, Math.min(42, Math.toDegrees(Math.atan2(-d.y, Math.hypot(d.x, d.z)))));
        headYaw = damp(headYaw, yaw, 4, dt);
        headPitch = damp(headPitch, pitch, 4, dt);
        Rig.add(pose, "head", new float[]{headPitch * 0.7f, headYaw * 0.7f, 0}, null);
        Rig.add(pose, "neck", new float[]{headPitch * 0.3f, headYaw * 0.3f, 0}, null);

        if (armWeight > 0.01f) {
            solve(pose, x.world, "right", handR, solvedR);
            solve(pose, x.world, "left", handL, solvedL);
            for (int i = 0; i < 4; i++) {
                armR[i] = damp(armR[i], solvedR[i], 10, dt);
                armL[i] = damp(armL[i], solvedL[i], 10, dt);
            }
            apply(pose, "right", armR, armWeight);
            apply(pose, "left", armL, armWeight);
        }
        x.pose = pose;
        rig(xen, pose, x.world, new Rig.Options().hands(rest * (1 - busy)).blink(Xen.blinking(t, 5)), corrupted ? 0xF7EDF5 : 0xFFFFFF);
        x.right = x.world.transformPosition(xen.point(pose, "hand_right"), new Vector3f());
        x.left = x.world.transformPosition(xen.point(pose, "hand_left"), new Vector3f());
        return x;
    }

    private float home;
    private float busy;
    private float fold;

    /** Un point du monde, à `dist` blocs de la caméra, sous un point de l'écran (−1 … 1). */
    private Vector3f unproject(float sx, float sy, float dist) {
        Matrix4f inv = new Matrix4f(proj).mul(view).invert();
        Vector3f far = inv.transformProject(new Vector3f(sx, sy, 0.9f));
        return new Vector3f(far).sub(eye).normalize(dist).add(eye);
    }

    private static void apply(Rig.Pose p, String side, float[] a, float k) {
        Rig.add(p, "arm_" + side, new float[]{a[0] * k, a[1] * k, a[2] * k}, null);
        Rig.add(p, "forearm_" + side, new float[]{a[3] * k, 0, 0}, null);
    }

    private float error(Rig.Pose base, Matrix4f world, String side, Vector3f target, float[] a) {
        Vector3f hand = world.transformPosition(xen.point(base, "hand_" + side, "arm_" + side, a, "forearm_" + side,
                new float[]{a[3], 0, 0}), new Vector3f());
        return hand.distanceSquared(target) + 0.00003f * (a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3]);
    }

    /** L'épaule et le coude d'un bras, pour que la main atteigne sa cible, repartis de l'image précédente. */
    private void solve(Rig.Pose base, Matrix4f world, String side, Vector3f target, float[] state) {
        float[] best = state.clone();
        float bestE = error(base, world, side, target, best);
        float step = 10;
        for (int it = 0; it < 5; it++) {
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

    /* --------------------------------------------- ce qu'elle construit */

    private record Cube(float x, float y, float z, String side, String top) {}

    private static final String C = "circuit:";
    /** Trois ouvrages : une porte, une tour, un noyau de 3 × 3 × 3. */
    private static final List<List<Cube>> WORKS = works();

    private static List<List<Cube>> works() {
        List<Cube> gate = new ArrayList<>();
        for (int y = 0; y < 3; y++) {
            gate.add(new Cube(-1.5f, y + .5f, 0, C + "cote", C + "dalle"));
            gate.add(new Cube(1.5f, y + .5f, 0, C + "cote", C + "dalle"));
        }
        for (int i = -1; i <= 1; i++) gate.add(new Cube(i * 1f, 3.5f, 0, C + "cote", C + "piste"));
        gate.add(new Cube(-2f, 3.5f, 0, C + "condensateur", C + "via"));
        gate.add(new Cube(2f, 3.5f, 0, C + "condensateur", C + "via"));
        gate.add(new Cube(0, 1.6f, 0, C + "coeur", C + "coeur"));
        List<Cube> tower = new ArrayList<>();
        for (int y = 0; y < 4; y++) {
            if (y == 2) {
                tower.add(new Cube(0, y + .5f, 0, C + "coeur", C + "coeur"));
                continue;
            }
            for (int i = 0; i < 4; i++) {
                tower.add(new Cube((i & 1) - .5f, y + .5f, (i >> 1) - .5f, y == 3 ? C + "radiateur" : C + "cote",
                        y == 3 ? C + "emetteur" : C + "dalle"));
            }
        }
        List<Cube> cube = new ArrayList<>();
        for (int i = 0; i < 27; i++) {
            int a = i % 3 - 1;
            int b = i / 3 % 3 - 1;
            int c = i / 9 - 1;
            boolean mid = Math.abs(a) + Math.abs(b) + Math.abs(c) == 1;
            cube.add(new Cube(a * .62f, c * .62f + 2.6f, b * .62f, mid ? C + "coeur" : C + "cote", mid ? C + "coeur" : C + "puce"));
        }
        return List.of(gate, tower, cube);
    }

    private static int work(int slot) {
        return (int) (hash(slot * 13 + 5) * WORKS.size());
    }

    private static double placedAt(int i, int n) {
        return TRAVEL + 0.5 + i * 4.0 / n;
    }

    /** Le bloc qu'elle est en train de poser. */
    private Vector3f buildFocus(Xenodys x) {
        List<Cube> list = WORKS.get(work(x.slot));
        int n = list.size();
        int i = Math.max(0, Math.min(n - 1, (int) ((x.c - TRAVEL - 0.2) / 4.0 * n)));
        if (x.c > TRAVEL + 5.2) return v(21.6, 1 + 2.2, 6.2);
        Cube c = list.get(i);
        return v(21.6 + c.x(), 1 + c.y(), 6.2 + c.z());
    }

    private void build(Xenodys x, ResourceLocation atlas, ResourceLocation atlasGlow) {
        int slot = x.slot;
        if (postAt(slot) != Post.BUILD) return;
        double c = x.c;
        int kind = work(slot);
        List<Cube> list = WORKS.get(kind);
        int n = list.size();
        Vector3f from = data.posts.getOrDefault("caisses", v(24.4, 1, 6.4));
        double power = seg(c, TRAVEL + 5.0, TRAVEL + 5.6) * (1 - seg(c, SLOT - 1.9, SLOT - 1.4));
        double gone = seg(c, SLOT - 1.9, SLOT - 0.2);
        BufferBuilder base = quads();
        List<Object[]> late = new ArrayList<>();
        texture(atlas);
        List<Matrix4f> placed = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Cube q = list.get(i);
            double k = (c - placedAt(i, n)) / 0.75;
            if (k <= 0) continue;
            double e = ease(k);
            Vector3f to = v(21.6 + q.x(), 1 + q.y(), 6.2 + q.z());
            Vector3f start = new Vector3f(from).add((float) (hash(i) - .5), 1.2f, (float) (hash(i * 3) - .5));
            Vector3f p = new Vector3f(start).lerp(to, (float) e);
            p.y += (float) (Math.sin(e * Math.PI) * 1.6);
            float size = (kind == 2 ? 0.6f : 0.98f) * (float) (0.35 + 0.65 * e);
            Matrix4f m = new Matrix4f();
            if (kind == 2) {
                // Le noyau tourne sur lui-même, entier.
                float spin = (float) (t * (0.6 + power * 2.4));
                m.translate(21.6f, 3.6f, 6.2f).rotateY((float) (spin * e)).translate(-21.6f, -3.6f, -6.2f);
            }
            m.translate(p);
            m.rotateY((float) ((1 - e) * 5)).rotateX((float) ((1 - e) * 3));
            if ((C + "coeur").equals(q.side()) && kind != 2) {
                m.translate(0, (float) (Math.sin(t * 3) * 0.08 * power), 0).rotateY((float) (t * (0.5 + 3 * power)));
                size *= 1 + 0.06f * (float) (Math.sin(t * 7) * power);
            }
            if (gone > 0) {
                // Les blocs se détachent, tournent et tombent en rapetissant.
                double g = Math.max(0, Math.min(1, (gone - hash(i * 7) * 0.35) / 0.65));
                m.translate((float) ((hash(i * 11) - .5) * 2.4 * g), (float) (0.9 * g - 3.2 * g * g), (float) ((hash(i * 5) - .5) * 2 * g))
                        .rotateX((float) (g * 4)).rotateZ((float) (g * 3));
                size *= (float) (1 - g);
            }
            if (size < 0.02f) continue;
            m.scale(size);
            block(base, null, m, q.side(), q.top());
            late.add(new Object[]{m, q});
        }
        if (late.isEmpty()) {
            flush(base);
            return;
        }
        flush(base);
        texture(atlasGlow);
        RenderSystem.depthMask(false);
        BufferBuilder glow = quads();
        for (Object[] o : late) blockGlow(glow, (Matrix4f) o[0], (Cube) o[1]);
        flush(glow);
        RenderSystem.depthMask(true);
    }

    private void blockGlow(BufferBuilder glow, Matrix4f world, Cube q) {
        for (int f = 0; f < 6; f++) {
            String tile = f < 2 ? q.top() : q.side();
            if (!data.glows(tile)) continue;
            int[] c = data.cell(tile);
            float[][] uv = {{c[0], c[1]}, {c[0], c[1] + 16}, {c[0] + 16, c[1] + 16}, {c[0] + 16, c[1]}};
            for (int i = 0; i < 4; i++) {
                Vector3f p = new Vector3f(FACE[f][i]).mul(1.006f);
                world.transformPosition(p);
                view.transformPosition(p);
                glow.addVertex(p.x, p.y, p.z).setUv(uv[i][0] / data.atlasW, uv[i][1] / data.atlasH).setColor(-1);
            }
        }
    }

    /* ------------------------------------------------------- le joueur */

    private Vector3f mouth = v(CX, 6, CZ);
    private Vector3f[] grip = new Vector3f[0];

    /** Celui qu'on montre : le joueur lui-même, sinon un skin de la galerie. */
    private Skins.Printed shownPlayer() {
        if (Skins.own() != null) return Skins.own();
        int n = Skins.gallerySize();
        for (int i = 0; i < n; i++) if (Skins.galleryAt(i) != null) return Skins.galleryAt(i);
        return null;
    }

    private GeoModel.Pose people(View s, double dt, Xenodys x) {
        Skins.Printed who = shownPlayer();
        if (who == null) return null;
        GeoModel m = who.slim() ? playerSlim : player;
        float down = (float) ease(s.tankDown);
        float want = TANK_FLOOR + (TANK_TOP - TANK_FLOOR) * Math.max(0, Math.min(1, s.ratio * 1.02f)) * (1 - s.drain);
        level = damp(level, want, 2.6, dt);
        double sub = (level - TANK_FLOOR) / (32 * PS);
        double swim = ease(seg(sub, 0.75, 1.0)) * (1 - down);
        GeoModel.Pose p = standing(m, t, corrupted && s.inMenu);
        Matrix4f world = new Matrix4f();
        float feet = TANK_FLOOR + (TOP - TANK_FLOOR) * down;
        if (swim > 0) {
            GeoModel.Pose float_ = m.pose(null, 0);
            double ph = t * 1.7;
            double panic = corrupted ? 1.9 : 1;
            // Il flotte : bras qui brassent, jambes qui battent, corps qui ondule.
            GeoModel.add(float_, "right_arm", new float[]{(float) (-28 - 26 * Math.sin(ph * panic)), 0, (float) (34 + 18 * Math.sin(ph * panic + 0.8))}, null);
            GeoModel.add(float_, "left_arm", new float[]{(float) (-28 + 26 * Math.sin(ph * panic)), 0, (float) (-34 - 18 * Math.sin(ph * panic + 1.6))}, null);
            GeoModel.add(float_, "right_leg", new float[]{(float) (18 * Math.sin(ph * 1.3 * panic) - 6), 0, 4}, null);
            GeoModel.add(float_, "left_leg", new float[]{(float) (-18 * Math.sin(ph * 1.3 * panic) - 6), 0, -4}, null);
            GeoModel.add(float_, "head", new float[]{(float) (8 * Math.sin(ph * 0.6)), (float) (22 * Math.sin(ph * 0.43)), 0}, null);
            // De temps en temps : il salue, il frappe à la vitre, il fait une roulade, il cherche Xenodys.
            int slot = (int) Math.floor(t / 6.5);
            double c = t - slot * 6.5;
            double on = ease(seg(c, 0.4, 1.0)) * (1 - ease(seg(c, 3.4, 4.0)));
            int act = (int) (hash(slot * 19 + 3) * 4);
            if (corrupted) act = act == 2 ? 1 : act;
            double flip = 0;
            if (act == 0) {
                GeoModel.add(float_, "right_arm", new float[]{(float) (-120 * on), 0, (float) ((-10 + 24 * Math.sin(t * 9)) * on)}, null);
            } else if (act == 1) {
                double knock = Math.max(0, Math.sin(t * 10));
                GeoModel.add(float_, "right_arm", new float[]{(float) ((-62 - 18 * knock) * on), 0, (float) (-30 * on)}, null);
                GeoModel.add(float_, "left_arm", new float[]{(float) ((-62 - 18 * (1 - knock)) * on), 0, (float) (30 * on)}, null);
            } else if (act == 2) {
                flip = ease(seg(c, 0.6, 3.0)) * 360;
                float tuck = (float) (Math.sin(seg(c, 0.6, 3.0) * Math.PI));
                GeoModel.add(float_, "right_leg", new float[]{-70 * tuck, 0, 0}, null);
                GeoModel.add(float_, "left_leg", new float[]{-70 * tuck, 0, 0}, null);
            } else {
                GeoModel.add(float_, "head", new float[]{(float) (-34 * on), 0, 0}, null);
            }
            p = GeoModel.blend(p, float_, (float) swim);
            double turn = act == 1 || act == 0 ? 0 : 1;
            float yaw = (float) (Math.sin(t * 0.35) * 40 * (0.35 + 0.65 * turn) * swim);
            float bob = (float) ((0.28 + Math.sin(t * 1.1) * 0.14) * swim);
            float mid = 16 * PS;
            world.translate(CX + (float) (Math.sin(t * 0.6) * 0.14 * swim), feet + bob + mid + tankOffset(s) * 0, CZ + (float) (Math.cos(t * 0.5) * 0.1 * swim))
                    .rotateY((float) Math.toRadians(180 + yaw)).rotateX((float) Math.toRadians((-8 + 6 * Math.sin(t * 0.8)) * swim - flip))
                    .rotateZ((float) Math.toRadians(5 * Math.sin(t * 0.7) * swim)).translate(0, -mid, 0).scale(PS);
        } else {
            float k = PS * (1 + 0.14f * down);
            world.translate(CX + (s.inMenu ? -0.3f * down : 0), feet, CZ + 0.4f * down).rotateY((float) Math.toRadians(180 - 8 * down)).scale(k);
            // L'eau monte : il lève les bras.
            float wade = (float) (seg(sub, 0.25, 0.7) * (1 - down));
            if (wade > 0 && s.assemble) {
                GeoModel.add(p, "right_arm", new float[]{-20 * wade, 0, 48 * wade}, null);
                GeoModel.add(p, "left_arm", new float[]{-20 * wade, 0, -48 * wade}, null);
            }
        }
        float alpha = 1 - s.leave;
        if (alpha > 0.01f) model(m, p, world, who.texture(), null, alpha, corrupted ? 0xE8D6E2 : swim > 0.4 ? 0xD8F4F0 : 0xFFFFFF);
        mouth = world.transformPosition(m.point(p, "head").add(0, 3, -5), new Vector3f());
        grip = new Vector3f[]{world.transformPosition(m.point(p, "head").add(0, 8, 0), new Vector3f()),
                world.transformPosition(m.point(p, "right_arm").add(0, -6, 0), new Vector3f()),
                world.transformPosition(m.point(p, "left_arm").add(0, -6, 0), new Vector3f()),
                world.transformPosition(m.point(p, "body").add(0, -2, 0), new Vector3f())};
        return p;
    }

    /** Un joueur debout : il respire, ses bras se balancent, il regarde autour de lui, et parfois salue. */
    static GeoModel.Pose standing(GeoModel m, double t, boolean fear) {
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
        int slot = (int) Math.floor(t / 9);
        double c = t - slot * 9;
        double on = ease(seg(c, 0.3, 0.8)) * (1 - ease(seg(c, 2.4, 3.0)));
        if (hash(slot * 23 + 1) < 0.4) {
            GeoModel.add(p, "right_arm", new float[]{(float) (-135 * on), 0, (float) ((-8 + 22 * Math.sin(t * 9)) * on)}, null);
        } else if (hash(slot * 23 + 1) < 0.7) {
            GeoModel.add(p, "head", new float[]{(float) (-26 * on), (float) (30 * on), 0}, null);
        }
        return p;
    }

    /* --------------------------------------------------- les assistants */

    private void bots(View s) {
        if (graine == null || luciole == null || fileuse == null || shown < shownAt.length * 0.4) return;
        // La fileuse tisse, près des serveurs.
        Rig.Pose p = fileuse.pose("idle", t);
        Rig.add(p, "head", new float[]{(float) (6 * Math.sin(t * 0.9)), (float) (16 * Math.sin(t * 0.5)), 0}, null);
        rig(fileuse, p, new Matrix4f().translate(27.4f, 1, 6.6f).rotateY((float) Math.toRadians(-62 + 10 * Math.sin(t * 0.3))).scale(BOT * 1.25f),
                null, 0xFFFFFF);
        // La luciole éclaire la salle, à droite de la plateforme.
        double la = t * 0.33;
        double dir = Math.cos(la);
        rig(luciole, luciole.pose("idle", t), new Matrix4f().translate((float) (CX + 6.6 + Math.sin(la) * 1.5),
                        (float) (7.4 + Tisseuse.lucioleFloat(t) + 0.5 * Math.sin(t * 0.8)), (float) (CZ + 1.2 + 0.9 * Math.sin(t * 0.5)))
                .rotateY((float) Math.toRadians(180 - 55 * dir)).rotateZ((float) Math.toRadians(-10 * dir)).scale(BOT), null, 0xFFFFFF);
        // Le bâtisseur fait sa ronde, son cube de monde dans les bras, et trébuche parfois.
        double window = 9;
        int idx = (int) Math.floor(t / window);
        double paused = 0;
        for (int i = Math.max(0, idx - 60); i < idx; i++) if (hash(i * 7 + 3) < 0.45) paused += 2.3;
        double local = t - idx * window;
        double fall = -1;
        if (hash(idx * 7 + 3) < 0.45) {
            if (local >= 3 && local < 5.3) fall = local - 3;
            paused += Math.max(0, Math.min(2.3, local - 3));
        }
        double walk = t - paused;
        // Un arc sur l'étage du milieu, devant la plateforme.
        double arc = 1.9;
        double q = ((walk * 0.2) % (2 * arc) + 2 * arc) % (2 * arc);
        boolean right = q < arc;
        double at = (right ? q : 2 * arc - q) - arc / 2;
        float radius = 4.75f;
        float bx = (float) (CX + Math.sin(at) * radius);
        float bz = (float) (CZ + Math.cos(at) * radius);
        float facing = (float) Math.toDegrees(at) + (right ? -90 : 90);
        Rig.Pose w = graine.pose("idle", t);
        float rx = 0;
        float pace = 0;
        if (fall >= 0) {
            double k = fall < 0.6 ? ease(fall / 0.6) : fall < 1.4 ? 1 : 1 - ease((fall - 1.4) / 0.9);
            rx = (float) (-88 * k);
            Rig.add(w, "arm_left", new float[]{(float) (-140 * k), 0, -20}, null);
            Rig.add(w, "arm_right", new float[]{(float) (-140 * k), 0, 20}, null);
        } else {
            double st = Math.sin(walk * 2 * Math.PI * 1.2);
            Rig.add(w, "leg_left", new float[]{(float) (35 * st), 0, 0}, null);
            Rig.add(w, "leg_right", new float[]{(float) (-35 * st), 0, 0}, null);
            Rig.add(w, "body", null, new float[]{0, (float) Math.abs(st) * 0.8f, 0});
            pace = 1;
        }
        rig(graine, w, new Matrix4f().translate(bx, TOP - 1, bz).rotateY((float) Math.toRadians(facing)).rotateX((float) Math.toRadians(rx)).scale(BOT),
                new Rig.Options().walk(pace), 0xFFFFFF);
    }

    /* ------------------------------------- verre, liquide, effets */

    private void translucent(View s, ResourceLocation atlas, double dt) {
        RenderSystem.depthMask(false);
        drawLayer(LabData.TRANS, false);
        texture(atlas);
        pieces(s, LabData.TRANS);
        liquid(s);
        texture(atlas);
        tank(s, LabData.TRANS);
        RenderSystem.depthMask(true);
    }

    /** Le liquide de la grande cuve : un prisme à huit pans qui se remplit. */
    private void liquid(View s) {
        float y0 = TANK_FLOOR - 0.05f + tankOffset(s);
        float y1 = level + tankOffset(s);
        if (s.tankDown >= 1 || y1 - y0 < 0.06f) return;
        double r = 1.62 / Math.cos(Math.PI / 8);
        int tint = corrupted ? 0xC0264C : 0x4FD9C8;
        texture(white());
        BufferBuilder bb = quads();
        for (int i = 0; i < 8; i++) {
            double a = (i - 0.5) * Math.PI / 4;
            double b = (i + 0.5) * Math.PI / 4;
            Vector3f p = v(CX + Math.cos(a) * r, 0, CZ + Math.sin(a) * r);
            Vector3f q = v(CX + Math.cos(b) * r, 0, CZ + Math.sin(b) * r);
            // Des bandes d'un quart de bloc, qui ondulent : un liquide, pas une vitre.
            for (float y = y0; y < y1; y += 0.25f) {
                float top = Math.min(y1, y + 0.25f);
                double wave = 0.5 + 0.5 * Math.sin(y * 5 - t * 1.6 + i);
                rect(bb, v(p.x, top, p.z), v(p.x, y, p.z), v(q.x, y, q.z), v(q.x, top, q.z), tint, 0.20 + 0.06 * Math.round(wave * 2) / 2.0);
            }
        }
        flush(bb);
        // La surface, et son liseré.
        bb = quads();
        for (int i = 0; i < 8; i++) {
            double a = (i - 0.5) * Math.PI / 4;
            double b = (i + 0.5) * Math.PI / 4;
            Vector3f o = v(CX, y1, CZ);
            Vector3f p = v(CX + Math.cos(a) * r, y1 + Math.sin(t * 2 + i) * 0.03, CZ + Math.sin(a) * r);
            Vector3f q = v(CX + Math.cos(b) * r, y1 + Math.sin(t * 2 + i + 1) * 0.03, CZ + Math.sin(b) * r);
            rect(bb, o, p, q, o, accent(), 0.4);
            rect(bb, p, v(p.x, p.y - .06, p.z), v(q.x, q.y - .06, q.z), q, core(), 0.85);
        }
        flush(bb);
        // Les bulles : de sa bouche, et du fond.
        additive(true);
        bb = quads();
        for (int i = 0; i < 46; i++) {
            double life = (t * (0.35 + hash(i) * 0.35) + hash(i * 3)) % 1;
            boolean breath = i < 8;
            double rr = Math.sqrt(hash(i * 5)) * 1.4;
            double an = hash(i * 7) * Math.PI * 2;
            Vector3f o = breath ? new Vector3f(mouth) : v(CX + Math.cos(an) * rr, y0, CZ + Math.sin(an) * rr);
            float y = o.y + (float) (life * (breath ? 2.2 : y1 - y0));
            if (y > y1 - 0.05f || y < y0) continue;
            spark(bb, v(o.x + Math.sin(t * 3 + i) * 0.07, y, o.z + Math.cos(t * 2 + i) * 0.07), 0.05f + (float) hash(i * 11) * 0.07f, core(), 0.55);
        }
        flush(bb);
        additive(false);
    }

    private void effects(View s, Xenodys x, GeoModel.Pose pp) {
        texture(white());
        additive(true);
        BufferBuilder bb = quads();
        double w = x.c - TRAVEL;
        if (x.work > 0.02 && x.post != Post.HOME) {
            Vector3f aim = focus(x.post);
            switch (x.post) {
                case REACTOR -> {
                    beam(bb, x.right, aim, 0.075f, x.work * 0.9, 1);
                    beam(bb, x.left, aim, 0.075f, x.work * 0.9, 5);
                    for (int i = 0; i < 18; i++) {
                        double a = t * 4 + i * Math.PI / 9;
                        double r = 0.8 + 0.25 * Math.sin(t * 5 + i);
                        spark(bb, v(aim.x + Math.cos(a) * r, aim.y + Math.sin(t * 3 + i * 2) * 0.6, aim.z + Math.sin(a) * r), 0.07f, accent(), x.work * 0.8);
                    }
                }
                case HOLO -> {
                    for (int i = 0; i < 26; i++) {
                        double k = (t * 0.6 + hash(i)) % 1;
                        Vector3f from = i % 2 == 0 ? x.right : x.left;
                        Vector3f p = new Vector3f(from).lerp(aim, (float) k);
                        p.add(0, (float) (Math.sin(k * Math.PI) * 0.35), 0);
                        spark(bb, p, 0.06f, i % 5 == 0 ? core() : accent(), x.work * 0.8);
                    }
                    ring(bb, aim, 1.15f + 0.3f * (float) Math.sin(w * 1.1), x.work * 0.7, 30);
                }
                case SPECIMEN -> {
                    beam(bb, x.right, new Vector3f(aim).add(0, 0, 0.6f), 0.06f, x.work * 0.7, 3);
                    ring(bb, new Vector3f(aim).add(0, (float) (Math.sin(w * 1.4) * 1.1), 0), 1.0f, x.work * 0.6, 28);
                }
                case BUILD -> {
                    if (w < 5.0) beam(bb, x.right, buildFocus(x), 0.065f, x.work * 0.85, 2);
                    double power = seg(w, 5.0, 5.6) * (1 - seg(x.c, SLOT - 1.9, SLOT - 1.4));
                    if (power > 0) {
                        Vector3f o = v(21.6, work(x.slot) == 0 ? 2.6 : 3.6, 6.2);
                        beam(bb, x.right, o, 0.08f, power, 2);
                        beam(bb, x.left, o, 0.08f, power, 7);
                        ring(bb, o, 1.5f + 0.2f * (float) Math.sin(t * 5), power, 40);
                        for (int i = 0; i < 24; i++) {
                            double k = (t * 0.8 + hash(i)) % 1;
                            double a = hash(i * 3) * Math.PI * 2;
                            spark(bb, v(o.x + Math.cos(a) * (0.4 + k), o.y - 1 + k * 3, o.z + Math.sin(a) * (0.4 + k)), 0.08f, accent(), power * (1 - k));
                        }
                    }
                }
                case TANK -> {
                    double orb = seg(w, 3.4, 4.2) * (1 - seg(w, 6.4, 6.6));
                    if (orb > 0) {
                        // L'étincelle de vie : elle se forme entre ses mains, puis descend dans la cuve.
                        double fall = ease(seg(w, 5.2, 6.4));
                        Vector3f o = new Vector3f(x.right).lerp(x.left, 0.5f).add(0, 0.2f, 0.3f).lerp(v(CX, TANK_TOP - 0.2, CZ), (float) fall);
                        for (int i = 0; i < 30; i++) {
                            double a = hash(i) * Math.PI * 2 + t * 3;
                            double b = hash(i * 3) * Math.PI;
                            double r = 0.12 + 0.26 * hash(i * 5) * orb;
                            spark(bb, v(o.x + Math.cos(a) * Math.sin(b) * r, o.y + Math.cos(b) * r, o.z + Math.sin(a) * Math.sin(b) * r), 0.09f, i % 3 == 0 ? core() : accent(), orb);
                        }
                    }
                    double splash = seg(w, 6.3, 6.5) * (1 - seg(w, 7.6, 8.2));
                    if (splash > 0) for (int i = 0; i < 3; i++) ring(bb, v(CX, level - i * 0.6 * seg(w, 6.4, 7.6), CZ), 0.5f + 1.0f * (float) seg(w, 6.3, 7.4), splash * 0.8, 30);
                }
                default -> { }
            }
        }
        // L'emprise de Xenodys corrompue, au menu : des fils de ses doigts jusqu'à lui.
        if (corrupted && s.inMenu && x.post == Post.HOME && s.greet < 0 && s.leave <= 0 && grip.length == 4) {
            for (int f = 0; f < 4; f++) {
                Vector3f tip = x.world.transformPosition(xen.point(x.pose, "finger_right_" + f + "_tip"), new Vector3f());
                beam(bb, tip, grip[f], 0.045f, 0.8, f);
            }
        }
        // Le départ : le joueur se défait en lumière.
        if (s.leave > 0) {
            for (int i = 0; i < 140; i++) {
                double k = Math.max(0, Math.min(1, (s.leave * 1.5 - hash(i) * 0.5)));
                if (k <= 0 || k >= 1) continue;
                double a = hash(i * 3) * Math.PI * 2 + k * 5;
                double r = 0.55 * (1 - k * 0.8);
                spark(bb, v(CX - 0.3 + Math.cos(a) * r, TOP + hash(i * 7) * 2.6 + k * k * 9, CZ + 0.4 + Math.sin(a) * r), 0.1f, i % 4 == 0 ? core() : accent(), 1 - k * 0.6);
            }
            ring(bb, v(CX - 0.3, TOP + 0.1, CZ + 0.4), 0.6f + 2.2f * (float) ease(s.leave), 1 - s.leave, 44);
        }
        // Les anneaux de la plateforme, et les poussières de lumière de la salle.
        ring(bb, v(CX, TOP + 0.04, CZ), 3.1f, 0.22 + 0.1 * Math.sin(t * 2), 60);
        for (int i = 0; i < 70; i++) {
            double life = (t * 0.03 * (1 + hash(i)) + hash(i * 5)) % 1;
            Vector3f p = v(1.5 + hash(i * 3) * 28 + Math.sin(t * 0.4 + i) * 0.5, 1.2 + life * 14, 1.5 + hash(i * 7) * 20);
            spark(bb, p, 0.045f, accent(), 0.5 * Math.sin(life * Math.PI));
        }
        // L'onde de conversion, à la bascule d'un état à l'autre.
        double shift = t - switchedAt;
        if (shift < 1.6) {
            for (int k = 0; k < 4; k++) ring(bb, v(CX, TOP + 0.2 + k * 1.4, CZ), 1 + (float) shift * 9, (1 - shift / 1.6) * 0.9, 90);
        }
        flush(bb);
        additive(false);
    }

    private void ring(BufferBuilder bb, Vector3f o, float r, double alpha, int n) {
        for (int i = 0; i < n; i++) {
            double a = i * 2 * Math.PI / n + t * 0.8;
            boolean hot = (i + (int) (t * 10)) % 7 == 0;
            spark(bb, v(o.x + Math.cos(a) * r, o.y, o.z + Math.sin(a) * r), 0.075f, hot ? core() : accent(), alpha * (hot ? 1 : 0.6));
        }
    }
}
