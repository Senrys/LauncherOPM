package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.Lighting;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.math.Axis;
import java.util.List;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.LightTexture;

/**
 * Xenodys au coin bas-droit de l'écran, avec sa bulle : le dessin de
 * l'avertissement anti-triche (client/XenodysWarning). Elle ne vient plus dans
 * le menu pause : un joueur ne la voit qu'à sa première arrivée, ou s'il triche.
 */
public final class XenodysCorner {
    private static float yaw;
    private static float pitch;
    private static long last;

    private XenodysCorner() {}

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    private static double easeOut(double k) {
        k = Math.max(0, Math.min(1, k));
        return 1 - Math.pow(1 - k, 3);
    }

    private static double easeInOut(double k) {
        k = Math.max(0, Math.min(1, k));
        return k * k * (3 - 2 * k);
    }

    /**
     * Xenodys au coin bas-droit, avec sa bulle. Le mouvement est continu, sans à-coups :
     * elle monte lentement du bas (et décélère), se penche vers le joueur à mesure
     * qu'elle arrive, respire, le suit du regard ; sa bulle s'écrit lettre à
     * lettre ; à `remaining` secondes de la fin, elle redescend.
     *
     * <p>`menace` (l'avertissement anti-triche, client/XenodysWarning) : elle se
     * penche davantage, incline la tête, et un bref parasite la traverse de temps
     * en temps — jamais un tremblement continu.
     */
    public static void draw(GuiGraphics g, double t, String line, String etat, double mouseX, double mouseY,
                            boolean menace, double remaining) {
        if (Xen.model() == null) return;
        long now = Util.getMillis();
        double dt = last == 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        // Arrivée en 1,1 s, qui ralentit ; départ en 0,9 s, qui accélère.
        double rise = easeOut((t - 0.2) / 1.1) * (remaining < 0.9 ? easeInOut(remaining / 0.9) : 1);
        if (rise <= 0.001) return;

        Minecraft mc = Minecraft.getInstance();
        var window = mc.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        double mx = mouseX * window.getGuiScale() / k;
        double my = mouseY * window.getGuiScale() / k;
        boolean corrupted = "corrompue".equals(etat);

        // La tête finit aux trois cinquièmes de la hauteur, au ras du bord droit.
        float scale = vh * 0.5f / 104f;
        float breathe = (float) Math.sin(t * 1.3) * 0.8f;
        float cx = vw - 20 * scale;
        float baseY = vh * 0.7f + 89 * scale + (float) (1 - rise) * vh * 0.45f + breathe * scale;
        double headX = cx - 16 * scale;
        double headY = baseY - 87 * scale;
        float ty = (float) Math.max(-40, Math.min(40, (mx - headX) / (vw * 0.5) * 50));
        float tp = (float) Math.max(-20, Math.min(30, (my - headY) / (vh * 0.5) * 35));
        // Un regard qui rattrape sa cible en douceur, plus lentement quand elle menace.
        double damp = Math.exp(-(menace ? 2.5 : 5) * dt);
        yaw = (float) (ty + (yaw - ty) * damp);
        pitch = (float) (tp + (pitch - tp) * damp);

        GeoModel.Pose p = Xen.model().pose(corrupted ? "corrupted_idle" : "idle", (float) t);
        // Penchée vers le joueur à mesure qu'elle arrive ; la tête inclinée, lentement.
        float lean = (float) rise * (menace ? 16 : 8);
        float roll = menace ? 10 + (float) Math.sin(t * 0.7) * 6 : 14 + (float) Math.sin(t * 0.9) * 3;
        GeoModel.add(p, "head", new float[]{pitch * 0.7f, -yaw * 0.7f, roll}, null);
        GeoModel.add(p, "neck", new float[]{pitch * 0.3f, -yaw * 0.3f, roll * 0.3f}, null);
        GeoModel.add(p, "chest", new float[]{lean, 0, 10 + (float) rise * 4}, null);

        // Le parasite : 90 ms toutes les ~2,7 s, une fois arrivée — décalée et pâlie.
        double cycle = (t + 0.4) % 2.7;
        boolean flicker = menace && rise > 0.95 && cycle < 0.09;
        float offset = flicker ? (cycle < 0.045 ? 3 : -2) : 0;

        g.flush();
        RenderSystem.clear(org.lwjgl.opengl.GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);
        var ps = g.pose();
        ps.pushPose();
        ps.scale(s, s, 1);
        ps.pushPose();
        ps.translate(cx + offset, baseY, 300);
        ps.scale(scale, -scale, scale);
        ps.mulPose(Axis.YP.rotationDegrees(180 + 20));
        // Penchée vers l'intérieur de l'écran (le demi-tour en y inverse le sens),
        // de plus en plus à mesure qu'elle sort du coin.
        ps.mulPose(Axis.ZP.rotationDegrees((float) (-6 - 7 * rise)));
        Lighting.setupForEntityInInventory();
        Xen.render(ps, g.bufferSource(), p, etat, Xen.blinking(t, 3), LightTexture.FULL_BRIGHT, flicker ? 0.6f : 1f, null);
        Lighting.setupFor3DItems();
        ps.popPose();

        // Sa bulle, au-dessus de sa tête : elle s'ouvre une fois Xenodys arrivée, le
        // texte s'écrit lettre à lettre, et elle se referme avant son départ.
        double bubble = easeInOut((t - 1.2) / 0.35) * (remaining < 1.2 ? easeInOut((remaining - 0.6) / 0.6) : 1);
        if (bubble > 0) {
            int accent = corrupted ? 0xF0506E : 0x91D9D1;
            int w = Math.min(124, PixelFont.width(line) + 12);
            List<String> lines = wrap(line, w - 12);
            int h = lines.size() * 10 + 8;
            int bx = vw - w - 6;
            int by = (int) (headY - 22 * scale - h);
            g.fill(bx, by, bx + w, by + h, argb(0x071211, 0.92 * bubble));
            g.fill(bx, by, bx + w, by + 1, argb(accent, bubble));
            int tail = (int) Math.min(bx + w - 6, headX);
            g.fill(tail - 2, by + h, tail + 2, by + h + 4, argb(0x071211, 0.92 * bubble));
            int shown = (int) Math.floor(Math.max(0, t - 1.35) * (menace ? 22 : 34));
            int yy = by + 5;
            for (String l : lines) {
                if (shown <= 0) break;
                String part = l.length() <= shown ? l : l.substring(0, shown);
                shown -= l.length() + 1;
                PixelFont.draw(g, part, bx + 6, yy, 0xE9FFFC, (float) bubble, 1f);
                yy += 10;
            }
            PixelFont.draw(g, "Xenodys", bx, by - 10, accent, (float) bubble, 1f);
        }
        ps.popPose();
        DebugShots.maybe(menace ? "alerte" : "pause", t);
    }

    private static List<String> wrap(String text, int width) {
        List<String> out = new java.util.ArrayList<>();
        StringBuilder line = new StringBuilder();
        for (String word : text.split(" ")) {
            String next = line.isEmpty() ? word : line + " " + word;
            if (PixelFont.width(next) > width && !line.isEmpty()) {
                out.add(line.toString());
                line = new StringBuilder(word);
            } else {
                line = new StringBuilder(next);
            }
        }
        if (!line.isEmpty()) out.add(line.toString());
        return out.size() > 5 ? out.subList(0, 5) : out;
    }
}
