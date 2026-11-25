package fr.onepieceminecraft.opm.client;

import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;

/**
 * L'écran de connexion au serveur : dans le laboratoire, une porte s'ouvre en
 * iris de gros pixels — le champ des portes d'OPMTech — et ondule jusqu'à
 * l'entrée dans le monde. Dessiné sous le texte et le bouton de l'écran
 * (ScreenEvent.BackgroundRendered).
 */
public final class ConnectFx {
    private static final int CELL = 6;
    private static Screen current;
    private static long start;

    private ConnectFx() {}

    public static void render(Screen screen, GuiGraphics g) {
        if (screen != current) {
            current = screen;
            start = Util.getMillis();
        }
        double t = (Util.getMillis() - start) / 1000.0;
        var window = Minecraft.getInstance().getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        boolean corrupted = OpmSession.get().corrupted();
        int accent = Terminal.accent(corrupted);
        int core = Terminal.core(corrupted);

        g.pose().pushPose();
        g.pose().scale(s, s, 1);
        double open = LabScene.ease(t / 1.1);
        double ox = vw / 2.0;
        double oy = vh * 0.44;
        double radius = Math.min(vw * 0.4, vh * 0.36) * open;
        int n = (int) Math.ceil(radius / CELL) + 2;
        double ticks = t * 20;
        for (int cy = -n; cy <= n; cy++) {
            for (int cx = -n; cx <= n; cx++) {
                double px = (cx + 0.5) * CELL;
                double py = (cy + 0.5) * CELL;
                double dist = Math.hypot(px, py);
                // Un bord dentelé, qui respire.
                double angle = Math.atan2(py, px);
                double edge = radius + Math.sin(angle * 6 + ticks * 0.05) * 3;
                if (dist > edge) continue;
                int x = (int) (ox + cx * CELL);
                int y = (int) (oy + cy * CELL);
                if (dist > edge - CELL * 1.1) {
                    g.fill(x, y, x + CELL, y + CELL, Terminal.argb(core, 0.9));
                    continue;
                }
                double d = dist / (radius + 1) * 3.2;
                double wave = 0.5 + 0.5 * Math.sin(4.2 * d - 0.22 * ticks + 0.8 * Math.sin(6 * angle + 0.05 * ticks));
                double rim = LabScene.seg(dist / (radius + 1), 0.45, 1);
                g.fill(x, y, x + CELL, y + CELL, Terminal.argb(0x05080C, 0.78));
                g.fill(x, y, x + CELL, y + CELL, Terminal.argb(accent, (0.05 + 0.45 * rim) * Math.round(wave * 4) / 4.0));
            }
        }
        // Les repères de calage, qui tournent autour.
        if (open > 0.6) {
            for (int i = 0; i < 24; i++) {
                double a = i * Math.PI / 12 + t * 0.5;
                int x = (int) Math.round(ox + Math.cos(a) * (radius + 14));
                int y = (int) Math.round(oy + Math.sin(a) * (radius + 14));
                boolean hot = (i + (int) (t * 8)) % 6 == 0;
                g.fill(x - 1, y - 1, x + 2, y + 2, Terminal.argb(hot ? core : i % 6 == 0 ? Terminal.GOLD : accent, (open - 0.6) * 2.5 * (hot ? 1 : 0.5)));
            }
        }
        g.pose().popPose();
    }
}
