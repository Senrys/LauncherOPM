package fr.onepieceminecraft.opm.client;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import net.minecraft.client.gui.GuiGraphics;

/**
 * La scène de chargement : Xenodys façonne le monde dans la salle de
 * simulation, ses assistants impriment des joueurs, la barre avance — puis,
 * le chargement fini, elle s'envole (`outro`).
 *
 * La même composition que la scène du launcher (launcher/src/assets/js/
 * components/loadingScene.js), au pixel virtuel près : d'une fenêtre à
 * l'autre, rien ne bouge.
 */
public final class LoadingScene {
    /** Durée de l'envol, jusqu'à l'ouverture du monde. */
    public static final double OUTRO = 3.8;

    private static final int N = 4;
    private static final double PRINT_CYCLE = 3.4;

    private final Lab lab = new Lab();
    private final Random random = new Random();
    private final List<int[]> blocks = new ArrayList<>();
    private final double[] shownAt = new double[N * N * N];
    private int shown;
    private double t;

    // L'imprimante.
    private int printIndex = -1;
    private double printStart;

    // L'assistant qui patrouille (B) : 0 marche, 1 chute, 2 au sol, 3 se relève.
    private int bState;
    private double bStateAt;
    private double bX = -1;
    private int bDir = 1;
    private final boolean outroFall;

    // Le clignement de Xenodys.
    private double nextBlink = 2.5;
    private double blinkUntil;

    public LoadingScene() {
        for (int k = 0; k < N; k++) {
            for (int s = 0; s <= 2 * (N - 1); s++) {
                for (int i = 0; i < N; i++) {
                    int j = s - i;
                    if (j >= 0 && j < N) blocks.add(new int[]{i, j, k});
                }
            }
        }
        outroFall = random.nextBoolean();
    }

