package fr.onepieceminecraft.opm.mixin;

import fr.onepieceminecraft.opm.client.OpmMusic;
import net.minecraft.client.sounds.MusicManager;
import net.minecraft.sounds.Music;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** La musique du launcher démarre dans le jeu : on le dit au launcher. */
@Mixin(MusicManager.class)
public abstract class MusicManagerMixin {
    @Inject(method = "startPlaying", at = @At("TAIL"))
    private void opm$started(Music music, CallbackInfo ci) {
        if (OpmMusic.isOurs(music)) OpmMusic.announce();
    }
}
