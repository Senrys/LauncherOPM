package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.NativeImage;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
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
 * les 5 minutes, et quand le staff le demande ({@code /controle}), la liste des
 * mods chargés (avec l'empreinte de leur fichier) et des packs de ressources
 * actifs part au serveur d'authentification ({@code POST /api/v1/game/report},
 * authentifié par le jeton de jeu). Le mod repère lui-même les packs « X-ray » :
 * des blocs courants (pierre, ardoise des abîmes, terre, netherrack…) rendus
 * transparents.
 *
 * <p>Un écart : le staff est alerté (côté serveur), et Xenodys apparaît au joueur
 * (client/XenodysWarning). Rien n'est sanctionné automatiquement.
 */
public final class AntiCheat {
    /** Blocs qu'un pack X-ray rend transparents pour voir les minerais. */
    private static final String[] XRAY_BLOCKS = {"stone", "deepslate", "dirt", "netherrack", "andesite", "diorite",
            "granite", "tuff", "grass_block_side", "gravel"};
    private static ScheduledExecutorService timer;
    private static ScheduledFuture<?> task;
    private static long lastControl;
    /** Empreintes déjà calculées : les fichiers ne changent pas pendant la partie. */
    private static final Map<Path, String> HASHES = new HashMap<>();

    private AntiCheat() {}

    /** Arrivée sur un serveur (pas en solo) : premier rapport dans 5 s, puis toutes les 5 min. */
    public static synchronized void onJoin() {
        Minecraft mc = Minecraft.getInstance();
        XenodysWarning.reset();
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

    /** Le staff demande un rapport : tout de suite (un toutes les 5 s au plus). */
    public static synchronized void control() {
        long now = System.currentTimeMillis();
        if (timer == null || task == null || now - lastControl < 5_000) return;
        lastControl = now;
        Minecraft.getInstance().execute(() -> send("controle"));
    }

    /** Le SHA-1 d'un fichier posé directement dans {@code mods/} ; vide sinon. */
    private static String hash(Path path) {
        if (path == null) return "";
        return HASHES.computeIfAbsent(path, p -> {
            try (InputStream in = new DigestInputStream(Files.newInputStream(p), MessageDigest.getInstance("SHA-1"))) {
                in.transferTo(java.io.OutputStream.nullOutputStream());
                return HexFormat.of().formatHex(((DigestInputStream) in).getMessageDigest().digest());
            } catch (Exception e) {
                return "";
            }
        });
    }

    /** Fil de rendu : rassemble le rapport, puis l'envoie en arrière-plan. */
    private static void send(String phase) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.getConnection() == null) return;
        JsonObject body = new JsonObject();
        body.addProperty("phase", phase);
        body.addProperty("launcher", OpmSession.get().launcher);
        JsonArray mods = new JsonArray();
        List<Path> files = new ArrayList<>();
        for (var info : ModList.get().getMods()) {
            JsonObject m = new JsonObject();
            m.addProperty("id", info.getModId());
            m.addProperty("version", info.getVersion().toString());
            String file = "";
            Path plain = null;
            try {
                var path = info.getOwningFile().getFile().getFilePath();
                if (path != null && path.toString().replace('\\', '/').contains("/mods/")) {
                    file = path.getFileName().toString();
                    // Pas les copies converties (mods/.connector) : leur contenu diffère.
                    if (path.getFileSystem() == FileSystems.getDefault() && path.getParent() != null
                            && "mods".equals(String.valueOf(path.getParent().getFileName()))) plain = path;
                }
            } catch (Exception ignored) {
            }
            m.addProperty("file", file);
            mods.add(m);
            files.add(plain);
        }
        body.add("mods", mods);
        JsonArray packs = new JsonArray();
        for (Pack pack : mc.getResourcePackRepository().getSelectedPacks()) {
            String id = pack.getId();
            if (!id.startsWith("file/")) continue; // vanilla, mods, NeoForge : pas des packs du joueur
            JsonObject p = new JsonObject();
            p.addProperty("id", id);
            p.addProperty("title", pack.getTitle().getString());
            p.addProperty("xray", isXray(pack));
            packs.add(p);
        }
        body.add("resourcepacks", packs);

        // Les empreintes se calculent hors du fil de rendu.
        timer.execute(() -> {
            for (int i = 0; i < files.size(); i++) {
                mods.get(i).getAsJsonObject().addProperty("sha1", hash(files.get(i)));
            }
            GameApi.post("report", body, o -> {
                if (!o.has("ok") || o.get("ok").getAsBoolean()) return;
                List<String> reasons = new ArrayList<>();
                if (o.has("reasons") && o.get("reasons").isJsonArray()) {
                    o.getAsJsonArray("reasons").forEach(r -> reasons.add(r.getAsString()));
                }
                XenodysWarning.accuse(reasons, o.has("message") && !o.get("message").isJsonNull()
                        ? o.get("message").getAsString() : null);
            });
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
