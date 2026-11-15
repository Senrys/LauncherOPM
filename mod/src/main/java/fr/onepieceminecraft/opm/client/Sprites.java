package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;

/**
 * Les planches de sprites de Xenodys (xenodys/sprites.py), lues dans le jar du
 * mod et non dans les packs de ressources : elles s'affichent pendant le
 * chargement des ressources, et aucun pack ne peut les remplacer.
 *
 * Coordonnées : en « pixels virtuels » (vp) de la scène ; `draw` place
 * l'ORIGINE de la planche (le pied du modèle) au point donné.
 */
public final class Sprites {
    /** Hors de textures/gui/sprites : Minecraft n'en fait pas un atlas. */
    private static final String ROOT = "/assets/opm/scene/";
    private static JsonObject meta;
    private static final Map<String, Sheet> SHEETS = new HashMap<>();

    public record Sheet(String name, ResourceLocation texture, int w, int h, int frames, int ox, int oy,
                        float fps, boolean loop, JsonObject points, int texW, int texH, int cols, int density) {
        /** Image courante d'une animation commencée à `t0`, au temps `t` (secondes). */
        public int frameAt(double t) {
            if (frames <= 1 || fps <= 0) return 0;
            int i = (int) Math.floor(t * fps);
            return loop ? Math.floorMod(i, frames) : Math.min(frames - 1, Math.max(0, i));
        }

        public double duration() {
            return fps > 0 ? frames / fps : 0;
        }
    }

    /** Opacité commune à tout ce qui se dessine (fondu de sortie de la scène). */
    public static float alpha = 1f;

    private Sprites() {}

    private static JsonObject meta() {
        if (meta == null) {
            try (InputStream in = Sprites.class.getResourceAsStream(ROOT + "sprites.json")) {
                meta = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
            } catch (Exception e) {
                Opm.LOG.error("Planches de sprites illisibles", e);
                meta = new JsonObject();
            }
        }
        return meta;
    }

    /** Une planche, chargée à la première demande (fil de rendu). `null` si absente. */
    public static Sheet get(String name) {
        Sheet sheet = SHEETS.get(name);
        if (sheet != null || SHEETS.containsKey(name)) return sheet;
        JsonObject m = meta().getAsJsonObject(name);
        if (m == null) {
            SHEETS.put(name, null);
            return null;
        }
        String file = name.startsWith("bandeau") ? name : name;
        try (InputStream in = Sprites.class.getResourceAsStream(ROOT + file + ".png")) {
            NativeImage image = NativeImage.read(in);
            ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, "sprite/" + name);
            Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(image));
            sheet = new Sheet(name, id, m.get("largeur").getAsInt(), m.get("hauteur").getAsInt(),
                    m.get("images").getAsInt(), m.getAsJsonArray("origine").get(0).getAsInt(),
                    m.getAsJsonArray("origine").get(1).getAsInt(), m.get("fps").getAsFloat(),
                    m.get("boucle").getAsBoolean(),
                    m.has("points") ? m.getAsJsonObject("points") : new JsonObject(),
                    image.getWidth(), image.getHeight(),
                    m.has("colonnes") ? m.get("colonnes").getAsInt() : m.get("images").getAsInt(),
                    m.has("densite") ? m.get("densite").getAsInt() : 1);
        } catch (Exception e) {
            Opm.LOG.error("Planche « {} » illisible", name, e);
            sheet = null;
        }
        SHEETS.put(name, sheet);
        return sheet;
    }

    /** Une planche selon l'état de Xenodys : `nom_creatrice` / `nom_corrompue`. */
    public static Sheet get(String name, String etat) {
        Sheet s = get(name + "_" + etat);
        return s != null ? s : get(name + "_creatrice");
    }

    public static void draw(GuiGraphics g, Sheet s, int frame, float x, float y) {
        draw(g, s, frame, x, y, false, 1f, 1f);
    }

    /**
     * Dessine une image de la planche. `x`, `y` : position de l'origine ;
     * `mirror` : retournée horizontalement autour de l'origine ; `scale` : taille.
     */
    public static void draw(GuiGraphics g, Sheet s, int frame, float x, float y, boolean mirror, float alpha, float scale) {
        alpha *= Sprites.alpha;
        if (s == null || alpha <= 0.003f) return;
        g.flush();
        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
        g.setColor(1f, 1f, 1f, Math.min(1f, alpha));
        var pose = g.pose();
        pose.pushPose();
        pose.translate(x, y, 0);
        // Une planche « dense » (2 pixels de sprite par pixel virtuel) s'affiche à
        // moitié : ses pixels tombent au plus près de ceux de l'écran.
        float k = scale / s.density();
        pose.scale(mirror ? -k : k, k, 1);
        int col = frame % s.cols();
        int row = frame / s.cols();
        g.blit(s.texture(), -s.ox(), -s.oy(), s.w(), s.h(), col * s.w(), row * s.h(), s.w(), s.h(), s.texW(), s.texH());
        pose.popPose();
        g.setColor(1f, 1f, 1f, 1f);
    }

    /** Une texture quelconque, posée par son coin haut-gauche. */
    public static void drawTexture(GuiGraphics g, ResourceLocation tex, float x, float y, int w, int h,
                                   int u, int v, int uw, int vh, int texW, int texH, float alpha) {
        alpha *= Sprites.alpha;
        if (alpha <= 0.003f) return;
        g.flush();
        RenderSystem.enableBlend();
        RenderSystem.defaultBlendFunc();
        g.setColor(1f, 1f, 1f, Math.min(1f, alpha));
        var pose = g.pose();
        pose.pushPose();
        pose.translate(x, y, 0);
        g.blit(tex, 0, 0, w, h, u, v, uw, vh, texW, texH);
        pose.popPose();
        g.setColor(1f, 1f, 1f, 1f);
    }
}
