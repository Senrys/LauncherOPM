package fr.onepieceminecraft.opm.client;

import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceLocation;

/**
 * Le style des menus OPM, appliqué avec retenue : **jamais en jeu**, et jamais
 * quand le serveur a envoyé son pack de ressources — le serveur garde la main
 * sur l'apparence de sa partie. Hors du monde (écran titre, options avant la
 * connexion, déconnexion), les boutons, curseurs et champs prennent les
 * couleurs du launcher (`assets/opm/textures/gui/sprites/widget/`).
 */
public final class MenuStyle {
    private static final Set<String> WIDGETS = Set.of(
            "widget/button", "widget/button_disabled", "widget/button_highlighted",
            "widget/slider", "widget/slider_highlighted", "widget/slider_handle", "widget/slider_handle_highlighted",
            "widget/text_field", "widget/text_field_highlighted");

    private MenuStyle() {}

    /** Hors partie, et aucun pack du serveur actif. */
    public static boolean active() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.level != null) return false;
        for (String id : mc.getResourcePackRepository().getSelectedIds()) {
            if (id.startsWith("server/")) return false;
        }
        return true;
    }

    public static ResourceLocation swap(ResourceLocation sprite) {
        if (sprite == null || !"minecraft".equals(sprite.getNamespace()) || !WIDGETS.contains(sprite.getPath())) {
            return sprite;
        }
        return active() ? ResourceLocation.fromNamespaceAndPath("opm", sprite.getPath()) : sprite;
    }
}
