package fr.onepieceminecraft.opm.mixin;

import fr.onepieceminecraft.opm.client.OpmLoadingOverlay;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.LoadingOverlay;
import net.minecraft.client.gui.screens.Overlay;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.ModifyVariable;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Tout écran de chargement (Mojang ou NeoForge) devient celui de Xenodys. */
@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
    @ModifyVariable(method = "setOverlay", at = @At("HEAD"), argsOnly = true)
    private Overlay opm$wrapOverlay(Overlay overlay) {
        if (overlay instanceof LoadingOverlay loading) {
            try {
                return new OpmLoadingOverlay((Minecraft) (Object) this, loading);
            } catch (Throwable t) {
                fr.onepieceminecraft.opm.Opm.LOG.error("Écran de chargement OPM indisponible", t);
            }
        }
        return overlay;
    }

    /**
     * Hors partie, Minecraft se bride à 60 images par seconde au minuteur : la scène
     * saccade sur un écran plus rapide. On suit la limite choisie par le joueur (et sa
     * synchronisation verticale), sans dépasser 144.
     */
    @Inject(method = "getFramerateLimit", at = @At("RETURN"), cancellable = true)
    private void opm$smoothMenus(CallbackInfoReturnable<Integer> cir) {
        Minecraft mc = (Minecraft) (Object) this;
        if (mc.level == null) cir.setReturnValue(Math.max(60, Math.min(144, mc.getWindow().getFramerateLimit())));
    }
}
