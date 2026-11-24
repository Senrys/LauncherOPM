package fr.onepieceminecraft.opm.client;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.sounds.SoundEvents;
import net.neoforged.neoforge.client.event.RenderGuiEvent;

/**
 * « Je te vois… » : Xenodys, corrompue, surgit au coin bas-droit de l'écran
 * d'un joueur qui triche, et le bord de l'écran rougit un instant.
 *
 * <p>Deux déclencheurs : un rapport refusé par le serveur d'authentification
 * (client/AntiCheat) — une seule fois par motif et par connexion —, ou le staff
 * ({@code /surveiller}, client/ServerCalls). Un simple soupçon ne la fait pas venir.
 */
public final class XenodysWarning {
    private static final double LENGTH = 9.0;
    /** Les motifs déjà reprochés depuis la connexion. */
    private static final Set<String> WARNED = new HashSet<>();
    private static long start = -1;
    private static long last = -1;
    private static String line = "Je te vois…";

    private XenodysWarning() {}

    public static void reset() {
        Minecraft.getInstance().execute(WARNED::clear);
    }

    /** Des preuves : elle ne vient que si l'une d'elles n'a pas encore été reprochée. */
    static void accuse(Collection<String> reasons, String message) {
        Minecraft.getInstance().execute(() -> {
            if (!WARNED.containsAll(reasons)) {
                WARNED.addAll(reasons);
                show(message);
            }
        });
    }

    public static void show(String message) {
        Minecraft mc = Minecraft.getInstance();
        mc.execute(() -> {
            // Pas deux fois de suite : une apparition toutes les 30 s au plus.
            if (last >= 0 && Util.getMillis() - last < 30_000) return;
            start = last = Util.getMillis();
            line = message == null || message.isBlank() ? "Je te vois…" : message;
            if (mc.getSoundManager() != null) {
                mc.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.WARDEN_HEARTBEAT, 0.7f, 0.9f));
            }
        });
    }

    public static void onGui(RenderGuiEvent.Post event) {
        if (start < 0) return;
        double t = (Util.getMillis() - start) / 1000.0;
        if (t > LENGTH) {
            start = -1;
            return;
        }
        var g = event.getGuiGraphics();
        // Le bord de l'écran bat comme un cœur — deux pulsations par seconde et
        // quelque — puis s'éteint avec elle.
        double presence = Math.max(0, Math.min(1, t / 0.8)) * Math.max(0, Math.min(1, (LENGTH - t) / 1.2));
        double beat = t % 1.15;
        double pulse = Math.exp(-beat * 7) + 0.55 * Math.exp(-Math.max(0, beat - 0.28) * 7) * (beat >= 0.28 ? 1 : 0);
        double a = presence * (0.12 + 0.3 * Math.min(1, pulse));
        if (a > 0.004) {
            int w = g.guiWidth();
            int h = g.guiHeight();
            for (int i = 0; i < 8; i++) {
                int ci = ((int) (a * (8 - i) / 8 * 255) << 24) | 0xF0506E;
                g.fill(i, 0, i + 1, h, ci);
                g.fill(w - i - 1, 0, w - i, h, ci);
                g.fill(0, i, w, i + 1, ci);
                g.fill(0, h - i - 1, w, h - i, ci);
            }
        }
        XenodysCorner.draw(g, t, line, "corrompue", g.guiWidth() / 2.0, g.guiHeight() / 2.0, true, LENGTH - t);
    }
}
