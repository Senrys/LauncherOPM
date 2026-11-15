package fr.onepieceminecraft.opm.client;

import com.mojang.blaze3d.platform.InputConstants;
import fr.onepieceminecraft.opm.Opm;
import fr.onepieceminecraft.opm.mixin.LoadingOverlayAccessor;
import java.util.Optional;
import java.util.function.Consumer;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.LoadingOverlay;
import net.minecraft.client.gui.screens.Overlay;
import net.minecraft.server.packs.resources.ReloadInstance;
import org.lwjgl.glfw.GLFW;

/**
 * L'écran de chargement de Minecraft (celui de Mojang, ou celui de NeoForge),
 * remplacé par la scène de Xenodys. Il reprend la logique de fin de
 * `LoadingOverlay` : quand le rechargement est fini, Xenodys s'envole (au
 * premier chargement), puis le monde s'ouvre — écran de connexion au serveur
 * OPM, ou écran titre — et la scène s'efface par-dessus.
 *
 * Le premier affichage écrit `[OPM:READY]` dans le journal : le launcher, qui
 * couvrait jusque-là le chargement des mods, s'efface à ce signal.
 */
public final class OpmLoadingOverlay extends Overlay {
    private static final double FADE = 0.6;
    private static final String[] STEPS = {
            "Compilation des fruits du démon",
            "Synchronisation des primes",
            "Assemblage de Grand Line",
            "Calibrage des vents de la simulation",
            "Ouverture du monde",
    };
    private static boolean readySent;
    private static final long sceneFallback = System.currentTimeMillis();
    private static LoadingScene scene;

    private final Minecraft minecraft;
    private final LoadingOverlay inner;
    private final ReloadInstance reload;
    private final Consumer<Optional<Throwable>> onFinish;
    private final boolean first;
    private final OpmSession session = OpmSession.get();
    private float progress;
    private long last = -1;
    private double doneAt = -1;
    private double finishedAt = -1;
    private double clock;

    public OpmLoadingOverlay(Minecraft minecraft, LoadingOverlay inner) {
        this.minecraft = minecraft;
        this.inner = inner;
        LoadingOverlayAccessor acc = (LoadingOverlayAccessor) inner;
        this.reload = acc.opm$reload();
        this.onFinish = acc.opm$onFinish();
        this.first = !minecraft.isGameLoadFinished();
        if (scene == null) scene = new LoadingScene();
        Skins.start(session);
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        long now = Util.getMillis();
        double dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        clock += dt;
        if (!readySent) {
            readySent = true;
            Opm.LOG.info("[OPM:READY] écran de chargement OPM affiché");
        }

        float actual = reload.getActualProgress();
        progress = Math.max(progress, Math.min(1f, progress * 0.9f + actual * 0.1f));
        float start = first ? session.progressStart : 0f;
        float ratio = start + (1 - start) * progress;

        boolean outroWanted = first && session.animations;
        if (doneAt < 0 && reload.isDone()) {
            doneAt = clock;
            if (!outroWanted) finish(g);
        }
        double outro = doneAt >= 0 && outroWanted ? clock - doneAt : -1;
        if (outro >= 0 && finishedAt < 0 && (outro >= LoadingScene.OUTRO || skipPressed())) finish(g);

        double fade = finishedAt >= 0 ? (clock - finishedAt) / FADE : 0;
        if (finishedAt >= 0 && minecraft.screen != null) {
            minecraft.screen.render(g, 0, 0, partialTick);
        }
        if (fade < 1) {
            int stepIndex = Math.min(STEPS.length - 1, (int) Math.floor(progress * STEPS.length));
            drawScene(g, dt, ratio, STEPS[stepIndex], finishedAt >= 0 ? Math.max(outro, LoadingScene.OUTRO) : outro,
                    (float) (1 - fade));
        }
        DebugShots.maybe(doneAt >= 0 ? "outro" : "load", doneAt >= 0 ? clock - doneAt : clock);
        if (fade >= 1) {
            minecraft.setOverlay(null);
            closeInner();
        }
    }

    private void drawScene(GuiGraphics g, double dt, float ratio, String step, double outro, float alpha) {
        var window = minecraft.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        var pose = g.pose();
        pose.pushPose();
        pose.scale(s, s, 1);
        // Fondu de sortie : la scène pâlit au-dessus de l'écran qui l'attend.
        Sprites.alpha = alpha;
        try {
            // L'horloge de la scène : celle du launcher (scene_debut), pour continuer sa chorégraphie.
            long epoch = session.sceneStart > 0 ? session.sceneStart : sceneFallback;
            double sceneT = (System.currentTimeMillis() - epoch) / 1000.0;
            scene.render(g, vw, vh, sceneT, ratio, step, session.etat, outro, session.playerName);
            g.flush();
        } finally {
            Sprites.alpha = 1f;
            pose.popPose();
            g.setColor(1, 1, 1, 1);
        }
    }

    private boolean skipPressed() {
        long w = minecraft.getWindow().getWindow();
        return InputConstants.isKeyDown(w, GLFW.GLFW_KEY_ESCAPE) || InputConstants.isKeyDown(w, GLFW.GLFW_KEY_SPACE)
                || InputConstants.isKeyDown(w, GLFW.GLFW_KEY_ENTER)
                || GLFW.glfwGetMouseButton(w, GLFW.GLFW_MOUSE_BUTTON_LEFT) == GLFW.GLFW_PRESS;
    }

    /** La fin de `LoadingOverlay` : le jeu reprend la main (connexion ou écran titre). */
    private void finish(GuiGraphics g) {
        if (finishedAt >= 0) return;
        finishedAt = clock;
        try {
            reload.checkExceptions();
            onFinish.accept(Optional.empty());
        } catch (Throwable t) {
            onFinish.accept(Optional.of(t));
        }
        if (minecraft.screen != null) {
            minecraft.screen.init(minecraft, minecraft.getWindow().getGuiScaledWidth(), minecraft.getWindow().getGuiScaledHeight());
        }
    }

    /** L'écran de NeoForge garde une fenêtre de démarrage ouverte : on la referme comme lui. */
    private void closeInner() {
        if (!inner.getClass().getName().endsWith("NeoForgeLoadingOverlay")) return;
        for (String[] f : new String[][]{{"progressMeter", "complete"}, {"displayWindow", "close"}}) {
            try {
                var field = inner.getClass().getDeclaredField(f[0]);
                field.setAccessible(true);
                Object o = field.get(inner);
                if (o != null) o.getClass().getMethod(f[1]).invoke(o);
            } catch (Throwable t) {
                Opm.LOG.debug("Fermeture de l'écran NeoForge : {}", t.toString());
            }
        }
    }

    @Override
    public boolean isPauseScreen() {
        return true;
    }
}
