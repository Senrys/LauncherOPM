package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.NativeImage;

/**
 * Un joueur imprimé, en vrai volume : le modèle de Minecraft (tête, corps,
 * bras, jambes, et leurs calques extérieurs) rastérisé sur le processeur —
 * l'écran de chargement s'affiche avant que les shaders 3D du jeu ne soient
 * prêts. Tourné de 30° vers la droite et vu d'un peu haut, comme le
 * personnage du launcher sur son socle ; il respire, ses bras se balancent,
 * sa tête regarde autour de lui.
 *
 * Le même rastériseur, à l'identique, que la scène du launcher
 * (components/loadingScene.js, `rasterPlayer`) et que xenodys/sprites.py.
 */
public final class PlayerRaster {
    public static final int FRAMES = 32;
    public static final float FPS = 12;
    public static final int W = 96;
    public static final int H = 152;
    /** Les pieds, dans chaque image. */
    public static final int OX = 48;
    public static final int OY = 144;
    /** Pixels de sprite par pixel virtuel : l'image s'affiche à moitié (nette). */
    public static final int DENSITY = 2;
    private static final float SCALE = 4;
    private static final float YAW = (float) Math.toRadians(180 + 30);
    private static final float PITCH = (float) Math.toRadians(18);
    private static final float[] LIGHT = normalize(new float[]{-0.35f, 0.85f, 0.55f});

    private PlayerRaster() {}

    private static float[] normalize(float[] v) {
        float n = (float) Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return new float[]{v[0] / n, v[1] / n, v[2] / n};
    }

    /** Une boîte du modèle : origine et taille Bedrock, UV, gonflement, pivot, os. */
    private record Box(float[] origin, float[] size, int u, int v, float inflate, boolean overlay, int part) {}

    // Os : 0 tête, 1 corps, 2 bras droit, 3 bras gauche, 4 jambe droite, 5 jambe gauche.
    private static final float[][] PIVOTS = {{0, 24, 0}, {0, 24, 0}, {-5, 22, 0}, {5, 22, 0}, {-1.9f, 12, 0}, {1.9f, 12, 0}};

    private static Box[] boxes(boolean slim, boolean legacy) {
        float aw = slim ? 3 : 4;
        int lau = legacy ? 40 : 32;
        int lav = legacy ? 16 : 48;
        int llu = legacy ? 0 : 16;
        int llv = legacy ? 16 : 48;
        var list = new java.util.ArrayList<Box>();
        list.add(new Box(new float[]{-4, 24, -4}, new float[]{8, 8, 8}, 0, 0, 0, false, 0));
        list.add(new Box(new float[]{-4, 12, -2}, new float[]{8, 12, 4}, 16, 16, 0, false, 1));
        list.add(new Box(new float[]{-4 - aw, 12, -2}, new float[]{aw, 12, 4}, 40, 16, 0, false, 2));
        list.add(new Box(new float[]{4, 12, -2}, new float[]{aw, 12, 4}, lau, lav, 0, false, 3));
        list.add(new Box(new float[]{-3.9f, 0, -2}, new float[]{4, 12, 4}, 0, 16, 0, false, 4));
        list.add(new Box(new float[]{-0.1f, 0, -2}, new float[]{4, 12, 4}, llu, llv, 0, false, 5));
        list.add(new Box(new float[]{-4, 24, -4}, new float[]{8, 8, 8}, 32, 0, 0.5f, true, 0));
        if (!legacy) {
            list.add(new Box(new float[]{-4, 12, -2}, new float[]{8, 12, 4}, 16, 32, 0.25f, true, 1));
            list.add(new Box(new float[]{-4 - aw, 12, -2}, new float[]{aw, 12, 4}, 40, 32, 0.25f, true, 2));
            list.add(new Box(new float[]{4, 12, -2}, new float[]{aw, 12, 4}, 48, 48, 0.25f, true, 3));
            list.add(new Box(new float[]{-3.9f, 0, -2}, new float[]{4, 12, 4}, 0, 32, 0.25f, true, 4));
            list.add(new Box(new float[]{-0.1f, 0, -2}, new float[]{4, 12, 4}, 0, 48, 0.25f, true, 5));
        }
        return list.toArray(Box[]::new);
    }

    /** Rotation « ZYX » (Three.js) : Rz · Ry · Rx, appliquée à v. */
    private static float[] rot(float[] v, float rx, float ry, float rz) {
        float x = v[0];
        float y = v[1] * (float) Math.cos(rx) - v[2] * (float) Math.sin(rx);
        float z = v[1] * (float) Math.sin(rx) + v[2] * (float) Math.cos(rx);
        float x2 = x * (float) Math.cos(ry) + z * (float) Math.sin(ry);
        float z2 = -x * (float) Math.sin(ry) + z * (float) Math.cos(ry);
        float x3 = x2 * (float) Math.cos(rz) - y * (float) Math.sin(rz);
        float y3 = x2 * (float) Math.sin(rz) + y * (float) Math.cos(rz);
        return new float[]{x3, y3, z2};
    }

