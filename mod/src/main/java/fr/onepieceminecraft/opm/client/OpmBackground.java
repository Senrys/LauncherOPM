package fr.onepieceminecraft.opm.client;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;

/**
 * Le fond des menus hors partie (options, mods, connexion, déconnexion…) : le
 * laboratoire, assombri pour que le texte reste lisible, à la place du panorama
 * de Minecraft (mixin/ScreenMixin).
 */
public final class OpmBackground {
    private static final LabScene.View VIEW = new LabScene.View();

    private OpmBackground() {}

    public static void render(GuiGraphics g) {
        var window = Minecraft.getInstance().getWindow();
        g.flush();
        VIEW.etat = OpmSession.get().etat;
        VIEW.menu = 1;
        VIEW.tankDown = 1;
        VIEW.drain = 1;
        VIEW.inMenu = true;
        LabScene.get().render(window.getWidth(), window.getHeight(), LabScene.clock(), VIEW);
        g.fill(0, 0, g.guiWidth(), g.guiHeight(), 0xB0060B0E);
    }
}
