package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.NativeImage;
import fr.onepieceminecraft.opm.Opm;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;

/**
 * La salle de simulation : le fond du launcher (launcher/src/assets/js/
 * components/lab.js), porté tel quel — sol quadrillé en perspective, mur de
 * calibration, impulsions de données, balayage, repères. Une cellule par pixel
 * virtuel de la scène ; l'image est recalculée 30 fois par seconde dans une
 * texture dynamique.
 */
public final class Lab {
    private static final double G = 2.5;
    private static final int[] BAYER = {0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5};

    private record Palette(int[] top, int[] horizon, int[] floor, int[] minor, int[] major, int[] bright,
                           int[] core, int[] scan) {}

    private static final Palette CREATRICE = new Palette(
            new int[]{4, 11, 10}, new int[]{9, 30, 27}, new int[]{6, 17, 16}, new int[]{28, 88, 78},
            new int[]{52, 150, 135}, new int[]{145, 217, 209}, new int[]{233, 255, 252}, new int[]{145, 217, 209});
    private static final Palette CORROMPUE = new Palette(
            new int[]{11, 4, 10}, new int[]{34, 10, 30}, new int[]{16, 6, 15}, new int[]{86, 26, 80},
            new int[]{150, 44, 132}, new int[]{240, 80, 110}, new int[]{255, 211, 221}, new int[]{255, 60, 80});

    private static int instances;
    /** Une texture par salle : l'écran de chargement et l'écran titre en ont chacun une. */
    private final ResourceLocation ID = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/lab_" + (instances++));

    private final Random random = new Random();
    private DynamicTexture texture;
    private int w;
    private int h;
    private double clock;
    private double acc;
    private double nextPulse = 0.5;
    private Double scan;
    private double nextScan = 3;
    private final List<double[]> pulses = new ArrayList<>(); // vertical, line, pos, dir, speed, len

