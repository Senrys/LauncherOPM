package fr.onepieceminecraft.opm.mixin;

import fr.onepieceminecraft.opm.client.MenuStyle;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.resources.ResourceLocation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/**
 * Boutons, curseurs et champs aux couleurs du launcher — mais seulement hors du
 * monde et sans pack de ressources du serveur : sur le serveur, le jeu garde
 * l'apparence que lui donne son pack (client/MenuStyle).
 */
@Mixin(GuiGraphics.class)
public abstract class GuiGraphicsMixin {
    @ModifyVariable(method = "blitSprite(Lnet/minecraft/resources/ResourceLocation;IIII)V", at = @At("HEAD"), argsOnly = true)
    private ResourceLocation opm$sprite(ResourceLocation sprite) {
        return MenuStyle.swap(sprite);
    }

    @ModifyVariable(method = "blitSprite(Lnet/minecraft/resources/ResourceLocation;IIIII)V", at = @At("HEAD"), argsOnly = true)
    private ResourceLocation opm$spriteZ(ResourceLocation sprite) {
        return MenuStyle.swap(sprite);
    }
}