    /** Calme : il respire, regarde autour de lui. */
    public static final int CALM = 0;
    /** Sous l'emprise de Xenodys corrompue : bras levés devant lui, tête basse, il tremble. */
    public static final int FEAR = 1;

    /** La pose de l'image `i` : rotations (radians, repère Three.js) de chaque os. */
    private static float[][] pose(int i, int mode) {
        double ph = i / (double) FRAMES * 2 * Math.PI;
        float[][] r = new float[6][3];
        if (mode == FEAR) {
            double shake = Math.sin(ph * 9) * 2.5;
            r[0][0] = (float) Math.toRadians(-14 + shake * 0.5);
            r[0][1] = (float) Math.toRadians(8 * Math.sin(ph * 2) + shake);
            // Bras levés DEVANT lui (vers −z, le côté du visage), mains devant la figure.
            r[2][0] = (float) Math.toRadians(105 + 6 * Math.sin(ph * 3) + shake);
            r[3][0] = (float) Math.toRadians(95 - 6 * Math.sin(ph * 3) - shake);
            r[2][2] = (float) Math.toRadians(-18);
            r[3][2] = (float) Math.toRadians(18);
            r[4][0] = (float) Math.toRadians(4);
            r[5][0] = (float) Math.toRadians(-6);
            return r;
        }
        r[0][1] = (float) Math.toRadians(14 * Math.sin(ph));
        r[0][0] = (float) Math.toRadians(-4 + 3 * Math.sin(ph * 2));
        r[2][0] = (float) Math.toRadians(5 * Math.sin(ph));
        r[3][0] = (float) Math.toRadians(-5 * Math.sin(ph));
        r[2][2] = (float) Math.toRadians(-3 - 2 * Math.sin(ph * 2));
        r[3][2] = (float) Math.toRadians(3 + 2 * Math.sin(ph * 2));
        return r;
    }

    /** La planche : FRAMES images côte à côte, chacune W × H. */
    public static NativeImage sheet(NativeImage skin, boolean slim) {
        return sheet(skin, slim, CALM);
    }

