package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fr.onepieceminecraft.opm.Opm;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.neoforged.fml.loading.FMLPaths;

/**
 * Ce que le launcher a écrit pour le jeu juste avant de le démarrer :
 * `opm/session.json` dans le dossier de l'instance (launcher/src/main/services/
 * bridge.js). Absent — jeu lancé autrement —, tout retombe sur des valeurs sûres.
 */
public final class OpmSession {
    public record Skin(String url, boolean slim) {}

    public final boolean fromLauncher;
    /** Mis à jour en direct par {@link OpmLive} (la commande /xenodys du staff). */
    public volatile String etat;
    public volatile String message;
    public final String playerName;
    public final String playerUuid;
    public final String host;
    public final int port;
    public final boolean direct;
    public final boolean animations;
    public final String api;
    public final float progressStart;
    /** Début de la scène de chargement (ms, horloge du système), partagé avec le launcher ; 0 : inconnu. */
    public final long sceneStart;
    public final List<Skin> gallery;
    public final String website;
    public final String discord;

    private static OpmSession current;

    private OpmSession(JsonObject o) {
        fromLauncher = o != null;
        JsonObject j = o != null ? o : new JsonObject();
        etat = "corrompue".equals(str(j, "etat")) ? "corrompue" : "creatrice";
        message = str(j, "message");
        JsonObject joueur = j.has("joueur") && j.get("joueur").isJsonObject() ? j.getAsJsonObject("joueur") : new JsonObject();
        playerName = str(joueur, "nom");
        playerUuid = str(joueur, "uuid");
        JsonObject serveur = j.has("serveur") && j.get("serveur").isJsonObject() ? j.getAsJsonObject("serveur") : new JsonObject();
        String h = str(serveur, "hote");
        host = h != null && h.matches("[A-Za-z0-9.-]{1,253}") ? h : "play.onepieceminecraft.fr";
        int p = serveur.has("port") ? serveur.get("port").getAsInt() : 25565;
        port = p > 0 && p < 65536 ? p : 25565;
        direct = !j.has("connexion_directe") || j.get("connexion_directe").getAsBoolean();
        animations = !j.has("animations") || j.get("animations").getAsBoolean();
        String a = str(j, "api");
        api = a != null && a.startsWith("https://") ? a.replaceAll("/+$", "") : "https://auth.onepieceminecraft.fr";
        sceneStart = j.has("scene_debut") ? j.get("scene_debut").getAsLong() : 0L;
        progressStart = j.has("progression_depart") ? Math.max(0, Math.min(0.9f, j.get("progression_depart").getAsFloat())) : 0f;
        List<Skin> skins = new ArrayList<>();
        if (j.has("galerie") && j.get("galerie").isJsonArray()) {
            for (JsonElement e : j.getAsJsonArray("galerie")) {
                if (!e.isJsonObject()) continue;
                String url = str(e.getAsJsonObject(), "url");
                if (url != null && url.startsWith("http")) {
                    skins.add(new Skin(url, e.getAsJsonObject().has("slim") && e.getAsJsonObject().get("slim").getAsBoolean()));
                }
                if (skins.size() >= 32) break;
            }
        }
        gallery = List.copyOf(skins);
        JsonObject liens = j.has("liens") && j.get("liens").isJsonObject() ? j.getAsJsonObject("liens") : new JsonObject();
        String site = str(liens, "site");
        String disc = str(liens, "discord");
        website = site != null && site.startsWith("https://") ? site : "https://onepieceminecraft.fr";
        discord = disc != null && disc.startsWith("https://") ? disc : null;
    }

    private static String str(JsonObject o, String key) {
        if (o == null || !o.has(key) || o.get(key).isJsonNull()) return null;
        try {
            String s = o.get(key).getAsString().trim();
            return s.isEmpty() ? null : s;
        } catch (Exception e) {
            return null;
        }
    }

    public static synchronized OpmSession get() {
        if (current == null) {
            JsonObject o = null;
            Path file = FMLPaths.GAMEDIR.get().resolve("opm").resolve("session.json");
            try {
                if (Files.isRegularFile(file) && Files.size(file) < 256 * 1024) {
                    o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
                }
            } catch (Exception e) {
                Opm.LOG.warn("opm/session.json illisible : valeurs par défaut.", e);
            }
            current = new OpmSession(o);
        }
        return current;
    }

    public String address() {
        return port == 25565 ? host : host + ":" + port;
    }

    public boolean corrupted() {
        return "corrompue".equals(etat);
    }
}
