package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fr.onepieceminecraft.opm.Opm;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;

/**
 * Les appels du mod au serveur d'authentification au nom du joueur
 * ({@code /api/v1/game/…}), authentifiés par le jeton de jeu. Toujours en
 * arrière-plan ; une panne ne se voit pas en jeu.
 */
final class GameApi {
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    private GameApi() {}

    private static HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(URI.create(OpmSession.get().api + "/api/v1/game/" + path))
                .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + Minecraft.getInstance().getUser().getAccessToken())
                .header("User-Agent", "OPM-mod");
    }

    static void get(String path, Consumer<JsonObject> then) {
        send(request(path).GET().build(), path, then);
    }

    static void post(String path, JsonObject body, Consumer<JsonObject> then) {
        send(request(path).POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(), path, then);
    }

    private static void send(HttpRequest request, String path, Consumer<JsonObject> then) {
        HTTP.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenAccept(r -> {
                    if (r.statusCode() == 200) then.accept(JsonParser.parseString(r.body()).getAsJsonObject());
                })
                .exceptionally(e -> {
                    Opm.LOG.debug("{} : sans réponse ({})", path, e.toString());
                    return null;
                });
    }
}
