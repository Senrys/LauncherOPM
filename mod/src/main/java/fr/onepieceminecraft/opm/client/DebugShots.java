package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.NativeImage;
import fr.onepieceminecraft.opm.Opm;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;

/**
 * Captures de développement : avec `-Dopm.debug.shots=0.5,2,4` (secondes),
 * l'écran de chargement et l'écran titre s'enregistrent dans `screenshots/`.
 * Sans la propriété, rien ne se passe.
 */
public final class DebugShots {
    private static final List<Double> TIMES = new ArrayList<>();
    private static final List<String> TAKEN = new ArrayList<>();

    static {
        String p = System.getProperty("opm.debug.shots", "");
        for (String s : p.split(",")) {
            try {
                if (!s.isBlank()) TIMES.add(Double.parseDouble(s.trim()));
            } catch (NumberFormatException ignored) {
            }
        }
    }

    private static boolean optionsOpened;
    private static double menuStart = -1;

    private DebugShots() {}

    /** `-Dopm.debug.options=4` : ouvre les options à 4 s ; `-Dopm.debug.quit=9` : quitte. */
    static void drive(net.minecraft.client.gui.screens.Screen title, double t) {
        double open = Double.parseDouble(System.getProperty("opm.debug.options", "-1"));
        double quit = Double.parseDouble(System.getProperty("opm.debug.quit", "-1"));
        if (open >= 0 && t >= open && !optionsOpened) {
            optionsOpened = true;
            Minecraft mc = Minecraft.getInstance();
            mc.setScreen(new net.minecraft.client.gui.screens.options.OptionsScreen(title, mc.options));
        }
        if (quit >= 0 && t >= quit) Minecraft.getInstance().stop();
    }

    /** Captures des menus ordinaires, image complète (ScreenEvent.Render.Post). */
    public static void menu() {
        if (TIMES.isEmpty()) return;
        long now = net.minecraft.Util.getMillis();
        if (menuStart < 0) menuStart = now;
        maybe("menu", (now - menuStart) / 1000.0);
    }

    public static boolean enabled() {
        return !TIMES.isEmpty();
    }

    static void maybe(String tag, double t) {
        if (TIMES.isEmpty()) return;
        for (double at : TIMES) {
            String key = tag + "_" + at;
            if (t >= at && !TAKEN.contains(key)) {
                TAKEN.add(key);
                Minecraft mc = Minecraft.getInstance();
                try (NativeImage img = Screenshot.takeScreenshot(mc.getMainRenderTarget())) {
                    File dir = new File(mc.gameDirectory, "screenshots");
                    dir.mkdirs();
                    img.writeToFile(new File(dir, "opm_" + key + ".png"));
                    Opm.LOG.info("[OPM:SHOT] {}", key);
                } catch (Exception e) {
                    Opm.LOG.warn("capture impossible", e);
                }
            }
        }
    }
}
