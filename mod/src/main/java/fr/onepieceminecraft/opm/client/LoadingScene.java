package fr.onepieceminecraft.opm.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;

/**
 * L'écran de chargement : la salle de simulation en fond (pixel art), la scène
 * 3D de Xenodys au milieu (client/Choreo), le bandeau, la barre et son étape
 * par-dessus. Le chargement fini, Xenodys s'envole (`outro`), le joueur
 * s'imprime sur son circuit, et le monde s'ouvre dans un éclair.
 *
 * La même composition que la scène du launcher (launcher/src/assets/js/
 * components/loadingScene.js), à la même horloge : d'une fenêtre à l'autre,
 * rien ne saute.
 */
public final class LoadingScene {
    /** Durée de l'envol, jusqu'à l'ouverture du monde. */
    public static final double OUTRO = 3.8;

    private final Lab lab = new Lab();
    private final Choreo choreo = new Choreo();
    private double last = -1;

    private static double seg(double t, double a, double b) {
        return Math.max(0, Math.min(1, (t - a) / (b - a)));
    }

    private static double ease(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    private static int accent(String etat) {
        return "corrompue".equals(etat) ? 0xF0506E : 0x91D9D1;
    }

    private static int core(String etat) {
        return "corrompue".equals(etat) ? 0xFFD3DD : 0xE9FFFC;
    }

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a * Sprites.alpha)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    /**
     * @param vw, vh  la scène en pixels virtuels (l'interface 2D)
     * @param t       horloge de la scène (secondes, partagée avec le launcher)
     * @param ratio   avancement global, 0 → 1
     * @param step    étape affichée sous la barre
     * @param outro   secondes depuis la fin du chargement, ou négatif
     */
    public void render(GuiGraphics g, int vw, int vh, double t, float ratio, String step, String etat,
                       double outro, String playerName) {
        double dt = last < 0 ? 0 : Math.max(0, Math.min(0.1, t - last));
        last = t;
        Skins.pump();
        boolean corrupted = "corrompue".equals(etat);
        lab.render(g, vw, vh, dt, etat, 1f);

        // La scène 3D, à la résolution de l'écran.
        g.flush();
        var window = Minecraft.getInstance().getWindow();
        if (Sprites.alpha > 0.02f) {
            choreo.render(window.getWidth(), window.getHeight(), t, ratio, etat, outro);
        }

        // Le bandeau.
        Sprites.Sheet banner = Sprites.get(corrupted ? "bandeau_240_corrompue" : "bandeau_240");
        if (banner != null) Sprites.draw(g, banner, 0, 12, 10, false, 1f, 0.5f);

        // La barre et son étape.
        float mx = vw * 0.5f;
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
            PixelFont.drawCentered(g, "Bienvenue, " + playerName, mx, vh * 0.16f, core(etat), (float) a, 2f);
        }

        // L'ouverture du monde.
        if (outro >= 3.0) {
            g.fill(0, 0, vw, vh, argb(core(etat), ease(seg(outro, 3.0, OUTRO))));
        }
    }

    public void close() {
        lab.close();
    }
}
