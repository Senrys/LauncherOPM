package fr.onepieceminecraft.opm.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;

/**
 * L'écran de chargement : le laboratoire de Xenodys (client/LabScene), qui
 * s'assemble au fil du chargement, et la barre. Le chargement fini, la cuve se
 * vide et descend dans la plateforme, et la caméra glisse vers le menu : l'écran
 * titre reprend la même salle, au même instant.
 *
 * La même scène que celle du launcher (components/loadingScene.js), à la même
 * horloge : d'une fenêtre à l'autre, rien ne saute.
 */
public final class LoadingScene {
    /** Durée du passage au menu. */
    public static final double OUTRO = 3.6;

    private final Lab lab = new Lab();
    private final LabScene scene = LabScene.get();
    private final LabScene.View view = new LabScene.View();
    private double last = -1;

    /**
     * @param vw, vh  la scène en pixels virtuels (l'interface 2D)
     * @param t       horloge de la scène (secondes, partagée avec le launcher)
     * @param ratio   avancement global, 0 → 1
     * @param step    étape affichée sous la barre
     * @param first   premier chargement : la salle s'assemble
     * @param outro   secondes depuis la fin du chargement, ou négatif
     */
    public void render(GuiGraphics g, int vw, int vh, double t, float ratio, String step, String etat, boolean first,
                       double outro, String playerName) {
        double dt = last < 0 ? 0 : Math.max(0, Math.min(0.1, t - last));
        last = t;
        boolean corrupted = "corrompue".equals(etat);
        lab.render(g, vw, vh, dt, etat, 1f);

        // La scène 3D, à la résolution de l'écran.
        g.flush();
        var window = Minecraft.getInstance().getWindow();
        if (Sprites.alpha > 0.02f) {
            view.etat = etat;
            view.assemble = first;
            view.ratio = outro >= 0 ? 1 : ratio;
            view.drain = (float) LabScene.seg(outro, 0.3, 1.4);
            view.tankDown = (float) LabScene.seg(outro, 1.1, 2.5);
            view.menu = (float) LabScene.seg(outro, 1.5, 3.5);
            scene.render(window.getWidth(), window.getHeight(), t, view);
        }

        // La barre et son étape.
        double a = outro >= 0 ? 1 - LabScene.seg(outro, 1.4, 1.9) : 1;
        if (a > 0.01) {
            int w = Math.min(Math.round(vw * 0.62f), 300);
            int x0 = (vw - w) / 2;
            int y0 = vh - 42;
            Terminal.frame(g, x0, y0, x0 + w, y0 + 34, corrupted, null, a);
            float shownRatio = outro >= 0 ? 1f : Math.max(0, Math.min(1, ratio));
            String label = outro >= 0 ? (playerName != null ? "Bienvenue, " + playerName : "Bienvenue") : step;
            PixelFont.draw(g, label, x0 + 13, y0 + 10, Terminal.TEXT, (float) a, 1f);
            String pct = Math.round(shownRatio * 100) + " %";
            PixelFont.draw(g, pct, x0 + w - 13 - PixelFont.width(pct), y0 + 10, Terminal.accent(corrupted), (float) a, 1f);
            int segs = (w - 26) / 6;
            int lit = (int) Math.floor(shownRatio * segs);
            for (int i = 0; i < segs; i++) {
                int x = x0 + 13 + i * 6;
                int c = i < lit - 1 ? Terminal.accent(corrupted) : i == lit - 1 ? Terminal.core(corrupted) : corrupted ? 0x3A1A34 : 0x1F4A4A;
                // Une impulsion court sur la barre.
                boolean pulse = i < lit && Math.abs(i - (t * 26) % (segs + 30)) < 1.5;
                g.fill(x, y0 + 21, x + 4, y0 + 26, Terminal.argb(pulse ? Terminal.core(corrupted) : c, a));
            }
        }
    }

    public void close() {
        lab.close();
    }
}
