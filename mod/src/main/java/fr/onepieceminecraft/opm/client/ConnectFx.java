package fr.onepieceminecraft.opm.client;

import java.util.Random;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;

/**
 * L'écran de connexion au serveur, comme la cinématique du launcher : le
 * joueur, sur son socle, se défait en pixels qui filent vers un orbe ; l'orbe
 * attend, un anneau tourne autour, jusqu'à l'entrée dans le monde.
 * Dessiné sous le texte et le bouton de l'écran (ScreenEvent.BackgroundRendered).
 */
public final class ConnectFx {
    private static Screen current;
    private static long start;
    private static float[] seeds;

    private ConnectFx() {}

    private static double ease(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    public static void render(Screen screen, GuiGraphics g) {
        if (screen != current) {
            current = screen;
            start = Util.getMillis();
        }
        double t = (Util.getMillis() - start) / 1000.0;
        Minecraft mc = Minecraft.getInstance();
        var window = mc.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        OpmSession session = OpmSession.get();
        String etat = session.etat;
        int accent = session.corrupted() ? 0xF0506E : 0x91D9D1;
        int core = session.corrupted() ? 0xFFD3DD : 0xE9FFFC;

        g.pose().pushPose();
        g.pose().scale(s, s, 1);
        float px = vw * 0.5f;
        float stand = vh * 0.86f;
        float ox = vw * 0.5f;
        float oy = vh * 0.24f;
        Sprites.draw(g, Sprites.get("socle", etat), 0, px, stand);

        // Le joueur se défait de haut en bas : chaque pixel parti file vers l'orbe.
        int[] pixels = Skins.ownPixels();
        double cut = ease((t - 0.3) / 1.4);
        if (pixels != null) {
            int W = PlayerRaster.W;
            int H = PlayerRaster.H;
            int rows = (int) Math.round((1 - cut) * H);
            if (rows > 0 && Skins.own() != null) {
                LoadingScene.drawPlayer(g, Skins.own(), px, stand, rows, 1f, 0);
            }
            if (seeds == null) {
                Random r = new Random(7);
                seeds = new float[W * H];
                for (int i = 0; i < seeds.length; i++) seeds[i] = r.nextFloat();
            }
            float d = PlayerRaster.DENSITY;
            for (int y = 0; y < H; y += 2) {
                double leftAt = (y / (double) H) * 1.4 + 0.3;
                double q = (t - leftAt) / 0.9;
                if (q <= 0 || q >= 1) continue;
                for (int x = 0; x < W; x += 2) {
                    int c = pixels[y * W + x];
                    if (((c >>> 24) & 255) < 128) continue;
                    float sd = seeds[y * W + x];
                    double qq = ease(q * (0.8 + sd * 0.4));
                    double sx = px - PlayerRaster.OX / d + x / d;
                    double sy = stand - PlayerRaster.OY / d + y / d;
                    double bend = Math.sin(qq * Math.PI) * (sd - 0.5) * 50;
                    double fx = sx + (ox - sx) * qq + bend;
                    double fy = sy + (oy - sy) * qq - Math.sin(qq * Math.PI) * 20;
                    int rgb = ((c & 255) << 16) | (c & 0xFF00) | ((c >> 16) & 255);
                    int col = qq > 0.7 ? accent : rgb;
                    g.fill((int) fx, (int) fy, (int) fx + 1, (int) fy + 1, argb(col, 1 - qq * 0.3));
                }
            }
        }

        // L'orbe, puis l'anneau qui tourne : le monde se prépare.
        double grow = ease((t - 0.6) / 1.6);
        int r = (int) Math.round(2 + 9 * grow + Math.sin(t * 4) * grow);
        for (int yy = -r; yy <= r; yy++) {
            for (int xx = -r; xx <= r; xx++) {
                double dist = Math.sqrt(xx * xx + yy * yy);
                if (dist > r) continue;
                int col = dist < r * 0.45 ? core : accent;
                g.fill((int) ox + xx, (int) oy + yy, (int) ox + xx + 1, (int) oy + yy + 1, argb(col, grow * (1 - dist / (r + 1) * 0.5)));
            }
        }
        if (t > 2.0) {
            int n = 40;
            for (int i = 0; i < n; i++) {
                double a = i / (double) n * Math.PI * 2 + t * 2.4;
                double on = (i + (int) (t * 10)) % 5 == 0 ? 1 : 0.35;
                int x = (int) Math.round(ox + Math.cos(a) * (r + 7));
                int y = (int) Math.round(oy + Math.sin(a) * (r + 7));
                g.fill(x, y, x + 1, y + 1, argb(i % 5 == 0 ? core : accent, on * Math.min(1, (t - 2.0) * 2)));
            }
        }
        g.pose().popPose();
    }
}
