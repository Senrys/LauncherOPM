package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import java.util.Locale;
import net.minecraft.client.gui.GuiGraphics;

/**
 * La police pixel du launcher et du mod (xenodys/sprites.py, `police`) :
 * capitales 5 × 7 et accents français. Disponible pendant le chargement, quand
 * la police de Minecraft ne l'est pas encore.
 */
public final class PixelFont {
    private PixelFont() {}

    private static Sprites.Sheet sheet() {
        return Sprites.get("police");
    }

    private static int index(char c) {
        Sprites.Sheet s = sheet();
        if (s == null) return -1;
        return s.points().get("caracteres").getAsString().indexOf(c);
    }

    private static int advance(int i) {
        JsonArray a = sheet().points().getAsJsonArray("avances");
        return i >= 0 && i < a.size() ? a.get(i).getAsInt() : 4;
    }

    private static String norm(String text) {
        return text.toUpperCase(Locale.FRENCH).replace('Œ', 'E').replace(' ', ' ');
    }

    /** Largeur du texte, en pixels de police (× `scale` à l'écran). */
    public static int width(String text) {
        if (sheet() == null) return 0;
        int w = 0;
        for (char c : norm(text).toCharArray()) w += advance(index(c));
        return Math.max(0, w - 1);
    }

    /**
     * Écrit `text` à partir de (x, y) — y est le haut des capitales. `rgb` :
     * couleur, `alpha` : opacité, `scale` : taille d'un pixel de police.
     */
    public static void draw(GuiGraphics g, String text, float x, float y, int rgb, float alpha, float scale) {
        Sprites.Sheet s = sheet();
        alpha *= Sprites.alpha;
        if (s == null || alpha <= 0.003f) return;
        int cols = s.points().get("colonnes").getAsInt();
        g.flush();
        com.mojang.blaze3d.systems.RenderSystem.enableBlend();
        com.mojang.blaze3d.systems.RenderSystem.defaultBlendFunc();
        g.setColor(((rgb >> 16) & 255) / 255f, ((rgb >> 8) & 255) / 255f, (rgb & 255) / 255f, Math.min(1f, alpha));
        var pose = g.pose();
        pose.pushPose();
        pose.translate(x, y - 2 * scale, 0);
        pose.scale(scale, scale, 1);
        int cx = 0;
        for (char c : norm(text).toCharArray()) {
            int i = index(c);
            if (i >= 0 && c != ' ') {
                g.blit(s.texture(), cx, 0, s.w(), s.h(), (i % cols) * s.w(), (i / cols) * s.h(), s.w(), s.h(), s.texW(), s.texH());
            }
            cx += advance(i);
        }
        pose.popPose();
        g.setColor(1f, 1f, 1f, 1f);
    }

    public static void drawCentered(GuiGraphics g, String text, float cx, float y, int rgb, float alpha, float scale) {
        draw(g, text, cx - width(text) * scale / 2f, y, rgb, alpha, scale);
    }
}
