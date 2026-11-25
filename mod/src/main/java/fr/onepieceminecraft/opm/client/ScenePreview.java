package fr.onepieceminecraft.opm.client;

import net.minecraft.Util;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * Développement seulement (`-Dopm.debug.scene=1`) : la scène de chargement jouée
 * en boucle à la place de l'écran titre, pour la regarder et la capturer.
 */
public final class ScenePreview extends Screen {
    static {
        LabScene.reset();
    }

    private final LoadingScene scene = new LoadingScene();
    private static final double DURATION = Double.parseDouble(System.getProperty("opm.debug.duration", "26"));
    private final long start = Util.getMillis();

    public ScenePreview() {
        super(Component.literal("Aperçu de la scène"));
        Skins.start(OpmSession.get());
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        double t = (Util.getMillis() - start) / 1000.0;
        var window = minecraft.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        g.pose().pushPose();
        g.pose().scale(s, s, 1);
        float ratio = (float) Math.min(1, t / DURATION * 1.25);
        scene.render(g, vw, vh, t, ratio, "Assemblage du monde", OpmSession.get().etat, true, -1, OpmSession.get().playerName);
        g.pose().popPose();
        DebugShots.maybe("scene", t);
        if (t > DURATION) minecraft.stop();
    }

    @Override
    public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
    }
}
