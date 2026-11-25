package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.vertex.PoseStack;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.resources.ResourceLocation;

/**
 * Xenodys la Tisseuse, en 3D : son modèle (client/Rig) et ses textures, créatrice ou
 * corrompue. Dessinée en couches : la matière, ses lueurs (additives, pleine lumière),
 * le verre, l'énergie. Partagée par le laboratoire, l'avertissement et le monde.
 */
public final class Xen {
    static final String ID = "xenodys_tisseuse";
    private static Rig model;
    private static boolean tried;

    private Xen() {}

    public static Rig model() {
        if (!tried) {
            tried = true;
            model = Rig.load(ID, ID, "animation.xenodys");
        }
        return model;
    }

    public static ResourceLocation texture(String id, String etat, boolean glow) {
        return LabScene.tex(id + "_" + etat + (glow ? "_glowmask" : ""));
    }

    /**
     * Dessine Xenodys dans le repère courant (y vers le haut, une unité du
     * modèle par unité). `alpha` < 1 : en fondu (pas de lueur sous 0,5).
     */
    public static void render(PoseStack ps, MultiBufferSource.BufferSource buffers, Rig.Pose pose, String etat,
                              Rig.Options options, int light, float alpha) {
        Rig m = model();
        if (m == null) return;
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        int color = (a << 24) | 0xFFFFFF;
        ResourceLocation tex = texture(ID, etat, false);
        m.solve(pose, ps.last().pose(), options);
        m.emitEntity(buffers.getBuffer(alpha > 0.98f ? RenderType.entityCutoutNoCull(tex) : RenderType.entityTranslucent(tex)),
                Rig.Layer.BASE, false, light, color);
        buffers.endBatch();
        if (alpha > 0.5f) {
            m.emitEntity(buffers.getBuffer(RenderType.eyes(texture(ID, etat, true))), Rig.Layer.GLOW, false, LightTexture.FULL_BRIGHT, -1);
            buffers.endBatch();
        }
        m.emitEntity(buffers.getBuffer(RenderType.entityTranslucent(tex)), Rig.Layer.GLASS, false, light, color);
        buffers.endBatch();
        m.emitEntity(buffers.getBuffer(RenderType.entityTranslucentEmissive(tex)), Rig.Layer.ENERGY, true, LightTexture.FULL_BRIGHT, color);
        buffers.endBatch();
    }

    /** Un clignement : vrai pendant 0,13 s, toutes les 2 à 6 s (déterministe par graine). */
    public static boolean blinking(double t, int seed) {
        double period = 3.5 + (seed % 7) * 0.4;
        return (t + seed * 0.37) % period < 0.13;
    }
}
