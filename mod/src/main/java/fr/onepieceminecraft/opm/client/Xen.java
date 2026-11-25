package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.vertex.PoseStack;
import java.util.Set;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.resources.ResourceLocation;

/**
 * Xenodys, en 3D : le modèle GeckoLib (client/GeoModel) et ses textures,
 * créatrice ou corrompue, yeux ouverts ou clos, avec son glowmask en pleine
 * lumière — comme l'AutoGlowingGeoLayer de GeckoLib. Partagé par l'écran
 * titre, le menu pause et Xenodys dans le monde.
 */
public final class Xen {
    private static GeoModel model;
    private static boolean tried;

    private Xen() {}

    public static GeoModel model() {
        if (!tried) {
            tried = true;
            model = GeoModel.load("xenodys", "animation.xenodys");
        }
        return model;
    }

    public static ResourceLocation texture(String etat, boolean blink, boolean glow) {
        return LabScene.tex("xenodys_" + etat + (blink ? "_blink" : "") + (glow ? "_glowmask" : ""));
    }

    /**
     * Dessine Xenodys dans le repère courant (y vers le haut, une unité du
     * modèle par unité). `alpha` < 1 : en fondu (pas de lueur sous 0,5).
     */
    public static void render(PoseStack ps, MultiBufferSource.BufferSource buffers, GeoModel.Pose pose, String etat,
                              boolean blink, int light, float alpha, Set<String> only) {
        GeoModel m = model();
        if (m == null) return;
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        m.render(ps, buffers.getBuffer(RenderType.entityTranslucent(texture(etat, blink, false))), pose, only, light,
                (a << 24) | 0xFFFFFF);
        buffers.endBatch();
        if (alpha > 0.5f) {
            m.render(ps, buffers.getBuffer(RenderType.eyes(texture(etat, blink, true))), pose, only,
                    LightTexture.FULL_BRIGHT, -1);
            buffers.endBatch();
        }
    }

    /** Un clignement : vrai pendant 0,13 s, toutes les 2 à 6 s (déterministe par graine). */
    public static boolean blinking(double t, int seed) {
        double period = 3.5 + (seed % 7) * 0.4;
        return (t + seed * 0.37) % period < 0.13;
    }
}
