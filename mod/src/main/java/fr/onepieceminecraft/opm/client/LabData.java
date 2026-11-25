package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.vertex.BufferBuilder;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.resources.ResourceLocation;
import org.joml.Matrix4f;
import org.joml.Vector3f;

/**
 * Le laboratoire préparé par {@code xenodys/labo.py} : la salle (des blocs d'OPMTech,
 * lumière déjà calculée), les machines et leurs pièces mobiles, les textures. Lu dans
 * le paquet du mod (client/Pack) : disponible pendant le chargement, indépendant des packs.
 */
final class LabData {
    static final int BASE = 0;
    static final int GLOW = 1;
    static final int TRANS = 2;
    private static final String[] LAYERS = {"base", "lueur", "trans"};
    private static final String ROOT = "labo/";

    /** Un bloc ou une machine : son centre, ses quads (par couche : premier, nombre). */
    record Entry(Vector3f center, int[][] quads, String machine, String post) {}

    record Anim(String type, char axis, float amp, float period, float phase, float speed) {}

    /** Une pièce mobile d'une machine. */
    static final class Piece {
        String name;
        String state;
        Piece parent;
        Entry owner;
        int ownerIndex;
        Vector3f pivot;
        Matrix4f base;
        int[][] quads;
        List<Anim> anims = new ArrayList<>();
    }

    private record Strip(int cell, int frames, int duration, int row) {}

    final List<Entry> entries = new ArrayList<>();
    final List<Piece> pieces = new ArrayList<>();
    final Map<String, Vector3f> posts = new HashMap<>();
    final Map<String, Integer> tiles = new HashMap<>();
    private final Set<String> glowing = new HashSet<>();
    private final ByteBuffer data;
    private final int[] offset = new int[3];
    /** Les premiers blocs (la plateforme et sa cuve) : là dès le début. */
    final int foundation;
    final int atlasW;
    final int atlasH;
    private final int columns;
    private final List<Strip> strips = new ArrayList<>();
    private final Map<String, DynamicTexture> textures = new HashMap<>();
    private final Map<String, NativeImage> stripImages = new HashMap<>();
    private final Map<String, int[]> shownFrame = new HashMap<>();

    private static LabData instance;
    private static boolean tried;

    /** Les données, ou {@code null} si elles sont illisibles. */
    static LabData get() {
        if (!tried) {
            tried = true;
            try {
                instance = new LabData();
            } catch (Exception e) {
                Opm.LOG.error("Laboratoire illisible", e);
            }
        }
        return instance;
    }

    private static Vector3f vec(JsonElement e) {
        JsonArray a = e.getAsJsonArray();
        return new Vector3f(a.get(0).getAsFloat(), a.get(1).getAsFloat(), a.get(2).getAsFloat());
    }

    private static int[][] quads(JsonElement e) {
        JsonArray a = e.getAsJsonArray();
        int[][] q = new int[3][2];
        for (int i = 0; i < 3; i++) {
            q[i][0] = a.get(i).getAsJsonArray().get(0).getAsInt();
            q[i][1] = a.get(i).getAsJsonArray().get(1).getAsInt();
        }
        return q;
    }

    private static String str(JsonObject o, String k) {
        return o.has(k) && !o.get(k).isJsonNull() && !o.get(k).getAsString().isEmpty() ? o.get(k).getAsString() : null;
    }

    private static float num(JsonObject o, String k) {
        return o.has(k) ? o.get(k).getAsFloat() : 0;
    }

    private LabData() throws Exception {
        JsonObject meta = Pack.json(ROOT + "labo.json");
        try (InputStream in = Pack.open(ROOT + "labo.bin")) {
            data = ByteBuffer.wrap(in.readAllBytes()).order(ByteOrder.LITTLE_ENDIAN);
        }
        JsonObject layers = meta.getAsJsonObject("couches");
        for (int i = 0; i < 3; i++) offset[i] = layers.getAsJsonArray(LAYERS[i]).get(0).getAsInt();
        JsonObject atlas = meta.getAsJsonObject("atlas");
        atlasW = atlas.get("largeur").getAsInt();
        atlasH = atlas.get("hauteur").getAsInt();
        columns = atlas.get("colonnes").getAsInt();
        int row = 0;
        for (JsonElement e : atlas.getAsJsonArray("anims")) {
            JsonObject o = e.getAsJsonObject();
            strips.add(new Strip(o.get("case").getAsInt(), o.get("images").getAsInt(), o.get("duree").getAsInt(), row++));
        }
        for (JsonElement e : meta.getAsJsonArray("blocs")) {
            JsonObject o = e.getAsJsonObject();
            entries.add(new Entry(vec(o.get("c")), quads(o.get("q")), str(o, "machine"), str(o, "poste")));
        }
        foundation = meta.get("socle").getAsInt();
        Map<String, Piece> named = new HashMap<>();
        for (JsonElement e : meta.getAsJsonArray("pieces")) {
            JsonObject o = e.getAsJsonObject();
            Piece p = new Piece();
            int owner = o.get("machine").getAsInt();
            p.owner = entries.get(owner);
            p.ownerIndex = owner;
            p.name = o.get("nom").getAsString();
            p.state = str(o, "etat");
            p.parent = str(o, "parent") != null ? named.get(owner + ":" + str(o, "parent")) : null;
            p.pivot = vec(o.get("pivot"));
            p.quads = quads(o.get("q"));
            Vector3f pos = vec(o.get("pos"));
            float s = o.get("s").getAsFloat();
            p.base = new Matrix4f().translate(pos).rotateY((float) Math.toRadians(o.get("rot").getAsFloat())).scale(s)
                    .translate(-0.5f, 0, -0.5f);
            for (JsonElement ae : o.getAsJsonArray("anims")) {
                JsonObject a = ae.getAsJsonObject();
                String axis = str(a, "axe");
                p.anims.add(new Anim(a.get("type").getAsString(), axis != null ? axis.charAt(0) : 'y', num(a, "amp"),
                        num(a, "periode"), num(a, "phase"), num(a, "vitesse")));
            }
            named.put(owner + ":" + p.name, p);
            pieces.add(p);
        }
        for (var e : meta.getAsJsonObject("postes").entrySet()) posts.put(e.getKey(), vec(e.getValue()));
        for (var e : meta.getAsJsonObject("tuiles").entrySet()) tiles.put(e.getKey(), e.getValue().getAsInt());
        for (JsonElement e : meta.getAsJsonArray("lumineuses")) glowing.add(e.getAsString());
    }