    private static double ease(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    private static double seg(double t, double a, double b) {
        return Math.max(0, Math.min(1, (t - a) / (b - a)));
    }

    private static int accent(String etat) {
        return "corrompue".equals(etat) ? 0xF0506E : 0x91D9D1;
    }

    private static int core(String etat) {
        return "corrompue".equals(etat) ? 0xFFD3DD : 0xE9FFFC;
    }

    private static int deep(String etat) {
        return "corrompue".equals(etat) ? 0x6A1F8F : 0x1D5C51;
    }

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a * Sprites.alpha)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    /**
     * @param ratio  avancement global, 0 → 1
     * @param step   étape affichée sous la barre
     * @param outro  secondes depuis la fin du chargement, ou négatif
     */
    public void render(GuiGraphics g, int vw, int vh, double dt, float ratio, String step, String etat,
                       double outro, String playerName) {
        t += dt;
        Skins.pump();
        boolean corrupted = "corrompue".equals(etat);
        lab.render(g, vw, vh, dt, etat, 1f);

        float mx = vw * 0.5f;
        float my = vh * 0.47f;
        float floor = vh * 0.88f;

        // ------------------------------------------------------------ Xenodys
        Sprites.Sheet body = Sprites.get("xen_faconne", etat);
        Sprites.Sheet blink = Sprites.get("xen_faconne_" + etat + "_blink");
        Sprites.Sheet hands = Sprites.get("xen_faconne_mains", etat);
        Sprites.Sheet fly = Sprites.get("xen_envol", etat);
        float xOrigin = mx;
        float yOrigin = my;
        if (body != null) {
            var p = body.points().getAsJsonArray("monde");
            xOrigin = mx - (p.get(0).getAsInt() - body.ox()) / (float) body.density();
            yOrigin = my - (p.get(1).getAsInt() - body.oy()) / (float) body.density();
        }
        if (t > nextBlink) {
            blinkUntil = t + 0.14;
            nextBlink = t + 2.5 + random.nextDouble() * 3.5;
        }
        float jitter = corrupted && random.nextDouble() < 0.08 ? (random.nextBoolean() ? 2 : -2) : 0;
        boolean flying = outro >= 0.35;
        int frame = body != null ? body.frameAt(t) : 0;
        if (!flying) {
            if (t < blinkUntil && blink != null) {
                // Le clignement : l'image de la planche des yeux clos la plus proche.
                Sprites.draw(g, blink, Math.min(blink.frames() - 1, frame * blink.frames() / Math.max(1, body.frames())), xOrigin + jitter, yOrigin);
            } else {
                Sprites.draw(g, body, frame, xOrigin + jitter, yOrigin);
            }
        } else if (fly != null) {
            double o = outro - 0.35;
            float rise = (float) (o * o * 150 + o * 20);
            Sprites.draw(g, fly, fly.frameAt(o), xOrigin + jitter, yOrigin - rise, false, 1f, 1f);
        }

        // ----------------------------------------------------------- le monde
        int target = outro >= 0 ? blocks.size() : (int) Math.floor(Math.max(0, Math.min(1, ratio)) * blocks.size());
        while (shown < target) shownAt[shown++] = t;
        Sprites.Sheet block = Sprites.get("bloc", etat);
        double glow = outro >= 0 ? 0.5 + 0.5 * Math.sin(outro * 9) : 0;
        for (int n = 0; n < shown; n++) {
            int[] b = blocks.get(n);
            float bx = mx + (b[0] - b[1]) * 6;
            float by = my - 5 + (b[0] + b[1]) * 3 - b[2] * 7 - 6;
            Sprites.draw(g, block, 0, bx, by);
            double fresh = 1 - (t - shownAt[n]) / 0.35;
            double a = Math.max(fresh, glow * 0.35);
            if (a > 0) {
                g.fill((int) bx - 5, (int) by - 5, (int) bx + 5, (int) by + 5, argb(core(etat), a * 0.8));
            }
        }
        if (!flying) Sprites.draw(g, hands, frame, xOrigin + jitter, yOrigin);

        // ------------------------------------------------- l'imprimante : le socle
        float px = vw * 0.24f;
        Sprites.Sheet socle = Sprites.get("socle", etat);
        Sprites.draw(g, socle, 0, px, floor - 6);
        // Le dessus du socle, où se posent les pieds.
        float stand = floor - 6;
        List<Skins.Printed> gallery = Skins.gallery();
        Skins.Printed own = Skins.own();
        if (outro >= 0.4 && own != null) {
            drawPrint(g, own, px, stand, outro - 0.4, etat, true);
        } else if (outro < 0 && !gallery.isEmpty()) {
            if (printIndex < 0 || t - printStart > PRINT_CYCLE) {
                printIndex = (printIndex + 1) % gallery.size();
                printStart = t;
            }
            drawPrint(g, gallery.get(printIndex % gallery.size()), px, stand, t - printStart, etat, false);
            drawBeam(g, px, stand, mx, my, t - printStart, etat);
        }

        // ---------------------------------------------------- les assistants
        // A : à l'imprimante.
        float ax = px - 44;
        if (outro < 0.3) {
            Sprites.draw(g, Sprites.get("bot_travail", etat), Sprites.get("bot_travail", etat) != null
                    ? Sprites.get("bot_travail", etat).frameAt(t) : 0, ax, floor, false, 1f, 1f);
        } else if (outro < 1.6) {
            Sprites.Sheet wave = Sprites.get("bot_salut", etat);
            Sprites.draw(g, wave, wave != null ? wave.frameAt(outro - 0.3) : 0, ax, floor, false, 1f, 1f);
        } else {
            Sprites.Sheet walk = Sprites.get("bot_marche", etat);
            Sprites.draw(g, walk, walk != null ? walk.frameAt(outro) : 0, ax - (float) (outro - 1.6) * 40, floor, true, 1f, 1f);
        }
        // B : patrouille, et parfois trébuche.
        drawPatrol(g, vw, floor, dt, etat, outro);

        // ------------------------------------------------- bandeau et barre
        Sprites.Sheet banner = Sprites.get(corrupted ? "bandeau_240_corrompue" : "bandeau_240");
        if (banner != null) Sprites.draw(g, banner, 0, 12, 10, false, 1f, 0.5f);

        float bw = Math.min(vw * 0.46f, 240);
        float bx0 = mx - bw / 2;
        float by0 = vh - 16;
        float shownRatio = outro >= 0 ? 1f : Math.max(0, Math.min(1, ratio));
        g.fill((int) bx0 - 1, (int) by0 - 1, (int) (bx0 + bw) + 1, (int) by0 + 5, argb(0x000000, 0.55));
        g.fill((int) bx0 - 1, (int) by0 - 1, (int) (bx0 + bw) + 1, (int) by0, argb(accent(etat), 0.5));
        int segs = (int) (bw / 4);
        int lit = (int) Math.floor(shownRatio * segs);
        for (int i = 0; i < lit; i++) {
            int x0 = (int) bx0 + i * 4;
            g.fill(x0, (int) by0 + 1, x0 + 3, (int) by0 + 4, argb(i == lit - 1 ? core(etat) : accent(etat), 1));
        }
        String label = outro >= 0 ? (corrupted ? "Le monde vous attend… sous contrôle" : "Xenodys vous ouvre le monde") : step;
        PixelFont.draw(g, label, bx0, by0 - 11, core(etat), 0.95f, 1f);
        String pct = Math.round(shownRatio * 100) + " %";
        PixelFont.draw(g, pct, bx0 + bw - PixelFont.width(pct), by0 - 11, accent(etat), 0.95f, 1f);

        if (outro >= 0.8 && playerName != null) {
            double a = seg(outro, 0.8, 1.3) * (1 - seg(outro, 3.0, 3.5));
            PixelFont.drawCentered(g, "Bienvenue, " + playerName, mx, vh * 0.66f, core(etat), (float) a, 2f);
        }

        // ------------------------------------------- l'ouverture du monde
        if (outro >= 3.0) {
            double a = ease(seg(outro, 3.0, OUTRO));
            g.fill(0, 0, vw, vh, argb(core(etat), a));
        }
    }

