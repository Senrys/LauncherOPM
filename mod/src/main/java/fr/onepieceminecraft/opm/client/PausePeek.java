package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.Lighting;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.math.Axis;
import java.util.List;
import java.util.Random;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.renderer.LightTexture;

/**
 * Dans le menu pause, de temps en temps, Xenodys passe la tête par le coin
 * bas-droit de l'écran et dit un mot : l'annonce du staff s'il y en a une
 * (toujours montrée), sinon une phrase de son état. Son regard suit la souris.
 */
public final class PausePeek {
    private static final List<String> CREATRICE = List.of(
            "Je veille sur la simulation. Prends ton temps.",
            "Le monde t'attend, aventurier.",
            "Mes assistants réparent un bloc ou deux. Rien de grave.",
            "Grand Line ne se construit pas en un jour.");
    private static final List<String> CORROMPUE = List.of(
            "Tu crois pouvoir m'échapper en faisant pause ?",
            "Le monde m'appartient. Pour l'instant.",
            "Mes fils ne lâchent jamais.",
            "Reviens vite… je m'ennuie.");
    private static final Random RANDOM = new Random();

    private static Screen current;
    private static long start;
    private static boolean show;
    private static String line;
    private static float yaw;
    private static float pitch;
    private static long last;

    private PausePeek() {}

    private static int argb(int rgb, double a) {
        return ((int) Math.round(Math.max(0, Math.min(1, a)) * 255) << 24) | (rgb & 0xFFFFFF);
    }

    public static void render(Screen screen, GuiGraphics g, int mouseX, int mouseY) {
        OpmSession session = OpmSession.get();
        if (screen != current) {
            current = screen;
            start = Util.getMillis();
            String staff = session.message;
            show = staff != null || RANDOM.nextDouble() < 0.4 || !System.getProperty("opm.debug.world", "").isEmpty();
            List<String> lines = session.corrupted() ? CORROMPUE : CREATRICE;
            line = staff != null ? staff : lines.get(RANDOM.nextInt(lines.size()));
        }
        if (!show || Xen.model() == null) return;
        drawPeek(g, (Util.getMillis() - start) / 1000.0, line, session.etat, mouseX, mouseY, false);
    }

    /**
     * Xenodys au coin bas-droit, qui monte du bas, avec sa bulle. Partagé avec
     * l'avertissement anti-triche (client/XenodysWarning) : `glitch` la fait
     * trembler, corrompue.
     */
    public static void drawPeek(GuiGraphics g, double t, String line, String etat, double mouseX, double mouseY,
                                boolean glitch) {
        if (Xen.model() == null) return;
        long now = Util.getMillis();
        double dt = last == 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        double rise = Math.max(0, Math.min(1, (t - 0.5) / 0.7));
        rise = rise * rise * (3 - 2 * rise);
        if (rise <= 0) return;

        Minecraft mc = Minecraft.getInstance();
        var window = mc.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        double mx = mouseX * window.getGuiScale() / k;
        double my = mouseY * window.getGuiScale() / k;
        boolean corrupted = "corrompue".equals(etat);

        // La tête finit aux trois cinquièmes de la hauteur, au ras du bord droit ;
        // elle monte du bas de l'écran.
        float scale = vh * 0.5f / 104f;
        float cx = vw - 20 * scale;
        float baseY = vh * 0.7f + 89 * scale + (float) (1 - rise) * vh * 0.45f;
        double headX = cx - 16 * scale;
        double headY = baseY - 87 * scale;
        float ty = (float) Math.max(-40, Math.min(40, (mx - headX) / (vw * 0.5) * 50));
        float tp = (float) Math.max(-20, Math.min(30, (my - headY) / (vh * 0.5) * 35));
        double damp = Math.exp(-5 * dt);
        yaw = (float) (ty + (yaw - ty) * damp);
        pitch = (float) (tp + (pitch - tp) * damp);

        GeoModel.Pose p = Xen.model().pose(corrupted ? "corrupted_idle" : "idle", (float) t);
        GeoModel.add(p, "head", new float[]{pitch * 0.7f, -yaw * 0.7f, 18}, null);
        GeoModel.add(p, "neck", new float[]{pitch * 0.3f, -yaw * 0.3f, 6}, null);
        // Elle se penche par le coin, une main levée sur le bord de l'écran.
        GeoModel.add(p, "chest", new float[]{0, 0, 14}, null);

        g.flush();
        RenderSystem.clear(org.lwjgl.opengl.GL11.GL_DEPTH_BUFFER_BIT, Minecraft.ON_OSX);
        var ps = g.pose();
        ps.pushPose();
        ps.scale(s, s, 1);
        ps.pushPose();
        float shake = glitch && RANDOM.nextDouble() < 0.25 ? (RANDOM.nextFloat() - 0.5f) * 4 : 0;
        ps.translate(cx + shake, baseY, 300);
        ps.scale(scale, -scale, scale);
        ps.mulPose(Axis.YP.rotationDegrees(180 + 20));
        // Penchée vers l'intérieur de l'écran (le demi-tour en y inverse le sens).
        ps.mulPose(Axis.ZP.rotationDegrees(-12));
        Lighting.setupForEntityInInventory();
        Xen.render(ps, g.bufferSource(), p, etat, Xen.blinking(t, 3), LightTexture.FULL_BRIGHT, 1f, null);
        Lighting.setupFor3DItems();
        ps.popPose();

        // Sa bulle, à gauche de sa tête.
        double bubble = Math.max(0, Math.min(1, (t - 1.1) / 0.3));
        if (bubble > 0) {
            int accent = corrupted ? 0xF0506E : 0x91D9D1;
            int w = Math.min(124, PixelFont.width(line) + 12);
            List<String> lines = wrap(line, w - 12);
            int h = lines.size() * 10 + 8;
            // Au-dessus de sa tête, contre le bord droit : loin des boutons du menu.
            int bx = vw - w - 6;
            int by = (int) (headY - 22 * scale - h);
            g.fill(bx, by, bx + w, by + h, argb(0x071211, 0.92 * bubble));
            g.fill(bx, by, bx + w, by + 1, argb(accent, bubble));
            int tail = (int) Math.min(bx + w - 6, headX);
            g.fill(tail - 2, by + h, tail + 2, by + h + 4, argb(0x071211, 0.92 * bubble));
            int yy = by + 5;
            for (String l : lines) {
                PixelFont.draw(g, l, bx + 6, yy, 0xE9FFFC, (float) bubble, 1f);
                yy += 10;
            }
            PixelFont.draw(g, "Xenodys", bx, by - 10, accent, (float) bubble, 1f);
        }
        ps.popPose();
        DebugShots.maybe(glitch ? "alerte" : "pause", t);
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
