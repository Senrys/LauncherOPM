package fr.onepieceminecraft.opm.client;

import fr.onepieceminecraft.opm.Opm;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import net.neoforged.fml.loading.FMLPaths;

/**
 * Les signaux du mod au launcher : `hello` (le mod est chargé), `ready` (l'écran
 * de chargement OPM est affiché : le launcher s'efface), `music` (la musique
 * reprend dans le jeu : le launcher se tait).
 *
 * <p>Trois voies, pour qu'aucun montage ne les perde : le fichier
 * `opm/signaux.properties` du dossier du jeu (que le launcher relit pendant le
 * chargement — la voie sûre), la sortie standard, et le journal. Avec certains
 * modpacks (Sinytra Connector…), le journal SLF4J du mod n'arrive jamais à la
 * console : c'est ce qui a laissé le launcher bloqué devant un jeu déjà prêt.
 */
public final class Signal {
    private static final Map<String, Long> SENT = new LinkedHashMap<>();

    private Signal() {}

    public static synchronized void send(String name, String message) {
        if (SENT.containsKey(name)) return;
        SENT.put(name, System.currentTimeMillis());
        String line = "[OPM:" + name.toUpperCase(java.util.Locale.ROOT) + "] " + message;
        System.out.println(line);
        System.out.flush();
        Opm.LOG.info(line);
        try {
            Path dir = FMLPaths.GAMEDIR.get().resolve("opm");
            Files.createDirectories(dir);
            StringBuilder sb = new StringBuilder();
            SENT.forEach((k, v) -> sb.append(k).append('=').append(v).append('\n'));
            Path tmp = dir.resolve("signaux.properties.tmp");
            Files.writeString(tmp, sb.toString(), StandardCharsets.UTF_8);
            Files.move(tmp, dir.resolve("signaux.properties"), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            Opm.LOG.warn("Signal « {} » non écrit : {}", name, e.toString());
        }
    }

    /**
     * La connexion au serveur a échoué ou a été coupée : le message affiché au
     * joueur est recopié dans `opm/deconnexion.txt` (et le journal), pour que le
     * launcher l'inscrive dans le sien — l'écran du jeu, lui, ne laisse aucune trace.
     */
    public static void disconnected(String title, String reason) {
        String text = (title == null ? "" : title) + " : " + (reason == null ? "" : reason);
        System.out.println("[OPM:DISCONNECT] " + text);
        System.out.flush();
        Opm.LOG.info("[OPM:DISCONNECT] {}", text);
        try {
            Path dir = FMLPaths.GAMEDIR.get().resolve("opm");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve("deconnexion.txt"), System.currentTimeMillis() + "\n" + text + "\n",
                    StandardCharsets.UTF_8);
        } catch (Exception e) {
            Opm.LOG.warn("Message de déconnexion non écrit : {}", e.toString());
        }
    }
}
