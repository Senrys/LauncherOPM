package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.Lighting;
import com.mojang.math.Axis;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Random;
import java.util.Set;
import net.minecraft.Util;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.SoundEvents;
import net.neoforged.neoforge.client.gui.ModListScreen;
import org.lwjgl.glfw.GLFW;

/**
 * L'écran titre de One Piece Minecraft, aux couleurs du launcher : la salle
 * de simulation, le cadre du menu, et Xenodys en vraie 3D (client/GeoModel,
 * le modèle GeckoLib du jeu). Elle flotte (`idle`, ou `corrupted_idle`), suit
 * la souris du regard — en douceur —, cligne des yeux, regarde le bouton
 * survolé, et tend la main quand on rejoint le serveur (`greet`).
 *
 * On n'y rejoint qu'un serveur : celui d'OPM (pas de solo, pas de liste de
 * serveurs). C'est aussi l'écran où l'on revient après une déconnexion.
 */
public final class OpmTitleScreen extends Screen {
    private static GeoModel xenodys;
    private static boolean xenodysTried;

    private final OpmSession session = OpmSession.get();
    private final Lab lab = new Lab();
    private final Random random = new Random();
    private long last = -1;
    private double t;
    private double nextBlink = 2;
    private double blinkUntil;
    private int hover = -1;
    private int lastHover = -1;

    // Le regard, lissé (degrés, convention Bedrock).
    private float yaw;
    private float pitch;
    private float lean;
    private double lastMx = -1;
    private double lastMy = -1;
    private double movedAt = -10;
    // Le salut (greet) avant de rejoindre : début, et action différée.
    private double greetAt = -1;
    private boolean joining;

    private int k = 1;
    private int vw;
    private int vh;
    private final int[][] buttons = new int[4][4];

    // L'assistant qui se promène, et parfois tombe.
    private double botX = -1;
    private boolean entered;
    private int botDir = 1;
    private int botState;
    private double botAt;

    public OpmTitleScreen() {
        super(Component.literal("One Piece Minecraft"));
    }

    private static GeoModel socle;
    private static boolean socleTried;

    private static final GeoModel[] PLAYERS = new GeoModel[2];

    private static GeoModel playerModel(boolean slim) {
        int i = slim ? 1 : 0;
        if (PLAYERS[i] == null) PLAYERS[i] = GeoModel.load(slim ? "joueur_fin" : "joueur", null);
        return PLAYERS[i];
    }

    private static GeoModel socleModel() {
        if (!socleTried) {
            socleTried = true;
            socle = GeoModel.load("socle", null);
        }
        return socle;
    }

    private static GeoModel model() {
        if (!xenodysTried) {
            xenodysTried = true;
            xenodys = GeoModel.load("xenodys", "animation.xenodys");
        }
        return xenodys;
    }

    @Override
    protected void init() {
        OpmLive.start();
        Skins.start(session);
        Skins.fallbackOwn();
    }

    /** Le serveur ne répond pas (connu comme tel). */
    private static boolean offline() {
        return OpmLive.known && !OpmLive.online;
    }

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    private int accent() {
        return session.corrupted() ? 0xF0506E : 0x91D9D1;
    }

    private int core() {
        return session.corrupted() ? 0xFFD3DD : 0xE9FFFC;
    }

    private int deep() {
        return session.corrupted() ? 0x6A1F8F : 0x1D5C51;
    }

    private double vpX(double guiX) {
        return guiX * minecraft.getWindow().getGuiScale() / k;
    }

    private double vpY(double guiY) {
        return guiY * minecraft.getWindow().getGuiScale() / k;
    }