    public static NativeImage sheet(NativeImage skin, boolean slim, int mode) {
        boolean legacy = skin.getHeight() < 64;
        int th = skin.getHeight();
        int tw = skin.getWidth();
        int[] tex = new int[tw * th];
        for (int y = 0; y < th; y++) for (int x = 0; x < tw; x++) tex[y * tw + x] = skin.getPixelRGBA(x, y);
        NativeImage out = new NativeImage(NativeImage.Format.RGBA, W * FRAMES, H, true);
        Box[] boxes = boxes(slim, legacy);
        float[] zbuf = new float[W * H];
        int[] color = new int[W * H];
        for (int f = 0; f < FRAMES; f++) {
            java.util.Arrays.fill(zbuf, Float.NEGATIVE_INFINITY);
            java.util.Arrays.fill(color, 0);
            float[][] r = pose(f, mode);
            float breath = (float) (Math.sin(f / (double) FRAMES * 4 * Math.PI) * 0.35);
            for (Box b : boxes) drawBox(b, r, breath, tex, tw, th, zbuf, color);
            for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) out.setPixelRGBA(f * W + x, y, color[y * W + x]);
        }
        return out;
    }

    private static void drawBox(Box b, float[][] r, float breath, int[] tex, int tw, int th, float[] zbuf, int[] color) {
        float g = b.inflate();
        float sx = b.size()[0];
        float sy = b.size()[1];
        float sz = b.size()[2];
        // Repère Three.js : x de Bedrock inversé.
        float fx = -(b.origin()[0] + sx);
        float[] center = {fx + sx / 2, b.origin()[1] + sy / 2, b.origin()[2] + sz / 2};
        float[] pv = PIVOTS[b.part()];
        float[] pivot = {-pv[0], pv[1], pv[2]};
        float lift = b.part() <= 3 ? breath : 0;
        float hx = sx / 2 + g;
        float hy = sy / 2 + g;
        float hz = sz / 2 + g;
        float u = b.u();
        float v = b.v();
        float w = sx;
        float h = sy;
        float d = sz;
        float[][] rects = {
                {u, v + d, d, h}, {u + d + w, v + d, d, h}, {u + d, v, w, d}, {u + d + w, v, w, d},
                {u + 2 * d + w, v + d, w, h}, {u + d, v + d, w, h},
        };
        int[][] axes = {{2, 1, 0}, {2, 1, 0}, {0, 2, 1}, {0, 2, 1}, {0, 1, 2}, {0, 1, 2}};
        int[][] dirs = {{-1, -1}, {1, -1}, {1, 1}, {1, -1}, {1, -1}, {-1, -1}};
        int[] sign = {1, -1, 1, -1, 1, -1};
        float[] half = {hx, hy, hz};
        for (int f = 0; f < 6; f++) {
            int ua = axes[f][0];
            int va = axes[f][1];
            int wa = axes[f][2];
            float[] nrm = new float[3];
            nrm[wa] = sign[f];
            float[] n = view(rot(nrm, r[b.part()][0], r[b.part()][1], r[b.part()][2]));
            if (n[2] <= 1e-4f) continue;
            float lum = 0.5f + 0.5f * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
            float[][] pts = new float[4][];
            float[][] uvs = new float[4][];
            boolean flipV = f == 2 || f == 3;
            int k = 0;
            for (int iy = 0; iy <= 1; iy++) {
                for (int ix = 0; ix <= 1; ix++) {
                    float[] p = new float[3];
                    p[ua] = (ix * 2 - 1) * half[ua] * dirs[f][0];
                    p[va] = (iy * 2 - 1) * half[va] * dirs[f][1];
                    p[wa] = half[wa] * sign[f];
                    // Centre de la boîte, relatif au pivot, puis rotation de l'os.
                    float[] q = {p[0] + center[0] - pivot[0], p[1] + center[1] - pivot[1], p[2] + center[2] - pivot[2]};
                    q = rot(q, r[b.part()][0], r[b.part()][1], r[b.part()][2]);
                    q = new float[]{q[0] + pivot[0], q[1] + pivot[1] + lift, q[2] + pivot[2]};
                    float[] s = view(q);
                    pts[k] = new float[]{s[0] * SCALE + OX, -s[1] * SCALE + OY, s[2]};
                    float tyv = flipV ? rects[f][1] + (1 - iy) * rects[f][3] : rects[f][1] + iy * rects[f][3];
                    uvs[k] = new float[]{rects[f][0] + ix * rects[f][2], tyv};
                    k++;
                }
            }
            tri(pts[0], pts[1], pts[2], uvs[0], uvs[1], uvs[2], tex, tw, th, lum, b.overlay(), zbuf, color);
            tri(pts[1], pts[3], pts[2], uvs[1], uvs[3], uvs[2], tex, tw, th, lum, b.overlay(), zbuf, color);
        }
    }

    /** Monde → caméra : lacet puis tangage. */
    private static float[] view(float[] p) {
        float x = p[0] * (float) Math.cos(YAW) + p[2] * (float) Math.sin(YAW);
        float z = -p[0] * (float) Math.sin(YAW) + p[2] * (float) Math.cos(YAW);
        float y = p[1];
        float y2 = y * (float) Math.cos(PITCH) - z * (float) Math.sin(PITCH);
        float z2 = y * (float) Math.sin(PITCH) + z * (float) Math.cos(PITCH);
        return new float[]{x, y2, z2};
    }

    private static void tri(float[] a, float[] b, float[] c, float[] ua, float[] ub, float[] uc, int[] tex, int tw, int th,
                            float lum, boolean overlay, float[] zbuf, int[] color) {
        float area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        if (Math.abs(area) < 1e-6f) return;
        int x0 = Math.max(0, (int) Math.floor(Math.min(a[0], Math.min(b[0], c[0]))));
        int x1 = Math.min(W - 1, (int) Math.ceil(Math.max(a[0], Math.max(b[0], c[0]))));
        int y0 = Math.max(0, (int) Math.floor(Math.min(a[1], Math.min(b[1], c[1]))));
        int y1 = Math.min(H - 1, (int) Math.ceil(Math.max(a[1], Math.max(b[1], c[1]))));
        for (int y = y0; y <= y1; y++) {
            float py = y + 0.5f;
            for (int x = x0; x <= x1; x++) {
                float px = x + 0.5f;
                float w0 = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
                float w1 = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
                float w2 = 1 - w0 - w1;
                if (w0 < -1e-5f || w1 < -1e-5f || w2 < -1e-5f) continue;
                float z = w0 * a[2] + w1 * b[2] + w2 * c[2];
                int i = y * W + x;
                if (z <= zbuf[i]) continue;
                int tu = Math.min(tw - 1, Math.max(0, (int) Math.floor(w0 * ua[0] + w1 * ub[0] + w2 * uc[0])));
                int tv = Math.min(th - 1, Math.max(0, (int) Math.floor(w0 * ua[1] + w1 * ub[1] + w2 * uc[1])));
                int abgr = tex[tv * tw + tu];
                int alpha = (abgr >>> 24) & 255;
                if (overlay && alpha < 128) continue;
                int rr = Math.min(255, (int) ((abgr & 255) * lum));
                int gg = Math.min(255, (int) (((abgr >> 8) & 255) * lum));
                int bb = Math.min(255, (int) (((abgr >> 16) & 255) * lum));
                zbuf[i] = z;
                color[i] = 0xFF000000 | (bb << 16) | (gg << 8) | rr;
            }
        }
    }
}
