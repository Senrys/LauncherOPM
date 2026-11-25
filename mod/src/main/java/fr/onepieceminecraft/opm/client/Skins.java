package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import fr.onepieceminecraft.opm.Opm;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;

/**
 * Les skins que les assistants « impriment » pendant le chargement : la galerie
 * transmise par le launcher (skins de joueurs OPM, anonymes), **dans son ordre**
 * — le même que la scène du launcher, pour que le relais ne se voie pas — et le
 * skin du joueur lui-même. Chaque skin devient une texture, posée sur le modèle
 * 3D du joueur (`joueur` / `joueur_fin`, client/LabScene).
 *
 * Téléchargés hors du fil de rendu ; les textures sont créées sur lui.
 */
public final class Skins {
    /** Un skin prêt : sa texture, et des bras fins ou larges. */
    public record Printed(ResourceLocation texture, boolean own, boolean slim) {}

    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4))
            .followRedirects(HttpClient.Redirect.NORMAL).build();
    private static final ConcurrentLinkedQueue<Object[]> READY = new ConcurrentLinkedQueue<>();
    private static final List<Printed> PRINTED = Collections.synchronizedList(new ArrayList<>());
    private static int gallerySize;
    private static Printed own;
    private static boolean started;
    private static boolean fallbackAsked;
    private static int counter;

    private Skins() {}

    /** Lance les téléchargements (une seule fois). */
    public static synchronized void start(OpmSession session) {
        if (started) return;
        started = true;
        Thread t = new Thread(() -> {
            List<OpmSession.Skin> list = session.gallery.subList(0, Math.min(16, session.gallery.size()));
            gallerySize = list.size();
            for (int i = 0; i < list.size(); i++) {
                byte[] png = fetch(list.get(i).url());
                READY.add(new Object[]{png, list.get(i).slim(), false, i});
            }
            String uuid = session.playerUuid != null && session.playerUuid.matches("[0-9a-fA-F-]{32,36}")
                    ? session.playerUuid.replace("-", "") : null;
            if (uuid == null) uuid = uuidByName(session);
            if (uuid != null) {
                try {
                    byte[] profile = fetch(session.api + "/yggdrasil/sessionserver/session/minecraft/profile/" + uuid);
                    if (profile != null) {
                        JsonObject p = JsonParser.parseString(new String(profile, StandardCharsets.UTF_8)).getAsJsonObject();
                        for (var e : p.getAsJsonArray("properties")) {
                            JsonObject prop = e.getAsJsonObject();
                            if (!"textures".equals(prop.get("name").getAsString())) continue;
                            JsonObject tex = JsonParser.parseString(new String(Base64.getDecoder()
                                    .decode(prop.get("value").getAsString()), StandardCharsets.UTF_8)).getAsJsonObject();
                            JsonObject skin = tex.getAsJsonObject("textures").getAsJsonObject("SKIN");
                            boolean slim = skin.has("metadata") && "slim".equals(skin.getAsJsonObject("metadata").get("model").getAsString());
                            byte[] png = fetch(skin.get("url").getAsString());
                            if (png != null) READY.add(new Object[]{png, slim, true, -1});
                        }
                    }
                } catch (Exception e) {
                    Opm.LOG.debug("Skin du joueur indisponible", e);
                }
            }
        }, "OPM skins");
        t.setDaemon(true);
        t.start();
    }

    /** L'UUID du joueur d'après son pseudo (session sans UUID), auprès de notre Yggdrasil. */
    private static String uuidByName(OpmSession session) {
        String name = session.playerName != null ? session.playerName : Minecraft.getInstance().getUser().getName();
        if (name == null || !name.matches("[A-Za-z0-9_]{1,16}")) return null;
        try {
            HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(session.api + "/yggdrasil/api/profiles/minecraft"))
                    .timeout(Duration.ofSeconds(6)).header("Content-Type", "application/json").header("User-Agent", "OPM-mod")
                    .POST(HttpRequest.BodyPublishers.ofString("[\"" + name + "\"]")).build(), HttpResponse.BodyHandlers.ofString());
            if (r.statusCode() != 200) return null;
            var arr = JsonParser.parseString(r.body()).getAsJsonArray();
            return arr.isEmpty() ? null : arr.get(0).getAsJsonObject().get("id").getAsString();
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] fetch(String url) {
        try {
            HttpResponse<byte[]> r = HTTP.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(6))
                    .header("User-Agent", "OPM-mod").GET().build(), HttpResponse.BodyHandlers.ofByteArray());
            return r.statusCode() == 200 && r.body().length < 512 * 1024 ? r.body() : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** Fil de rendu : transforme les skins arrivés en textures. */
    public static void pump() {
        Object[] item;
        while ((item = READY.poll()) != null) {
            int index = (Integer) item[3];
            if (item[0] == null) {
                set(index, null);
                continue;
            }
            try {
                NativeImage skin = NativeImage.read(new ByteArrayInputStream((byte[]) item[0]));
                boolean slim = (Boolean) item[1];
                ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/skin_" + (counter++));
                Minecraft.getInstance().getTextureManager().register(id, new DynamicTexture(skin));
                Printed p = new Printed(id, (Boolean) item[2], slim);
                if (p.own()) own = p;
                else set(index, p);
            } catch (Exception e) {
                Opm.LOG.debug("Skin illisible", e);
                if (index >= 0) set(index, null);
            }
        }
    }

    private static void set(int index, Printed p) {
        if (index < 0) return;
        synchronized (PRINTED) {
            while (PRINTED.size() <= index) PRINTED.add(null);
            PRINTED.set(index, p);
        }
    }

    /** Taille de la galerie annoncée par le launcher (certains skins peuvent manquer). */
    public static int gallerySize() {
        return gallerySize;
    }

    /** Le skin n° `index` de la galerie, s'il est arrivé (sinon `null`). */
    public static Printed galleryAt(int index) {
        synchronized (PRINTED) {
            return index >= 0 && index < PRINTED.size() ? PRINTED.get(index) : null;
        }
    }

    public static Printed own() {
        return own;
    }

    /**
     * Sans skin du joueur (jeu lancé hors du launcher, serveur injoignable) :
     * l'apparence par défaut de Minecraft, une fois les ressources chargées.
     */
    public static void fallbackOwn() {
        if (own != null || fallbackAsked) return;
        fallbackAsked = true;
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(6000);
            } catch (InterruptedException ignored) {
            }
            if (own != null) return;
            Minecraft.getInstance().execute(() -> {
                if (own != null) return;
                try (var in = Minecraft.getInstance().getResourceManager()
                        .open(ResourceLocation.withDefaultNamespace("textures/entity/player/wide/steve.png"))) {
                    READY.add(new Object[]{in.readAllBytes(), false, true, -1});
                } catch (Exception e) {
                    Opm.LOG.debug("Apparence par défaut indisponible", e);
                }
            });
        }, "OPM skin par défaut");
        t.setDaemon(true);
        t.start();
    }
}
