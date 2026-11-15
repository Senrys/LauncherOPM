package fr.onepieceminecraft.opm.client;

import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;

/**
 * Le fond des menus hors partie (options, mods, connexion, déconnexion…) : la
 * salle de simulation du launcher, à la place du panorama de Minecraft
 * (mixin/ScreenMixin). Une seule salle, partagée par tous les menus.
 */
public final class OpmBackground {
    private static final Lab LAB = new Lab();
    private static long last = -1;

    private OpmBackground() {}

    public static void render(GuiGraphics g) {
        Minecraft mc = Minecraft.getInstance();
        long now = Util.getMillis();
        double dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        var window = mc.getWindow();
        int k = Math.max(1, window.getHeight() / 270);
        int vw = (int) Math.ceil(window.getWidth() / (double) k);
        int vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        g.pose().pushPose();
        g.pose().scale(s, s, 1);
        LAB.render(g, vw, vh, dt, OpmSession.get().etat, 1f);
        g.pose().popPose();
    }
}
