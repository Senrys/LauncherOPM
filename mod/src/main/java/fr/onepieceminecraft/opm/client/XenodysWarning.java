package fr.onepieceminecraft.opm.client;

import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.sounds.SoundEvents;
import net.neoforged.neoforge.client.event.ClientChatReceivedEvent;
import net.neoforged.neoforge.client.event.RenderGuiEvent;

/**
 * « Je te vois… » : Xenodys, corrompue, surgit au coin bas-droit de l'écran
 * d'un joueur soupçonné de triche, et le bord de l'écran rougit un instant.
 *
 * <p>Trois déclencheurs : un pack X-ray repéré par le mod lui-même, un rapport
 * refusé par le serveur d'authentification (client/AntiCheat), ou un message
 * du serveur Minecraft commençant par {@code [OPM:XENODYS]} — c'est ainsi que
 * le Skript anti-triche la fait apparaître ; le message est caché au joueur.
 */
public final class XenodysWarning {
    private static final double LENGTH = 9.0;
    private static final String PREFIX = "[OPM:XENODYS]";
    private static long start = -1;
    private static String line = "Je te vois…";

    private XenodysWarning() {}

    public static void show(String message) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            // Pas deux fois de suite : une apparition toutes les 30 s au plus.
            if (start >= 0 && Util.getMillis() - start < 30_000) return;
            start = Util.getMillis();
            line = message == null || message.isBlank() ? "Je te vois…" : message;
            if (mc.getSoundManager() != null) {
                mc.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.WARDEN_HEARTBEAT, 0.7f, 0.9f));
            }
        });
    }

    /** Les messages {@code [OPM:XENODYS] …} du serveur : jamais affichés, ils l'appellent. */
    public static void onChat(ClientChatReceivedEvent event) {
        String text = event.getMessage().getString();
        if (!text.startsWith(PREFIX)) return;
        event.setCanceled(true);
        String rest = text.substring(PREFIX.length()).trim();
        show(rest.isEmpty() ? "Je te vois…" : rest);
    }

    public static void onGui(RenderGuiEvent.Post event) {
        if (start < 0) return;
        double t = (Util.getMillis() - start) / 1000.0;
        if (t > LENGTH) {
            start = -1;
            return;
        }
        var g = event.getGuiGraphics();
        // Le bord de l'écran qui rougit, puis pâlit.
        double a = Math.max(0, Math.min(1, t / 0.4)) * Math.max(0, 1 - (t - (LENGTH - 1.5)) / 1.5) * 0.45;
        if (a > 0) {
            int c = ((int) (a * 255) << 24) | 0xF0506E;
            int w = g.guiWidth();
            int h = g.guiHeight();
            for (int i = 0; i < 6; i++) {
                int ci = ((int) (a * (6 - i) / 6 * 255) << 24) | 0xF0506E;
                g.fill(i, 0, i + 1, h, ci);
                g.fill(w - i - 1, 0, w - i, h, ci);
                g.fill(0, i, w, i + 1, ci);
                g.fill(0, h - i - 1, w, h - i, ci);
            }
        }
        if (t < LENGTH - 0.6) {
            PausePeek.drawPeek(g, t, line, "corrompue", g.guiWidth() / 2.0, g.guiHeight() / 2.0, true);
        }
    }
}
