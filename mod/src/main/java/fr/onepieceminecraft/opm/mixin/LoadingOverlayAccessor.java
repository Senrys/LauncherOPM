package fr.onepieceminecraft.opm.mixin;

import java.util.Optional;
import java.util.function.Consumer;
import net.minecraft.client.gui.screens.LoadingOverlay;
import net.minecraft.server.packs.resources.ReloadInstance;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(LoadingOverlay.class)
public interface LoadingOverlayAccessor {
    @Accessor("reload")
    ReloadInstance opm$reload();

    @Accessor("onFinish")
    Consumer<Optional<Throwable>> opm$onFinish();

    @Accessor("fadeIn")
    boolean opm$fadeIn();
}
