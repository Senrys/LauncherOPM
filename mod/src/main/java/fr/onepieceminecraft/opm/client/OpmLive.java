package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Ce qui change pendant la partie, relu comme le fait le launcher : l'état de
 * Xenodys et l'annonce du staff (`/api/v1/xenodys`, toutes les 60 s), l'état du
 * serveur (`/api/v1/status`, toutes les 20 s). Écrans et Xenodys en jeu suivent
 * sans redémarrer.
 */
public final class OpmLive {
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build();
    private static ScheduledExecutorService timer;

    /** Le serveur : `known` faux tant qu'aucune réponse n'est arrivée. */
    public static volatile boolean known;
    public static volatile boolean online;
    public static volatile int players;
    public static volatile int max;
    public static volatile String news;

    private OpmLive() {}

    public static synchronized void start() {
        if (timer != null) return;
        timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "OPM direct");
            t.setDaemon(true);
            return t;
        });
        timer.scheduleWithFixedDelay(OpmLive::status, 0, 20, TimeUnit.SECONDS);
        timer.scheduleWithFixedDelay(OpmLive::xenodys, 5, 60, TimeUnit.SECONDS);
        timer.schedule(OpmLive::news, 1, TimeUnit.SECONDS);
    }

    public static boolean full() {
        return known && online && max > 0 && players >= max;
    }

    private static JsonObject get(String path) {
        try {
            HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(OpmSession.get().api + path))
                    .timeout(Duration.ofSeconds(6)).header("User-Agent", "OPM-mod").GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            return r.statusCode() == 200 ? JsonParser.parseString(r.body()).getAsJsonObject() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void status() {
        // Développement : -Dopm.debug.status=offline|full
        String forced = System.getProperty("opm.debug.status", "");
        if (!forced.isEmpty()) {
            known = true;
            online = !forced.equals("offline");
            players = forced.equals("full") ? 60 : 3;
            max = 60;
            return;
        }
        JsonObject o = get("/api/v1/status");
        if (o == null) {
            known = true;
            online = false;
            return;
        }
        online = o.has("online") && o.get("online").getAsBoolean();
        players = o.has("players_online") ? o.get("players_online").getAsInt() : 0;
        max = o.has("players_max") ? o.get("players_max").getAsInt() : 0;
        known = true;
    }

    private static void xenodys() {
        // Développement : -Dopm.debug.etat=corrompue
        String forced = System.getProperty("opm.debug.etat", "");
        if ("bascule".equals(forced)) {
            OpmSession.get().etat = OpmSession.get().corrupted() ? "creatrice" : "corrompue";
            return;
        }
        if (!forced.isEmpty()) {
            OpmSession.get().etat = forced;
            return;
        }
        JsonObject o = get("/api/v1/xenodys");
        if (o == null) return;
        OpmSession s = OpmSession.get();
        s.etat = o.has("etat") && "corrompue".equals(o.get("etat").getAsString()) ? "corrompue" : "creatrice";
        s.message = o.has("message") && !o.get("message").isJsonNull() ? o.get("message").getAsString() : null;
    }

    private static void news() {
        JsonObject o = get("/api/v1/news?limit=1");
        if (o != null && o.has("featured") && o.get("featured").isJsonObject() && o.getAsJsonObject("featured").has("title")) {
            news = o.getAsJsonObject("featured").get("title").getAsString();
        }
    }
}
