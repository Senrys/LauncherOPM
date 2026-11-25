package fr.onepieceminecraft.opm.client;

import net.minecraft.client.gui.GuiGraphics;

/**
 * Le style « circuit » d'OPMTech pour les cadres 2D : métal, fond sombre uni,
 * broches dorées sur un bord, pistes parcourues d'impulsions.
 */
final class Terminal {
    static final int GOLD = 0xD3AE59;
    static final int GOLD_LIGHT = 0xF2DC9A;
    static final int TEXT = 0xE4F6F4;
    static final int PALE = 0x8FB8B6;
    static final int DIM = 0x4E6E70;

    private Terminal() {}

    static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a * Sprites.alpha)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    static int accent(boolean corrupted) {
        return corrupted ? 0xF0506E : 0x91D9D1;
    }

    static int core(boolean corrupted) {
        return corrupted ? 0xFFD3DD : 0xE9FFFC;
    }

    static int trace(boolean corrupted) {
        return corrupted ? 0x8E3AB0 : 0x2E7F72;
    }

    /** Un cadre ; `title` facultatif. Renvoie l'ordonnée du contenu. */
    static int frame(GuiGraphics g, int x0, int y0, int x1, int y1, boolean corrupted, String title, double a) {
        int[][] rings = {{0x0A0F13, 3}, {0x6A7688, 2}, {0x12161D, 1}};
        for (int[] r : rings) {
            for (int[] e : new int[][]{{x0, y0, x1, y0 + r[1]}, {x0, y1 - r[1], x1, y1}, {x0, y0 + r[1], x0 + r[1], y1 - r[1]},
                    {x1 - r[1], y0 + r[1], x1, y1 - r[1]}}) {
                g.fill(e[0], e[1], e[2], e[3], argb(r[0], a));
            }
            x0 += r[1];
            y0 += r[1];
            x1 -= r[1];
            y1 -= r[1];
        }
        g.fill(x0, y0, x1, y1, argb(0x0A1216, 0.95 * a));
        for (int y = y0 + 6; y < y1 - 5; y += 6) g.fill(x0 - 6, y, x0 - 3, y + 2, argb(GOLD, a));
        if (title == null) return y0;
        g.fill(x0, y0, x1, y0 + 14, argb(corrupted ? 0x2A1226 : 0x13262C, a));
        g.fill(x0, y0 + 14, x1, y0 + 15, argb(accent(corrupted), 0.6 * a));
        PixelFont.draw(g, title, x0 + 6, y0 + 4, core(corrupted), (float) a, 1f);
        return y0 + 15;
    }

    /** Une piste à angles droits (points : x, y, x, y…), parcourue d'impulsions. */
    static void trace(GuiGraphics g, boolean corrupted, double t, double a, int... pts) {
        int walked = 0;
        double head = (t * 32) % 46;
        for (int i = 0; i + 3 < pts.length; i += 2) {
            int dx = Integer.signum(pts[i + 2] - pts[i]);
            int dy = Integer.signum(pts[i + 3] - pts[i + 1]);
            int x = pts[i];
            int y = pts[i + 1];
            while (x != pts[i + 2] || y != pts[i + 3]) {
                g.fill(x, y, x + 1, y + 1, argb(trace(corrupted), a));
                double q = ((head - walked) % 46 + 46) % 46;
                if (q < 7) g.fill(x, y, x + 1, y + 1, argb(q < 1 ? core(corrupted) : accent(corrupted), a * (1 - q * 0.14)));
                x += dx;
                y += dy;
                walked++;
            }
        }
        for (int i : new int[]{0, pts.length - 2}) g.fill(pts[i] - 1, pts[i + 1] - 1, pts[i] + 2, pts[i + 1] + 2, argb(GOLD, a));
    }

    /** Une ligne de menu : `hover` de 0 à 1 ; `primary` : la ligne dorée. */
    static void line(GuiGraphics g, int x, int y, int w, int h, String label, boolean corrupted, boolean primary, double hover, double a) {
        int bg = primary ? (corrupted ? 0x2A1220 : 0x1C2418) : corrupted ? 0x1C0E1A : 0x101D22;
        g.fill(x, y, x + w, y + h, argb(bg, 0.96 * a));
        int edge = primary ? GOLD_LIGHT : trace(corrupted);
        // La lueur gagne depuis le filet gauche.
        int lit = (int) Math.round(w * hover);
        if (lit > 0) {
            g.fill(x, y, x + lit, y + h, argb(primary ? GOLD_LIGHT : accent(corrupted), 0.16 * a));
            g.fill(x, y + h - 1, x + lit, y + h, argb(primary ? GOLD_LIGHT : accent(corrupted), 0.8 * a));
        }
        g.fill(x, y, x + 2, y + h, argb(hover > 0.5 ? core(corrupted) : edge, a));
        int pad = x + w - 8;
        g.fill(pad, y + h / 2 - 1, pad + 3, y + h / 2 + 2, argb(primary || hover > 0.5 ? GOLD : 0x1F4A4A, a));
        PixelFont.draw(g, label, x + 10 + (float) (2 * hover), y + (h - 7) / 2f, primary ? GOLD_LIGHT : hover > 0.5 ? core(corrupted) : TEXT,
                (float) a, 1f);
    }
}
