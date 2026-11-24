package fr.onepieceminecraft.opm.client;

import net.neoforged.neoforge.client.event.ClientChatReceivedEvent;

/**
 * Les appels du serveur Minecraft au mod : des messages système commençant par
 * {@code [OPM:…]} (minecraft/anticheat.sk, minecraft/xenodys.sk), jamais affichés
 * au joueur.
 *
 * <ul>
 *   <li>{@code [OPM:XENODYS] texte} — Xenodys corrompue avertit le joueur ;</li>
 *   <li>{@code [OPM:CONTROLE]} — un rapport anti-triche, tout de suite ;</li>
 *   <li>{@code [OPM:ARRIVEE]} — rejoue la scène de première arrivée.</li>
 * </ul>
 *
 * <p>Les messages de discussion des joueurs ne sont jamais des appels.
 */
public final class ServerCalls {
    private static final String WARNING = "[OPM:XENODYS]";
    private static final String CONTROL = "[OPM:CONTROLE]";
    private static final String ARRIVAL = "[OPM:ARRIVEE]";

    private ServerCalls() {}

    public static void onChat(ClientChatReceivedEvent event) {
        if (!event.isSystem()) return;
        String text = event.getMessage().getString();
        if (text.startsWith(WARNING)) {
            event.setCanceled(true);
            XenodysWarning.show(text.substring(WARNING.length()).trim());
        } else if (text.startsWith(CONTROL)) {
            event.setCanceled(true);
            AntiCheat.control();
        } else if (text.startsWith(ARRIVAL)) {
            event.setCanceled(true);
            WorldXenodys.playArrival();
        }
    }
}
