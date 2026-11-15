package fr.onepieceminecraft.opm;

import fr.onepieceminecraft.opm.client.ConnectFx;
import fr.onepieceminecraft.opm.client.OpmLive;
import fr.onepieceminecraft.opm.client.OpmSession;
import fr.onepieceminecraft.opm.client.PausePeek;
import fr.onepieceminecraft.opm.client.WorldXenodys;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RenderGuiEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderNameTagEvent;
import fr.onepieceminecraft.opm.client.OpmTitleScreen;
import java.util.ArrayList;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.ConfirmLinkScreen;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.gui.screens.multiplayer.JoinMultiplayerScreen;
import net.minecraft.client.gui.screens.worldselection.SelectWorldScreen;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.contents.TranslatableContents;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.event.ScreenEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Le mod One Piece Minecraft, côté client : l'écran de chargement de Xenodys
 * (mixin/MinecraftMixin → client/OpmLoadingOverlay), son envol, l'écran titre
 * (client/OpmTitleScreen), les menus et la musique aux couleurs du launcher.
 * Embarqué dans le launcher, qui l'installe lui-même dans le jeu (launcher/game-files.js).
 */
@Mod(value = Opm.ID, dist = Dist.CLIENT)
public final class Opm {
    public static final String ID = "opm";
    public static final Logger LOG = LoggerFactory.getLogger("OPM");

    public Opm() {
        // Le launcher lit cette ligne : le mod est là, l'écran de chargement suivra.
        LOG.info("[OPM:HELLO] mod OPM chargé");
        NeoForge.EVENT_BUS.addListener(ScreenEvent.Opening.class, event -> {
            Screen next = event.getNewScreen();
            // L'écran titre d'OPM ; et ni solo ni liste de serveurs : on ne joue
            // que sur One Piece Minecraft, depuis le launcher.
            if (next instanceof TitleScreen || next instanceof JoinMultiplayerScreen || next instanceof SelectWorldScreen) {
                event.setNewScreen(new OpmTitleScreen());
            }
        });
        NeoForge.EVENT_BUS.addListener(ScreenEvent.Init.Post.class, event -> {
            if (event.getScreen() instanceof PauseScreen pause) relinkPause(event, pause);
        });
        // L'écran de connexion : le joueur se défait en pixels vers l'orbe.
        NeoForge.EVENT_BUS.addListener(ScreenEvent.BackgroundRendered.class, event -> {
            if (event.getScreen() instanceof ConnectScreen) ConnectFx.render(event.getScreen(), event.getGuiGraphics());
        });
        // Le menu pause : Xenodys passe parfois la tête par le coin.
        NeoForge.EVENT_BUS.addListener(ScreenEvent.Render.Post.class, event -> {
            if (event.getScreen() instanceof PauseScreen) {
                PausePeek.render(event.getScreen(), event.getGuiGraphics(), event.getMouseX(), event.getMouseY());
            }
        });
        // Xenodys dans le monde : les apparitions du staff, la première arrivée.
        NeoForge.EVENT_BUS.addListener(RenderLevelStageEvent.class, WorldXenodys::onRender);
        NeoForge.EVENT_BUS.addListener(RenderNameTagEvent.class, WorldXenodys::onNameTag);
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingIn.class, WorldXenodys::onLogin);
        NeoForge.EVENT_BUS.addListener(ClientTickEvent.Post.class, event -> {
            WorldXenodys.onClientTick();
            fr.onepieceminecraft.opm.client.DebugShots.worldTick();
        });
        NeoForge.EVENT_BUS.addListener(RenderGuiEvent.Post.class, event -> {
            WorldXenodys.onGui(event);
            if (fr.onepieceminecraft.opm.client.DebugShots.enabled()) fr.onepieceminecraft.opm.client.DebugShots.world();
        });
        OpmLive.start();
        // Captures de développement : en dernier, après tout ce qui se dessine.
        if (fr.onepieceminecraft.opm.client.DebugShots.enabled()) {
            NeoForge.EVENT_BUS.addListener(ScreenEvent.Render.Post.class, event -> {
                if (!(event.getScreen() instanceof OpmTitleScreen)) fr.onepieceminecraft.opm.client.DebugShots.menu();
            });
        }
    }

    private static String key(Component c) {
        return c.getContents() instanceof TranslatableContents t ? t.getKey() : "";
    }

    /**
     * Le menu pause : « Donner son avis » et « Signaler un bug » mènent chez
     * Mojang ; à leur place, le site et le Discord d'OPM (liens transmis par le
     * launcher).
     */
    private static void relinkPause(ScreenEvent.Init.Post event, PauseScreen pause) {
        OpmSession session = OpmSession.get();
        for (var listener : new ArrayList<>(event.getListenersList())) {
            if (!(listener instanceof Button b)) continue;
            String k = key(b.getMessage());
            String url;
            String label;
            if ("menu.sendFeedback".equals(k) || "menu.feedback".equals(k)) {
                url = session.website;
                label = "Site OPM";
            } else if ("menu.reportBugs".equals(k)) {
                url = session.discord;
                label = "Discord OPM";
            } else {
                continue;
            }
            event.removeListener(b);
            if (url == null) continue;
            AbstractWidget replacement = Button.builder(Component.literal(label), btn -> ConfirmLinkScreen.confirmLinkNow(pause, url))
                    .bounds(b.getX(), b.getY(), b.getWidth(), b.getHeight()).build();
            event.addListener(replacement);
        }
    }
}