    /**
     * Un joueur imprimé, debout sur son socle de circuit imprimé : il apparaît
     * par le bas (une ligne de balayage), vit un instant — il respire, regarde
     * autour de lui —, puis monte rejoindre le monde.
     */
    private void drawPrint(GuiGraphics g, Skins.Printed skin, float cx, float base, double p, String etat, boolean own) {
        double reveal = ease(p / 1.8);
        double leave = own ? 0 : seg(p, 2.5, 3.3);
        int rows = (int) Math.round(reveal * PlayerRaster.H);
        if (rows <= 0) return;
        float alpha = (float) (1 - leave);
        float lift = (float) (leave * 12);
        drawPlayer(g, skin, cx, base - lift, rows, alpha, t);
        if (reveal < 1) {
            int y = (int) (base - PlayerRaster.OY / (float) PlayerRaster.DENSITY + (PlayerRaster.H - rows) / (float) PlayerRaster.DENSITY);
            g.fill((int) cx - 14, y - 1, (int) cx + 14, y, argb(core(etat), 0.95));
            g.fill((int) cx - 14, y, (int) cx + 14, y + 1, argb(accent(etat), 0.6));
        }
    }

    /**
     * Le joueur en volume (client/PlayerRaster), les pieds en (cx, base) ; seules
     * les `rows` dernières lignes de l'image (le bas) sont dessinées.
     */
    static void drawPlayer(GuiGraphics g, Skins.Printed skin, float cx, float base, int rows, float alpha, double t) {
        int frame = (int) Math.floor(t * PlayerRaster.FPS) % PlayerRaster.FRAMES;
        int from = PlayerRaster.H - rows;
        float d = PlayerRaster.DENSITY;
        var pose = g.pose();
        pose.pushPose();
        pose.translate(cx - PlayerRaster.OX / d, base - PlayerRaster.OY / d + from / d, 0);
        pose.scale(1 / d, 1 / d, 1);
        Sprites.drawTexture(g, skin.texture(), 0, 0, PlayerRaster.W, rows, frame * PlayerRaster.W, from,
                PlayerRaster.W, rows, PlayerRaster.W * PlayerRaster.FRAMES, PlayerRaster.H, alpha);
        pose.popPose();
    }

