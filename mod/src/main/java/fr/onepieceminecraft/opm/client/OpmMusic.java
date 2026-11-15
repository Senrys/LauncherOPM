package fr.onepieceminecraft.opm.client;

import fr.onepieceminecraft.opm.Opm;
import net.minecraft.core.Holder;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.sounds.Music;
import net.minecraft.sounds.SoundEvent;

/**
 * La musique des menus : celle du launcher (components/ambiance.js),
 * enregistrée par xenodys/musique, créatrice ou corrompue. Ni le launcher ni le
 * jeu ne coupent : le launcher se tait quand le jeu annonce `[OPM:MUSIC]`.
 *
 * Les événements sonores ne sont pas inscrits au registre (il est synchronisé
 * avec le serveur, qui n'a pas le mod) : `Holder.direct` suffit au jeu pour
 * trouver le son dans `assets/opm/sounds.json`.
 */
public final class OpmMusic {
    private static final Music CREATRICE = music("music.menu_creatrice");
    private static final Music CORROMPUE = music("music.menu_corrompue");
    private static boolean announced;

    private OpmMusic() {}

    private static Music music(String id) {
        SoundEvent e = SoundEvent.createVariableRangeEvent(ResourceLocation.fromNamespaceAndPath(Opm.ID, id));
        return new Music(Holder.direct(e), 20, 200, true);
    }

    public static Music menu() {
        return OpmSession.get().corrupted() ? CORROMPUE : CREATRICE;
    }

    public static boolean isOurs(Music m) {
        return m == CREATRICE || m == CORROMPUE;
    }

    /** Le launcher attend ce signal pour se taire : la musique continue, d'une fenêtre à l'autre. */
    public static void announce() {
        if (announced) return;
        announced = true;
        Opm.LOG.info("[OPM:MUSIC] la musique du launcher reprend dans le jeu");
    }
}
