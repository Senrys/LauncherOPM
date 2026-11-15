package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.packs.PackType;
import net.minecraft.server.packs.repository.Pack;
import net.neoforged.fml.ModList;

/**
 * Le rapport anti-triche du mod OPM : à l'arrivée sur le serveur, puis toutes
 * les 5 minutes, la liste des mods chargés et des packs de ressources actifs
 * part au serveur d'authentification ({@code POST /api/v1/game/report},
 * authentifié par le jeton de jeu). Le mod repère lui-même les packs « X-ray » :
 * des blocs courants (pierre, ardoise des abîmes, terre, netherrack…) rendus
 * transparents.
 *
 * <p>Un écart : le staff est alerté (côté serveur), et Xenodys apparaît au joueur
 * (client/XenodysWarning). Rien n'est sanctionné automatiquement.
 */
public final class AntiCheat {
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    /** Blocs qu'un pack X-ray rend transparents pour voir les minerais. */
    private static final String[] XRAY_BLOCKS = {"stone", "deepslate", "dirt", "netherrack", "andesite", "diorite",
            "granite", "tuff", "grass_block_side", "gravel"};
    private static ScheduledExecutorService timer;
    private static ScheduledFuture<?> task;

    private AntiCheat() {}

    /** Arrivée sur un serveur (pas en solo) : premier rapport dans 5 s, puis toutes les 5 min. */
    public static synchronized void onJoin() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.isLocalServer()) return;
        if (timer == null) {
            timer = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "OPM anti-triche");
                t.setDaemon(true);
                return t;
            });
        }
        if (task != null) task.cancel(false);
        final boolean[] first = {true};
        task = timer.scheduleWithFixedDelay(() -> {
            String phase = first[0] ? "join" : "periodic";
            first[0] = false;
            mc.execute(() -> send(phase));
        }, 5, 300, TimeUnit.SECONDS);
    }

    public static synchronized void onLeave() {
        if (task != null) task.cancel(false);
        task = null;
    }

    /** Fil de rendu : rassemble le rapport, puis l'envoie en arrière-plan. */
    private static void send(String phase) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getConnection() == null) return;
        JsonObject body = new JsonObject();
        body.addProperty("phase", phase);
        JsonArray mods = new JsonArray();
        for (var info : ModList.get().getMods()) {
            JsonObject m = new JsonObject();
            m.addProperty("id", info.getModId());
            m.addProperty("version", info.getVersion().toString());
            String file = "";
            try {
                var path = info.getOwningFile().getFile().getFilePath();
                if (path != null && path.toString().replace('\\', '/').contains("/mods/")) file = path.getFileName().toString();
            } catch (Exception ignored) {
            }
            m.addProperty("file", file);
            mods.add(m);
        }
        body.add("mods", mods);
        JsonArray packs = new JsonArray();
        List<String> xray = new ArrayList<>();
        for (Pack pack : mc.getResourcePackRepository().getSelectedPacks()) {
            String id = pack.getId();
            if (!id.startsWith("file/")) continue; // vanilla, mods, NeoForge : pas des packs du joueur
            JsonObject p = new JsonObject();
            p.addProperty("id", id);
            p.addProperty("title", pack.getTitle().getString());
            boolean suspicious = isXray(pack);
            p.addProperty("xray", suspicious);
            if (suspicious) xray.add(pack.getTitle().getString());
            packs.add(p);
        }
        body.add("resourcepacks", packs);
        if (!xray.isEmpty()) XenodysWarning.show("Je te vois… « " + xray.get(0) + " » ne te cachera rien.");

        String token = mc.getUser().getAccessToken();
        HTTP.sendAsync(HttpRequest.newBuilder(URI.create(OpmSession.get().api + "/api/v1/game/report"))
                        .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                        .header("Authorization", "Bearer " + token).header("User-Agent", "OPM-mod")
                        .POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(),
                        HttpResponse.BodyHandlers.ofString())
                .thenAccept(r -> {
                    if (r.statusCode() != 200) return;
                    JsonObject o = JsonParser.parseString(r.body()).getAsJsonObject();
                    if (o.has("ok") && !o.get("ok").getAsBoolean()) {
                        String msg = o.has("message") && !o.get("message").isJsonNull() ? o.get("message").getAsString() : null;
                        XenodysWarning.show(msg);
                    }
                })
                .exceptionally(e -> {
                    Opm.LOG.debug("Rapport anti-triche non envoyé : {}", e.toString());
                    return null;
                });
    }

    /** Un pack qui rend transparents des blocs courants : un pack X-ray. */
    static boolean isXray(Pack pack) {
        try (var resources = pack.open()) {
            for (String block : XRAY_BLOCKS) {
                var supplier = resources.getResource(PackType.CLIENT_RESOURCES,
                        ResourceLocation.withDefaultNamespace("textures/block/" + block + ".png"));
                if (supplier == null) continue;
                try (InputStream in = supplier.get(); NativeImage img = NativeImage.read(in)) {
                    int clear = 0;
                    int total = img.getWidth() * img.getHeight();
                    for (int y = 0; y < img.getHeight(); y++) {
                        for (int x = 0; x < img.getWidth(); x++) {
                            if (((img.getPixelRGBA(x, y) >>> 24) & 255) < 128) clear++;
                        }
                    }
                    if (total > 0 && clear > total * 0.4) return true;
                }
            }
        } catch (Exception e) {
            Opm.LOG.debug("Pack « {} » illisible : {}", pack.getId(), e.toString());
        }
        return false;
    }
}
