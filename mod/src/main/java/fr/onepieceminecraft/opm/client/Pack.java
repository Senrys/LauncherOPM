package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fr.onepieceminecraft.opm.Opm;
import fr.onepieceminecraft.opm.PackKey;
import java.io.ByteArrayInputStream;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.InflaterInputStream;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Les ressources d'OPM (textures, modèles, animations, laboratoire), lues dans le
 * paquet chiffré du jar ({@code opm.pak}, scripts/paquet.js) : elles ne figurent en
 * clair ni dans le dépôt, qui est public, ni dans le jar. Sans clé (mod compilé
 * ailleurs), le paquet reste fermé et les scènes 3D ne s'affichent pas.
 */
public final class Pack {
    private static byte[] raw;
    private static int base;
    private static final Map<String, int[]> INDEX = new HashMap<>();
    private static boolean tried;

    private Pack() {}

    private static synchronized void load() {
        if (tried) return;
        tried = true;
        byte[] key = PackKey.get();
        if (key == null) {
            Opm.LOG.warn("Paquet de ressources fermé : mod compilé sans clé.");
            return;
        }
        try (InputStream in = Pack.class.getResourceAsStream("/assets/opm/opm.pak")) {
            byte[] pak = in.readAllBytes();
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, pak, 4, 12));
            // Le sceau (octets 16 à 32) suit les données, pour Java.
            byte[] plain = new byte[c.getOutputSize(pak.length - 16)];
            int n = c.update(pak, 32, pak.length - 32, plain, 0);
            n += c.doFinal(pak, 16, 16, plain, n);
            try (InputStream z = new InflaterInputStream(new ByteArrayInputStream(plain, 0, n))) {
                raw = z.readAllBytes();
            }
            int head = ByteBuffer.wrap(raw).getInt();
            base = 4 + head;
            JsonObject index = JsonParser.parseString(new String(raw, 4, head, StandardCharsets.UTF_8)).getAsJsonObject();
            for (var e : index.entrySet()) {
                JsonArray a = e.getValue().getAsJsonArray();
                INDEX.put(e.getKey(), new int[]{a.get(0).getAsInt(), a.get(1).getAsInt()});
            }
        } catch (Exception e) {
            raw = null;
            INDEX.clear();
            Opm.LOG.error("Paquet de ressources illisible", e);
        }
    }

    public static boolean has(String name) {
        load();
        return INDEX.containsKey(name);
    }

    /** Une ressource du paquet. */
    public static InputStream open(String name) throws FileNotFoundException {
        load();
        int[] at = INDEX.get(name);
        if (at == null) throw new FileNotFoundException(name);
        return new ByteArrayInputStream(raw, base + at[0], at[1]);
    }

    public static JsonObject json(String name) throws Exception {
        try (InputStream in = open(name)) {
            return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
        }
    }
}
