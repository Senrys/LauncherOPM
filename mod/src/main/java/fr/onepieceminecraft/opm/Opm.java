package fr.onepieceminecraft.opm;

import fr.onepieceminecraft.opm.client.ConnectFx;
import fr.onepieceminecraft.opm.client.OpmLive;
import fr.onepieceminecraft.opm.client.OpmSession;
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
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

/**
 * Le mod One Piece Minecraft, côté client : l'écran de chargement de Xenodys
 * (mixin/MinecraftMixin → client/OpmLoadingOverlay), son envol, l'écran titre
 * (client/OpmTitleScreen), les menus et la musique aux couleurs du launcher.
 * Embarqué dans le launcher, qui l'installe lui-même dans le jeu (launcher/game-files.js).
 */
@Mod(value = Opm.ID, dist = Dist.CLIENT)
public final class Opm {
    public static final String ID = "opm";
    /** Log4j directement : un journal SLF4J peut être détourné par certains modpacks. */
    public static final Logger LOG = LogManager.getLogger("OPM");

    public Opm(net.neoforged.bus.api.IEventBus modBus) {
        modBus.addListener(fr.onepieceminecraft.opm.client.PackSounds::register);
        // Le launcher lit cette ligne : le mod est là, l'écran de chargement suivra.
        fr.onepieceminecraft.opm.client.Signal.send("hello", "mod OPM chargé");
        NeoForge.EVENT_BUS.addListener(ScreenEvent.Opening.class, event -> {
            Screen next = event.getNewScreen();
            // L'écran titre d'OPM ; et ni solo ni liste de serveurs : on ne joue
            // que sur One Piece Minecraft, depuis le launcher.
            if (next instanceof net.minecraft.client.gui.screens.DisconnectedScreen lost) {
                try {
                    var details = ((fr.onepieceminecraft.opm.mixin.DisconnectedScreenAccessor) lost).opm$details();
                    fr.onepieceminecraft.opm.client.Signal.disconnected(lost.getTitle().getString(),
                            details == null ? "" : details.reason().getString());
                } catch (RuntimeException e) {
                    LOG.warn("Écran de déconnexion illisible : {}", e.toString());
                }
            }
            // Les packs de ressources : seul celui du serveur s'applique sur OPM.
            // (Le même écran sert aux packs de données d'un monde solo : on ne bloque
            // que celui des packs de ressources, reconnu à son titre.)
            if (next instanceof net.minecraft.client.gui.screens.packs.PackSelectionScreen
                    && "resourcePack.title".equals(key(next.getTitle()))) {
                event.setCanceled(true);
                return;
            }
            // La liste des mods : le modpack est imposé, il n'y a rien à y régler.
            if (next instanceof net.neoforged.neoforge.client.gui.ModListScreen) {
                event.setCanceled(true);
                return;
            }
            if (next instanceof TitleScreen || next instanceof JoinMultiplayerScreen || next instanceof SelectWorldScreen) {
                event.setNewScreen("1".equals(System.getProperty("opm.debug.scene", ""))
                        ? new fr.onepieceminecraft.opm.client.ScenePreview() : new OpmTitleScreen());
            }
        });
        NeoForge.EVENT_BUS.addListener(ScreenEvent.Init.Post.class, event -> {
            if (event.getScreen() instanceof PauseScreen pause) {
                removeMods(event);
                relinkPause(event, pause);
            }
            if (event.getScreen() instanceof net.minecraft.client.gui.screens.options.OptionsScreen) lockResourcePacks(event);
        });
        // L'écran de connexion : le joueur se défait en pixels vers l'orbe.
        NeoForge.EVENT_BUS.addListener(ScreenEvent.BackgroundRendered.class, event -> {
            if (event.getScreen() instanceof ConnectScreen) ConnectFx.render(event.getScreen(), event.getGuiGraphics());
        });
        // Xenodys dans le monde : les apparitions du staff, la première arrivée.
        NeoForge.EVENT_BUS.addListener(RenderLevelStageEvent.class, WorldXenodys::onRender);
        NeoForge.EVENT_BUS.addListener(RenderNameTagEvent.class, WorldXenodys::onNameTag);
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingIn.class, event -> {
            WorldXenodys.onLogin(event);
            fr.onepieceminecraft.opm.client.AntiCheat.onJoin();
        });
        NeoForge.EVENT_BUS.addListener(ClientPlayerNetworkEvent.LoggingOut.class, event -> {
            WorldXenodys.onLogout();
            fr.onepieceminecraft.opm.client.AntiCheat.onLeave();
        });
        // Les appels du serveur Minecraft (Skript) : avertissement, contrôle, arrivée.
        NeoForge.EVENT_BUS.addListener(net.neoforged.neoforge.client.event.ClientChatReceivedEvent.class,
                fr.onepieceminecraft.opm.client.ServerCalls::onChat);
        NeoForge.EVENT_BUS.addListener(ClientTickEvent.Post.class, event -> {
            WorldXenodys.onClientTick();
            fr.onepieceminecraft.opm.client.DebugShots.worldTick();
        });
        NeoForge.EVENT_BUS.addListener(RenderGuiEvent.Post.class, event -> {
            WorldXenodys.onGui(event);
            fr.onepieceminecraft.opm.client.XenodysWarning.onGui(event);
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
     * Les options : le bouton « Packs de ressources » reste à sa place (la grille
     * ne se troue pas) mais grisé, avec une bulle qui dit pourquoi.
     */
    private static void lockResourcePacks(ScreenEvent.Init.Post event) {
        for (var listener : event.getListenersList()) {
            if (listener instanceof Button b && "options.resourcepack".equals(key(b.getMessage()))) {
                b.active = false;
                b.setTooltip(net.minecraft.client.gui.components.Tooltip.create(
                        Component.literal("Sur One Piece Minecraft, le pack de ressources est fourni par le serveur.")));
            }
        }
    }

    /** Le menu pause : le bouton « Mods » s'en va, ceux du dessous remontent. */
    private static void removeMods(ScreenEvent.Init.Post event) {
        for (var listener : new ArrayList<>(event.getListenersList())) {
            if (!(listener instanceof Button b) || !"fml.menu.mods".equals(key(b.getMessage()))) continue;
            event.removeListener(b);
            for (var other : event.getListenersList()) {
                if (other instanceof AbstractWidget w && w.getY() > b.getY() && w.getX() == b.getX()) w.setY(w.getY() - b.getHeight() - 4);
            }
        }
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