    private static double bayer(int x, int y) {
        return (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16.0;
    }

    private static double hash(int a, int b, int c) {
        int h = a * 374761393 + b * 668265263 + c * 2147483647;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) & 0xFFFFFFFFL) / 4294967296.0;
    }

    private static int[] mix(int[] a, int[] b, double k) {
        return new int[]{(int) Math.round(a[0] + (b[0] - a[0]) * k), (int) Math.round(a[1] + (b[1] - a[1]) * k),
                (int) Math.round(a[2] + (b[2] - a[2]) * k)};
    }

    /** NativeImage attend de l'ABGR. */
    private static int pack(int[] c) {
        return 0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0];
    }

    private void resize(int nw, int nh) {
        if (texture != null && nw == w && nh == h) return;
        w = Math.max(1, nw);
        h = Math.max(1, nh);
        if (texture != null) texture.close();
        texture = new DynamicTexture(new NativeImage(NativeImage.Format.RGBA, w, h, false));
        Minecraft.getInstance().getTextureManager().register(ID, texture);
    }

    /**
     * Avance et dessine le fond sur toute la scène.
     * @param vw largeur de la scène, en pixels virtuels
     * @param vh hauteur
     * @param dt secondes écoulées
     */
    public void render(GuiGraphics g, int vw, int vh, double dt, String etat, float alpha) {
        resize(vw, vh);
        acc += dt;
        if (acc >= 1 / 30.0 || clock == 0) {
            step(acc, etat);
            draw(etat);
            texture.upload();
            acc = 0;
        }
        Sprites.drawTexture(g, ID, 0, 0, w, h, 0, 0, w, h, w, h, alpha);
    }

    private void step(double dt, String etat) {
        clock += dt;
        nextPulse -= dt;
        if (nextPulse <= 0) {
            boolean vertical = random.nextDouble() < 0.7;
            double line = vertical ? Math.round((random.nextDouble() - 0.5) * 60) : 5 + random.nextInt(25);
            double pos = vertical ? 35 : (random.nextDouble() < 0.5 ? -40 : 40);
            double dir = vertical ? -1 : (pos > 0 ? -1 : 1);
            pulses.add(new double[]{vertical ? 1 : 0, line, pos, dir, 8 + random.nextDouble() * 10, 4 + random.nextDouble() * 4});
            nextPulse = 0.6 + random.nextDouble() * 1.6;
        }
        nextScan -= dt;
        boolean corrupted = "corrompue".equals(etat);
        if (scan == null && nextScan <= 0) scan = -0.05;
        if (scan != null) {
            scan += dt / (corrupted ? 1.8 : 2.6);
            if (scan > 1.05) {
                scan = null;
                nextScan = corrupted ? 5 + random.nextDouble() * 3 : 9 + random.nextDouble() * 4;
            }
        }
        for (double[] p : pulses) p[2] += p[3] * p[4] * dt;
        pulses.removeIf(p -> (p[0] == 1 && p[2] < 0) || (p[0] == 0 && Math.abs(p[2]) > 44));
    }

    private void draw(String etat) {
        NativeImage img = texture.getPixels();
        if (img == null) return;
        boolean corrupted = "corrompue".equals(etat);
        Palette pal = corrupted ? CORROMPUE : CREATRICE;
        double hy = h * 0.27;
        double K = h * 1.05;
        double zWall = 14;
        int yJ = (int) Math.round(hy + K / zWall);
        double vx = w * 0.56;
        double F = h * 0.9;
        double breath = corrupted ? 0.12 * (0.5 + 0.5 * Math.sin(clock * 2.4)) : 0;
        double glow = 1 + breath;
        double scroll = (clock * 0.35) % 1;
        int epoch = (int) Math.floor(clock * 4);
        double scanY = scan != null ? scan * h : -999;
        double scanBand = corrupted ? 7 : 5;

        for (int y = 0; y < h; y++) {
            double scanK = scan != null ? Math.max(0, 1 - Math.abs(y - scanY) / scanBand) : 0;
            if (y < yJ) {
                double up = (yJ - y) / (double) yJ;
                int[] base = mix(pal.horizon(), pal.top(), Math.min(1, up * 1.4));
                double wy = ((yJ - y) * zWall * G) / F;
                boolean ly = Math.abs(wy - Math.round(wy)) < (0.5 * zWall * G) / F;
                double fade = 1 - up;
                for (int x = 0; x < w; x++) {
                    double wx = ((x - vx) * zWall * G) / F;
                    boolean lx = Math.abs(wx - Math.round(wx)) < (0.5 * zWall * G) / F;
                    int[] c = base;
                    if ((lx || ly) && fade * 0.75 > bayer(x, y)) {
                        boolean isMajor = (lx && Math.round(wx) % 4 == 0) || (ly && Math.round(wy) % 4 == 0);
                        c = mix(base, isMajor ? pal.major() : pal.minor(), Math.min(1, (isMajor ? 0.7 : 0.45) * glow * fade));
                    }
                    if (scanK > 0) c = mix(c, pal.scan(), scanK * (lx || ly ? 0.5 : 0.12));
                    img.setPixelRGBA(x, y, pack(c));
                }
                continue;
            }
            double dy = y - hy + 0.5;
            double z = K / dy;
            double zw = (z + scroll) * G;
            double dz = (K / (dy * dy)) * G;
            long nearZ = Math.round(zw);
            boolean onZ = Math.abs(zw - nearZ) < dz * 0.55;
            double far = Math.min(1, z / zWall);
            double vis = Math.pow(1 - far, 1.3);
            int[] base = mix(pal.floor(), pal.horizon(), far * far);
            double dx = (z / F) * G;
            for (int x = 0; x < w; x++) {
                double wx = (x - vx) * dx;
                if (corrupted) {
                    int tx = (int) Math.floor(wx / 8);
                    int tz = (int) Math.floor(zw / 8);
                    double r = hash(tx, tz, epoch);
                    if (r < 0.07) {
                        img.setPixelRGBA(x, y, pack(base));
                        continue;
                    }
                    if (r < 0.19) wx += (r < 0.13 ? 1 : -1) * dx;
                }
                long nearX = Math.round(wx);
                boolean onX = Math.abs(wx - nearX) < dx * 0.55;
                int[] c = base;
                if ((onX || onZ) && vis > bayer(x, y) * 0.9) {
                    boolean isMajor = (onX && nearX % 4 == 0) || (onZ && nearZ % 4 == 0);
                    c = mix(base, isMajor ? pal.major() : pal.minor(), Math.min(1, (isMajor ? 0.95 : 0.6) * glow));
                }
                if (scanK > 0) c = mix(c, pal.scan(), scanK * (onX || onZ ? 0.7 : 0.15));
                img.setPixelRGBA(x, y, pack(c));
            }
        }

        // L'horizon : la jonction du sol et du mur, un filet lumineux tramé.
        if (yJ > 0 && yJ < h) {
            for (int x = 0; x < w; x++) {
                double edge = 1 - Math.abs(x - vx) / (w * 0.75);
                if (edge * 0.8 * glow > bayer(x, yJ)) img.setPixelRGBA(x, yJ, pack(mix(pal.major(), pal.bright(), 0.4)));
                if (edge * 0.35 > bayer(x, yJ - 1)) img.setPixelRGBA(x, yJ - 1, pack(pal.major()));
            }
        }

        // Les impulsions de données.
        for (double[] p : pulses) {
            for (int s = 0; s < 40; s++) {
                double back = (s / 40.0) * p[5];
                double k = 1 - s / 40.0;
                double X;
                double Z;
                if (p[0] == 1) {
                    X = p[1];
                    Z = p[2] - p[3] * back;
                } else {
                    Z = p[1];
                    X = p[2] - p[3] * back;
                }
                double zs = Z / G - scroll;
                if (zs <= 0.35 || zs > zWall) continue;
                int py = (int) Math.round(hy + K / zs - 0.5);
                int px = (int) Math.round(vx + (X / G * F) / zs);
                if (px < 0 || px >= w || py <= yJ || py >= h) continue;
                if (k < bayer(px, py) * 0.8) continue;
                img.setPixelRGBA(px, py, pack(s < 3 ? pal.core() : mix(pal.major(), pal.bright(), k)));
            }
        }
    }

    public void close() {
        if (texture != null) Minecraft.getInstance().getTextureManager().release(ID);
        texture = null;
    }
}
