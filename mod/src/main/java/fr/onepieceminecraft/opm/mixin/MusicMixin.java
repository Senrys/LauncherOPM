package fr.onepieceminecraft.opm.mixin;

import fr.onepieceminecraft.opm.client.OpmMusic;
import net.minecraft.client.Minecraft;
import net.minecraft.sounds.Music;
import net.minecraft.sounds.Musics;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** La musique des menus de Minecraft devient celle du launcher. */
@Mixin(Minecraft.class)
public abstract class MusicMixin {
    @Inject(method = "getSituationalMusic", at = @At("RETURN"), cancellable = true)
    private void opm$menuMusic(CallbackInfoReturnable<Music> cir) {
        if (cir.getReturnValue() == Musics.MENU) cir.setReturnValue(OpmMusic.menu());
    }
}