    private static float damp(float current, float target, double rate, double dt) {
        return (float) (target + (current - target) * Math.exp(-rate * dt));
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        long now = Util.getMillis();
        double dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        t += dt;
        var window = minecraft.getWindow();
        k = Math.max(1, window.getHeight() / 270);
        vw = (int) Math.ceil(window.getWidth() / (double) k);
        vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        double mx = vpX(mouseX);
        double my = vpY(mouseY);
        String etat = session.etat;

        var pose = g.pose();
        pose.pushPose();
        pose.scale(s, s, 1);
        lab.render(g, vw, vh, dt, etat, 1f);

        // ------------------------------------------------- géométrie du menu
        int left = Math.max(14, Math.round(vw * 0.07f));
        int panelW = Math.min(290, Math.round(vw * 0.46f));
        int right = left + panelW;
        int panelH = Math.min(vh - 30, 200);
        int top = (vh - panelH) / 2;
        int bottom = top + panelH;
        int bw = panelW - 24;
        int by = bottom - 62;
        set(0, left + 12, by, bw, 22);
        int third = (bw - 8) / 3;
        set(1, left + 12, by + 28, third, 16);
        set(2, left + 12 + third + 4, by + 28, third, 16);
        set(3, left + 12 + 2 * (third + 4), by + 28, bw - 2 * (third + 4), 16);
        hover = -1;
        for (int i = 0; i < 4; i++) if (inside(i, mx, my)) hover = i;
        if (hover >= 0 && hover != lastHover) {
            minecraft.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.UI_BUTTON_CLICK.value(), 1.6f, 0.15f));
        }
        lastHover = hover;

        // ------------------------------------------------------------ Xenodys
        drawScene(g, dt, mx, my, right, etat);

        // --------------------------------------------------------- le cadre
        g.fill(left, top, right, bottom, argb(0x071211, 0.96));
        g.fill(left, top, right, top + 1, argb(accent(), 0.8));
        g.fill(left, bottom - 1, right, bottom, argb(accent(), 0.5));
        g.fill(left, top, left + 1, bottom, argb(accent(), 0.5));
        g.fill(right - 1, top, right, bottom, argb(accent(), 0.8));
        for (int[] c : new int[][]{{left, top}, {right - 4, top}, {left, bottom - 1}, {right - 4, bottom - 1}}) {
            g.fill(c[0], c[1], c[0] + 4, c[1] + 1, argb(core(), 1));
        }
        Sprites.Sheet banner = Sprites.get(session.corrupted() ? "bandeau_240_corrompue" : "bandeau_240");
        if (banner != null) Sprites.draw(g, banner, 0, left + 12, top + 10, false, 1f, 0.5f);
        int y = top + 58;
        String status = !OpmLive.known ? "Connexion au serveur…"
                : !OpmLive.online ? "Serveur hors ligne"
                : OpmLive.full() ? "Serveur complet · " + OpmLive.players + "/" + OpmLive.max
                : "Serveur en ligne · " + OpmLive.players + (OpmLive.players > 1 ? " joueurs" : " joueur");
        int dot = !OpmLive.known ? 0x7FA8A3 : !OpmLive.online ? 0xF0506E : OpmLive.full() ? 0xF0C05A : 0x6FE3A0;
        g.fill(left + 12, y + 1, left + 15, y + 4, argb(dot, 1));
        PixelFont.draw(g, status, left + 20, y, core(), 0.95f, 1f);
        y += 14;
        // Ce que dit Xenodys : l'annonce du staff, sinon l'état du monde.
        String said = session.message != null ? session.message
                : offline() ? "Le monde est hors d'atteinte… Xenodys le cherche dans la simulation."
                : OpmLive.full() ? "Le monde est plein. Xenodys vous garde une place : réessayez dans un instant."
                : session.corrupted() ? "Xenodys n'est plus elle-même. Prudence, aventurier." : "Xenodys veille sur la simulation.";
        String news = OpmLive.news;
        PixelFont.draw(g, "Xenodys", left + 12, y, accent(), 0.9f, 1f);
        y = wrap(g, said, left + 12, y + 10, bw, 0xB8D6D2, 3);
        if (news != null && y < by - 22) {
            PixelFont.draw(g, "Journal de bord", left + 12, y + 4, accent(), 0.9f, 1f);
            wrap(g, news, left + 12, y + 14, bw, 0xB8D6D2, 2);
        }
        drawButton(g, 0, joining ? "Xenodys vous emmène…" : offline() ? "Réessayer la connexion"
                : OpmLive.full() ? "Tenter de rejoindre" : "Rejoindre One Piece Minecraft", true);
        drawButton(g, 1, "Options", false);
        drawButton(g, 2, "Mods", false);
        drawButton(g, 3, "Quitter", false);
        String who = session.playerName != null ? "Connecté : " + session.playerName : "Lancez le jeu depuis le launcher OPM";
        PixelFont.draw(g, who, left + 12, bottom - 12, session.fromLauncher ? 0x7FA8A3 : 0xF0506E, 0.9f, 1f);

        // ---------------------------------------------------- les assistants
        Sprites.Sheet peek = Sprites.get("bot_repos", etat);
        // Le curieux, assis sur le coin bas-gauche du cadre.
        if (peek != null) Sprites.draw(g, peek, peek.frameAt(t), left + 8, bottom + 14, true, 1f, 1f);
        drawWalker(g, dt, etat, Math.round(vw * 0.86f), vh - 8);

        pose.popPose();
        DebugShots.maybe("titre", t);
        DebugShots.drive(this, t);

        if (joining && greetAt >= 0 && t - greetAt > 1.1) {
            joining = false;
            greetAt = -1;
            connect();
        }
    }

    /**
     * À droite du menu : le joueur sur son socle de circuit imprimé, tourné de
     * 30° comme dans le launcher, et Xenodys derrière lui, en 3D. Créatrice,
     * elle veille sur lui — son regard revient à lui quand la souris se tait ;
     * corrompue, elle le tient sous son emprise : main en griffe au-dessus de
     * lui, des fils rouges de ses doigts jusqu'à lui, et lui qui a peur.
     */
    private void drawScene(GuiGraphics g, double dt, double mx, double my, int menuRight, String etat) {
        boolean corrupted = session.corrupted();
        float px = Math.max(menuRight + 60, menuRight + (vw - menuRight) * 0.42f);
        float floor = vh * 0.9f;
        float stand = floor - 6;
        float headPlayerY = stand - 62;

        if (mx != lastMx || my != lastMy) {
            lastMx = mx;
            lastMy = my;
            movedAt = t;
        }

        GeoModel model = model();
        GeoModel.Pose p = null;
        float scale = vh * 0.74f / 104f;
        float cx = px + 46;
        double arrive = Math.min(1, t / 1.4);
        float drop = corrupted ? 0 : (float) Math.pow(1 - arrive, 3) * -vh * 0.6f;
        boolean flicker = corrupted && arrive < 1 && random.nextDouble() < 0.4;
        float baseY = floor - 2 + drop + (float) Math.sin(t * 1.3) * 2;
        float turn = 180 - 28;
        if (model != null) {
            // Ce qu'elle regarde : le bouton survolé, la souris qui bouge… sinon, lui.
            double headX = cx;
            double headY = baseY - 89 * scale;
            double tx = px;
            double ty = headPlayerY + 10;
            if (offline() && hover < 0) {
                // Le monde est hors d'atteinte : elle se détourne, inquiète, et cherche au loin.
                tx = vw * 1.3 + Math.sin(t * 0.7) * vw * 0.2;
                ty = vh * 0.1;
            } else if (hover >= 0) {
                tx = buttons[hover][0] + buttons[hover][2] / 2.0;
                ty = buttons[hover][1] + buttons[hover][3] / 2.0;
            } else if (t - movedAt < 2.5) {
                tx = mx;
                ty = my;
            }
            float targetYaw = (float) Math.max(-50, Math.min(50, (tx - headX) / (vw * 0.45) * 60));
            float targetPitch = (float) Math.max(-20, Math.min(35, (ty - headY) / (vh * 0.45) * 40));
            yaw = damp(yaw, targetYaw, 4.5, dt);
            pitch = damp(pitch, targetPitch, 4.5, dt);
            lean = damp(lean, offline() ? -1.5f : hover >= 0 || !corrupted ? 1 : 0, 2.5, dt);
            if (t > nextBlink) {
                blinkUntil = t + 0.13;
                nextBlink = t + 2.2 + random.nextDouble() * 4;
            }
            p = model.pose(corrupted ? "corrupted_idle" : "idle", (float) t);
            if (greetAt >= 0) {
                GeoModel.Pose greet = model.pose("greet", (float) (t - greetAt) * 1.6f);
                p = GeoModel.blend(p, greet, (float) Math.min(1, (t - greetAt) * 4));
            } else if (OpmLive.full()) {
                // Le monde est plein : la main levée, paume ouverte — « patience ».
                GeoModel.Pose wait = model.pose("greet", 1.0f);
                p = GeoModel.blend(p, wait, 0.8f);
            } else if (corrupted) {
                // L'emprise : la main droite tendue au-dessus de lui, les doigts en griffe
                // qui tirent sur les fils.
                float pull = (float) Math.sin(t * 2.1) * 6;
                GeoModel.add(p, "arm_right", new float[]{-62 + pull, -18, 24}, null);
                GeoModel.add(p, "forearm_right", new float[]{-28 - pull, 0, 0}, null);
                for (int f = 0; f < 4; f++) {
                    float c = 38 + (float) Math.sin(t * 3 + f) * 10;
                    GeoModel.add(p, "finger_right_" + f, new float[]{c, 0, 0}, null);
                    GeoModel.add(p, "finger_right_" + f + "_tip", new float[]{c * 0.8f, 0, 0}, null);
                }
            }
            // La tête — et un peu le cou et le buste — vers ce qu'elle regarde.
            // (Bedrock : un lacet positif tourne la tête vers SA gauche, donc la droite
            // de l'écran quand elle nous fait face — d'où le signe.)
            GeoModel.add(p, "head", new float[]{pitch * 0.7f, -yaw * 0.7f, 0}, null);
            GeoModel.add(p, "neck", new float[]{pitch * 0.3f, -yaw * 0.3f, 0}, null);
            GeoModel.add(p, "chest", new float[]{lean * 7, -yaw * 0.12f, 0}, null);

            String tex = "xenodys_" + etat + (t < blinkUntil ? "_blink" : "");
            ResourceLocation map = ResourceLocation.fromNamespaceAndPath("opm", "textures/entity/" + tex + ".png");
            ResourceLocation glow = ResourceLocation.fromNamespaceAndPath("opm", "textures/entity/" + tex + "_glowmask.png");
            g.flush();
            var ps = g.pose();
            ps.pushPose();
            float jitter = corrupted && random.nextDouble() < 0.05 ? 2 : 0;
            ps.translate(cx + jitter, baseY, 300);
            // Repère du modèle (y vers le haut, visage vers −z) → écran (y vers le bas) :
            // l'axe y retourné, puis elle se tourne vers nous, un peu vers le menu.
            ps.scale(scale, -scale, scale);
            ps.mulPose(Axis.YP.rotationDegrees(turn));
            Lighting.setupForEntityInInventory();
            var buffers = g.bufferSource();
            model.render(ps, buffers.getBuffer(RenderType.entityTranslucent(map)), p, null, LightTexture.FULL_BRIGHT,
                    flicker ? 0x55FFFFFF : 0xFFFFFFFF);
            buffers.endBatch();
            if (!flicker) {
                model.render(ps, buffers.getBuffer(RenderType.eyes(glow)), p, null, LightTexture.FULL_BRIGHT, -1);
                buffers.endBatch();
            }
            Lighting.setupFor3DItems();
            ps.popPose();
        }

        // Le socle et le joueur, devant elle — en 3D, comme Xenodys.
        g.flush();
        com.mojang.blaze3d.systems.RenderSystem.clear(org.lwjgl.opengl.GL11.GL_DEPTH_BUFFER_BIT, net.minecraft.client.Minecraft.ON_OSX);
        Skins.pump();
        Skins.Printed player = Skins.own();
        float pscale = 2f;
        org.joml.Matrix4f playerWorld = null;
        GeoModel playerModel = null;
        GeoModel.Pose playerPose = null;
        {
            var ps = g.pose();
            Lighting.setupForEntityInInventory();
            var buffers = g.bufferSource();
            ps.pushPose();
            ps.translate(px, stand, 200);
            ps.scale(pscale, -pscale, pscale);
            ps.mulPose(Axis.XP.rotationDegrees(-12));
            ps.mulPose(Axis.YP.rotationDegrees(210));
            if (socleModel() != null) {
                socleModel().render(ps, buffers.getBuffer(RenderType.entityCutoutNoCull(Choreo.tex("socle_" + etat))),
                        socleModel().pose(null, 0), null, LightTexture.FULL_BRIGHT, -1);
                buffers.endBatch();
                socleModel().render(ps, buffers.getBuffer(RenderType.eyes(Choreo.tex("socle_" + etat + "_glowmask"))),
                        socleModel().pose(null, 0), null, LightTexture.FULL_BRIGHT, -1);
                buffers.endBatch();
            }
            if (player != null) {
                playerModel = playerModel(player.slim());
                if (playerModel != null) {
                    playerPose = Choreo.playerPose(playerModel, t, corrupted);
                    playerModel.render(ps, buffers.getBuffer(RenderType.entityTranslucent(player.texture())), playerPose,
                            null, LightTexture.FULL_BRIGHT, -1);
                    buffers.endBatch();
                    playerWorld = new org.joml.Matrix4f().translate(px, stand, 0).scale(pscale, -pscale, pscale)
                            .rotateX((float) Math.toRadians(-12)).rotateY((float) Math.toRadians(210));
                }
            }
            ps.popPose();
            Lighting.setupFor3DItems();
        }

        // Les fils de l'emprise : de ses doigts jusqu'à lui.
        if (corrupted && model != null && p != null && greetAt < 0 && !flicker) {
            org.joml.Matrix4f m = new org.joml.Matrix4f().translate(cx, baseY, 0).scale(scale, -scale, scale)
                    .rotateY((float) Math.toRadians(turn));
            String[] bones = {"head", "right_arm", "left_arm", "body"};
            for (int f = 0; f < 4; f++) {
                org.joml.Vector3f tip = m.transformPosition(model.point(p, "finger_right_" + f + "_tip"));
                float ex = px;
                float ey = headPlayerY + 2;
                if (playerWorld != null && playerModel != null) {
                    org.joml.Vector3f e = playerWorld.transformPosition(playerModel.point(playerPose, bones[f]).add(0, f == 0 ? 8 : -6, 0));
                    ex = e.x;
                    ey = e.y;
                }
                string(g, tip.x, tip.y, ex, ey, f);
            }
        }
    }

    /** Un fil tendu, qui ondule un peu, en pixels virtuels. */
    private void string(GuiGraphics g, float x0, float y0, float x1, float y1, int seed) {
        int n = (int) Math.max(8, Math.hypot(x1 - x0, y1 - y0));
        double sway = Math.sin(t * 2.3 + seed) * 4;
        int prevX = Integer.MIN_VALUE;
        int prevY = Integer.MIN_VALUE;
        for (int i = 0; i <= n; i++) {
            double k = i / (double) n;
            double x = x0 + (x1 - x0) * k + Math.sin(k * Math.PI) * sway;
            double y = y0 + (y1 - y0) * k + Math.sin(k * Math.PI) * 5;
            int ix = (int) Math.round(x);
            int iy = (int) Math.round(y);
            if (ix == prevX && iy == prevY) continue;
            prevX = ix;
            prevY = iy;
            double a = 0.55 + 0.35 * Math.sin(t * 8 + i * 0.3 + seed);
            g.fill(ix, iy, ix + 1, iy + 1, argb(i % 7 == 0 ? core() : accent(), a));
        }
    }

    private int wrap(GuiGraphics g, String text, int x, int y, int width, int rgb, int maxLines) {
        StringBuilder line = new StringBuilder();
        int lines = 0;
        for (String word : text.split(" ")) {
            String next = line.isEmpty() ? word : line + " " + word;
            if (PixelFont.width(next) > width && !line.isEmpty()) {
                if (++lines > maxLines) return y;
                PixelFont.draw(g, line.toString(), x, y, rgb, 0.9f, 1f);
                y += 10;
                line = new StringBuilder(word);
            } else {
                line = new StringBuilder(next);
            }
        }
        if (!line.isEmpty() && ++lines <= maxLines) {
            PixelFont.draw(g, line.toString(), x, y, rgb, 0.9f, 1f);
            y += 10;
        }
        return y;
    }

    private void drawWalker(GuiGraphics g, double dt, String etat, int from, int floor) {
        double xa = from;
        double xb = vw - 30;
        // Il entre par la gauche de l'écran, puis fait sa ronde à droite du menu.
        if (botX < 0 && botState == 0 && !entered) {
            if (botX == -1) botX = -40;
        }
        Sprites.Sheet walk = Sprites.get("bot_marche", etat);
        Sprites.Sheet fall = Sprites.get("bot_chute", etat);
        Sprites.Sheet up = Sprites.get("bot_releve", etat);
        double since = t - botAt;
        switch (botState) {
            case 0 -> {
                botX += botDir * (entered ? 14 : 26) * dt;
                if (!entered && botX >= xa) entered = true;
                if (botX > xb) botDir = -1;
                if (entered && botX < xa) botDir = 1;
                if (entered && random.nextDouble() < 0.05 * dt) {
                    botState = 1;
                    botAt = t;
                }
                Sprites.draw(g, walk, walk != null ? walk.frameAt(t) : 0, (float) botX, floor, botDir < 0, 1f, 1f);
            }
            case 1 -> {
                Sprites.draw(g, fall, fall != null ? fall.frameAt(since) : 0, (float) botX, floor, botDir < 0, 1f, 1f);
                if (fall == null || since > fall.duration() + 0.8) {
                    botState = 2;
                    botAt = t;
                }
            }
            default -> {
                Sprites.draw(g, up, up != null ? up.frameAt(since) : 0, (float) botX, floor, botDir < 0, 1f, 1f);
                if (up == null || since > up.duration()) {
                    botState = 0;
                    botAt = t;
                }
            }
        }
    }

    private void set(int i, int x, int y, int w, int h) {
        buttons[i][0] = x;
        buttons[i][1] = y;
        buttons[i][2] = w;
        buttons[i][3] = h;
    }

    private boolean inside(int i, double x, double y) {
        int[] b = buttons[i];
        return x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];
    }

    private void drawButton(GuiGraphics g, int i, String label, boolean primary) {
        int[] b = buttons[i];
        boolean on = hover == i;
        int bg = primary ? accent() : (on ? deep() : 0x0E2522);
        g.fill(b[0], b[1], b[0] + b[2], b[1] + b[3], argb(bg, primary ? (on ? 1 : 0.88) : 0.95));
        g.fill(b[0], b[1] + b[3] - 1, b[0] + b[2], b[1] + b[3], argb(primary ? deep() : accent(), on ? 1 : 0.6));
        if (on) g.fill(b[0], b[1], b[0] + 2, b[1] + b[3], argb(core(), 1));
        int text = primary ? 0x061210 : (on ? core() : 0xB8D6D2);
        PixelFont.drawCentered(g, label, b[0] + b[2] / 2f, b[1] + (b[3] - 7) / 2f, text, 1f, 1f);
    }

    @Override
    public boolean mouseClicked(double mouseX, double mouseY, int button) {
        if (button != 0) return super.mouseClicked(mouseX, mouseY, button);
        double x = vpX(mouseX);
        double y = vpY(mouseY);
        for (int i = 0; i < 4; i++) {
            if (inside(i, x, y)) {
                activate(i);
                return true;
            }
        }
        return super.mouseClicked(mouseX, mouseY, button);
    }

    @Override
    public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
        if (keyCode == GLFW.GLFW_KEY_ENTER || keyCode == GLFW.GLFW_KEY_KP_ENTER) {
            activate(0);
            return true;
        }
        return super.keyPressed(keyCode, scanCode, modifiers);
    }

    private void activate(int i) {
        minecraft.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.UI_BUTTON_CLICK, 1f));
        switch (i) {
            case 0 -> {
                if (joining) return;
                // Elle tend la main, puis le serveur.
                joining = true;
                greetAt = t;
            }
            case 1 -> minecraft.setScreen(new OptionsScreen(this, minecraft.options));
            case 2 -> minecraft.setScreen(new ModListScreen(this));
            default -> minecraft.stop();
        }
    }

    /** Le seul serveur de cet écran : One Piece Minecraft. */
    private void connect() {
        String address = session.address();
        ServerData data = new ServerData("One Piece Minecraft", address, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(this, minecraft, ServerAddress.parseString(address), data, false, null);
    }

    @Override
    public boolean shouldCloseOnEsc() {
        return false;
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    @Override
    public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        // Le fond, c'est la salle de simulation : rien à flouter.
    }

    @Override
    public void removed() {
        lab.close();
    }
}