    boolean glows(String tile) {
        return glowing.contains(tile);
    }

    /** Le coin d'une tuile dans l'atlas, en pixels. */
    int[] cell(String tile) {
        int i = tiles.getOrDefault(tile, 0);
        return new int[]{(i % columns) * 16, (i / columns) * 16};
    }

    private static final Vector3f TMP = new Vector3f();

    /** Les quads {@code first … first+count} d'une couche, transformés par {@code m} ({@code null} : tels quels). */
    void emit(BufferBuilder bb, int layer, int first, int count, boolean corrupted, Matrix4f m, float alpha, float light) {
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        int at = offset[layer] + first * 4 * 28;
        int col = corrupted ? 24 : 20;
        for (int i = 0; i < count * 4; i++, at += 28) {
            TMP.set(data.getFloat(at), data.getFloat(at + 4), data.getFloat(at + 8));
            if (m != null) m.transformPosition(TMP);
            int r = Math.min(255, (int) ((data.get(at + col) & 255) * light));
            int g = Math.min(255, (int) ((data.get(at + col + 1) & 255) * light));
            int b = Math.min(255, (int) ((data.get(at + col + 2) & 255) * light));
            bb.addVertex(TMP.x, TMP.y, TMP.z).setUv(data.getFloat(at + 12) / atlasW, data.getFloat(at + 16) / atlasH)
                    .setColor(r, g, b, a);
        }
    }

    /** L'atlas d'un état (ou sa couche lumineuse), à jour de ses animations. */
    ResourceLocation atlas(String etat, boolean glow, double t) {
        String name = etat + (glow ? "_lueur" : "");
        ResourceLocation id = ResourceLocation.fromNamespaceAndPath(Opm.ID, "dyn/labo/" + name);
        DynamicTexture tex = textures.get(name);
        if (tex == null) {
            try (InputStream in = Pack.open(ROOT + "atlas_" + name + ".png");
                 InputStream bands = Pack.open(ROOT + "bandes_" + name + ".png")) {
                tex = new DynamicTexture(NativeImage.read(in));
                stripImages.put(name, NativeImage.read(bands));
            } catch (Exception e) {
                Opm.LOG.error("Atlas « {} » illisible", name, e);
                tex = new DynamicTexture(16, 16, true);
            }
            Minecraft.getInstance().getTextureManager().register(id, tex);
            textures.put(name, tex);
            int[] shown = new int[strips.size()];
            java.util.Arrays.fill(shown, -1);
            shownFrame.put(name, shown);
        }
        animate(name, tex, t);
        return id;
    }

    private void animate(String name, DynamicTexture tex, double t) {
        NativeImage bands = stripImages.get(name);
        NativeImage px = tex.getPixels();
        if (bands == null || px == null) return;
        int[] shown = shownFrame.get(name);
        for (int i = 0; i < strips.size(); i++) {
            Strip s = strips.get(i);
            int frame = Math.floorMod((int) Math.floor(t * 20 / Math.max(1, s.duration())), s.frames());
            if (frame == shown[i]) continue;
            shown[i] = frame;
            int x0 = (s.cell() % columns) * 16;
            int y0 = (s.cell() / columns) * 16;
            for (int y = 0; y < 16; y++) {
                for (int x = 0; x < 16; x++) {
                    px.setPixelRGBA(x0 + x, y0 + y, bands.getPixelRGBA(frame * 16 + x, s.row() * 16 + y));
                }
            }
            tex.bind();
            px.upload(0, x0, y0, x0, y0, 16, 16, false, false);
        }
    }
}
