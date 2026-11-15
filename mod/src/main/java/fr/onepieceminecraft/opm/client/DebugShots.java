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
        if (createWorld(t)) return;
        double open = Double.parseDouble(System.getProperty("opm.debug.options", "-1"));
        double quit = Double.parseDouble(System.getProperty("opm.debug.quit", "-1"));
        if (open >= 0 && t >= open && !optionsOpened) {
            optionsOpened = true;
            Minecraft mc = Minecraft.getInstance();
            mc.setScreen(new net.minecraft.client.gui.screens.options.OptionsScreen(title, mc.options));
        }
        if (quit >= 0 && t >= quit) Minecraft.getInstance().stop();
    }

    private static double worldStart = -1;
    private static boolean created;
    private static boolean summoned;
    private static boolean paused;

    /** `-Dopm.debug.world=1` : depuis l'écran titre, crée un monde de test en solo. */
    static boolean createWorld(double t) {
        if (!"1".equals(System.getProperty("opm.debug.world", "")) || created || t < 3) return false;
        created = true;
        Minecraft mc = Minecraft.getInstance();
        var settings = new net.minecraft.world.level.LevelSettings("opm-test", net.minecraft.world.level.GameType.CREATIVE,
                false, net.minecraft.world.Difficulty.PEACEFUL, true, new net.minecraft.world.level.GameRules(),
                net.minecraft.world.level.WorldDataConfiguration.DEFAULT);
        mc.createWorldOpenFlows().createFreshLevel("opm-test-" + System.currentTimeMillis(), settings,
                new net.minecraft.world.level.levelgen.WorldOptions(42L, false, false),
                net.minecraft.world.level.levelgen.presets.WorldPresets::createNormalWorldDimensions, mc.screen);
        return true;
    }

    /**
     * Une fois en jeu (monde de test) : invoque Xenodys devant le joueur (à 8 s),
     * puis ouvre le menu pause (à 16 s), puis quitte.
     */
    public static void worldTick() {
        if (!"1".equals(System.getProperty("opm.debug.world", ""))) return;
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;
        long now = net.minecraft.Util.getMillis();
        if (worldStart < 0) worldStart = now;
        double t = (now - worldStart) / 1000.0;
        if (t > 8 && !summoned) {
            summoned = true;
            mc.player.connection.sendCommand("execute at @s rotated ~ 0 positioned ^ ^ ^8 run summon minecraft:armor_stand ~ ~-1 ~ "
                    + "{Invisible:1b,Marker:1b,NoGravity:1b,Tags:[\"opm_xenodys\"],CustomName:'\"opm:xenodys:idle\"'}");
            mc.player.connection.sendCommand("execute as @e[tag=opm_xenodys,limit=1] at @s run tp @s ~ ~ ~ facing entity @p feet");
        }
        if (t > 16 && !paused) {
            paused = true;
            mc.setScreen(new net.minecraft.client.gui.screens.PauseScreen(true));
        }
        if (t > 24) mc.stop();
    }

    public static void world() {
        if (TIMES.isEmpty() || worldStart < 0) return;
        maybe("monde", (net.minecraft.Util.getMillis() - worldStart) / 1000.0);
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
