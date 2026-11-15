package fr.onepieceminecraft.opm.mixin;

import fr.onepieceminecraft.opm.client.OpmBackground;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Hors partie, les menus de Minecraft s'affichent sur la salle de simulation. */
@Mixin(Screen.class)
public abstract class ScreenMixin {
    @Inject(method = "renderPanorama", at = @At("HEAD"), cancellable = true)
    private void opm$lab(GuiGraphics graphics, float partialTick, CallbackInfo ci) {
        OpmBackground.render(graphics);
        ci.cancel();
    }

    /** Pas de flou sur la salle : ses pixels restent nets. */
    @Inject(method = "renderBlurredBackground", at = @At("HEAD"), cancellable = true)
    private void opm$noBlur(float partialTick, CallbackInfo ci) {
        if (Minecraft.getInstance().level == null) ci.cancel();
    }
}