    /** Le joueur imprimé rejoint le monde : des pixels qui filent vers le cube. */
    private void drawBeam(GuiGraphics g, float x0, float y0, float x1, float y1, double p, String etat) {
        if (p < 2.5 || p > 3.4) return;
        double k = seg(p, 2.5, 3.4);
        for (int i = 0; i < 10; i++) {
            double q = Math.max(0, Math.min(1, k * 1.4 - i * 0.04));
            if (q <= 0 || q >= 1) continue;
            double x = x0 + (x1 - x0) * q;
            double y = (y0 - 32) + (y1 - (y0 - 32)) * q - Math.sin(q * Math.PI) * 30;
            g.fill((int) x - 1 + (i % 3) - 1, (int) y - 1, (int) x + 1 + (i % 3) - 1, (int) y + 1, argb(i < 2 ? core(etat) : accent(etat), 1 - q * 0.5));
        }
    }

    private void drawPatrol(GuiGraphics g, int vw, float floor, double dt, String etat, double outro) {
        float xa = vw * 0.64f;
        float xb = vw * 0.86f;
        // Il entre par la droite de l'écran, puis fait sa ronde.
        if (bX < 0) {
            bX = vw + 40;
            bDir = -1;
        }
        boolean entering = bX > xb + 1;
        Sprites.Sheet walk = Sprites.get("bot_marche", etat);
        Sprites.Sheet fall = Sprites.get("bot_chute", etat);
        Sprites.Sheet up = Sprites.get("bot_releve", etat);
        double since = t - bStateAt;
        if (outro >= 0 && outro < dt + 0.001 && bState == 0 && outroFall) {
            // L'envol : un assistant, ébloui, trébuche.
            bState = 1;
            bStateAt = t;
            since = 0;
        }
        switch (bState) {
            case 0 -> {
                double speed = outro >= 0 ? 40 : entering ? 26 : 14;
                bX += bDir * speed * dt;
                if (outro < 0) {
                    if (bX > xb && !entering) bDir = -1;
                    if (bX < xa) bDir = 1;
                    if (!entering && random.nextDouble() < 0.06 * dt) {
                        bState = 1;
                        bStateAt = t;
                    }
                } else {
                    bDir = 1;
                }
                Sprites.draw(g, walk, walk != null ? walk.frameAt(t) : 0, (float) bX, floor, bDir < 0, 1f, 1f);
            }
            case 1 -> {
                Sprites.draw(g, fall, fall != null ? fall.frameAt(since) : 0, (float) bX, floor, bDir < 0, 1f, 1f);
                if (fall == null || since >= fall.duration()) {
                    bState = 2;
                    bStateAt = t;
                }
            }
            case 2 -> {
                Sprites.draw(g, fall, fall != null ? fall.frames() - 1 : 0, (float) bX, floor, bDir < 0, 1f, 1f);
                if (since >= 0.7) {
                    bState = 3;
                    bStateAt = t;
                }
            }
            default -> {
                Sprites.draw(g, up, up != null ? up.frameAt(since) : 0, (float) bX, floor, bDir < 0, 1f, 1f);
                if (up == null || since >= up.duration()) {
                    bState = 0;
                    bStateAt = t;
                }
            }
        }
    }

    public void close() {
        lab.close();
    }
}
