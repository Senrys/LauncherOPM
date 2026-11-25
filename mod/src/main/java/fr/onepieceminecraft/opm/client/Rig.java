package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.vertex.VertexConsumer;
import fr.onepieceminecraft.opm.Opm;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.renderer.texture.OverlayTexture;
import org.joml.Matrix4f;
import org.joml.Vector3f;

/**
 * Un modèle préparé du paquet (xenodys/tisseuse.py) : Xenodys la Tisseuse et ses
 * assistants. Des faces relatives à leur os ; des os animés, et d'autres calculés
 * (client/Tisseuse : ailes, robe, cheveux…). Une pose garde les angles donnés par
 * l'animation et les gestes ; les matrices se déduisent au dessin. Le même que
 * {@code Rig} du launcher (components/labGl.js).
 */
public final class Rig {
    private static final float DEG = (float) (Math.PI / 180);
    private static final float[] ZERO = new float[3];
    private static final int STRIDE = 24;

    public enum Layer { BASE, GLASS, GLOW, ENERGY }

    private static final String[] LAYER_NAMES = {"base", "verre", "lueur", "energie"};

    private record Bone(String name, int parent, float[] pos, float[] rest) {}

    private final String id;
    private final Bone[] bones;
    private final int[] order;
    private final Map<String, Integer> index = new HashMap<>();
    private final float[] faces;
    private final int[] first = new int[4];
    private final int[] count = new int[4];
    private final float[] mats;
    private final Map<String, GeoModel.Animation> animations;

    private Rig(String id, JsonObject meta, float[] faces, Map<String, GeoModel.Animation> animations) {
        this.id = id;
        this.faces = faces;
        this.animations = animations;
        JsonObject layers = meta.getAsJsonObject("couches");
        int at = 0;
        for (int i = 0; i < 4; i++) {
            first[i] = at;
            count[i] = layers.get(LAYER_NAMES[i]).getAsInt();
            at += count[i];
        }
        List<JsonObject> defs = new ArrayList<>();
        boolean hasRoot = false;
        for (JsonElement e : meta.getAsJsonArray("os")) {
            defs.add(e.getAsJsonObject());
            hasRoot |= "assistant".equals(e.getAsJsonObject().get("nom").getAsString());
        }
        for (int i = 0; i < defs.size(); i++) index.put(defs.get(i).get("nom").getAsString(), i);
        // Les animations des assistants portent sur une racine que leur modèle n'a pas.
        int extra = id.startsWith("assistant") && !hasRoot ? defs.size() : -1;
        bones = new Bone[defs.size() + (extra >= 0 ? 1 : 0)];
        for (int i = 0; i < defs.size(); i++) {
            JsonObject d = defs.get(i);
            boolean child = d.has("parent") && !d.get("parent").isJsonNull();
            int parent = child ? index.get(d.get("parent").getAsString()) : extra;
            float[] p = pivot(d);
            float[] base = child ? pivot(defs.get(parent)) : ZERO;
            float[] r = GeoModel.vec(d.getAsJsonArray("repos"));
            bones[i] = new Bone(d.get("nom").getAsString(), parent, new float[]{p[0] - base[0], p[1] - base[1], p[2] - base[2]},
                    new float[]{r[0] * DEG, r[1] * DEG, r[2] * DEG});
        }
        if (extra >= 0) {
            bones[extra] = new Bone("assistant", -1, ZERO, ZERO);
            index.put("assistant", extra);
        }
        // Les parents d'abord.
        order = new int[bones.length];
        boolean[] done = new boolean[bones.length];
        for (int n = 0; n < order.length; ) {
            for (int i = 0; i < bones.length; i++) {
                if (done[i] || (bones[i].parent() >= 0 && !done[bones[i].parent()])) continue;
                done[i] = true;
                order[n++] = i;
            }
        }
        mats = new float[bones.length * 12];
    }

    private static float[] pivot(JsonObject d) {
        float[] p = GeoModel.vec(d.getAsJsonArray("pivot"));
        return new float[]{-p[0], p[1], p[2]};
    }

    /** Charge {@code modeles/<id>} et les animations d'un fichier du paquet ({@code null} si illisible). */
    public static Rig load(String id, String file, String prefix) {
        try (InputStream in = Pack.open("modeles/" + id + ".bin")) {
            FloatBuffer b = ByteBuffer.wrap(in.readAllBytes()).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
            float[] faces = new float[b.remaining()];
            b.get(faces);
            return new Rig(id, Pack.json("modeles/" + id + ".json"), faces,
                    GeoModel.animations(Pack.json("geckolib/animations/" + file + ".animation.json"), prefix));
        } catch (Exception e) {
            Opm.LOG.error("Modèle « {} » illisible", id, e);
            return null;
        }
    }

    /** Les trois assistants : {@code graine}, {@code luciole}, {@code fileuse}. */
    public static Rig assistant(String species) {
        return load("assistant_" + species, "xenodys_assistant", "animation.xenodys_assistant");
    }

    public String id() {
        return id;
    }

    /* ------------------------------------------------------------- les poses */

    /** Les angles (radians, convention Bedrock) et les positions donnés aux os d'origine. */
    public static final class Pose {
        final Map<String, float[]> inp = new HashMap<>();
        final Map<String, float[]> off = new HashMap<>();
        double t;
    }

    /** Ce que les formules doivent savoir d'autre. */
    public static final class Options {
        /** 1 : ses mains tiennent le monde qu'elle crée ; 0 : elles servent. */
        public float hands = 1;
        public boolean blink;
        /** 0 → 1 : l'assistant marche. */
        public float walk;

        public Options hands(float v) {
            hands = v;
            return this;
        }

        public Options blink(boolean v) {
            blink = v;
            return this;
        }

        public Options walk(float v) {
            walk = v;
            return this;
        }
    }

    public Pose pose(String anim, double t) {
        Pose p = new Pose();
        p.t = t;
        GeoModel.Animation a = animations.get(anim);
        if (a != null) {
            float tt = (float) (a.length() > 0 ? (a.loop() ? t % a.length() : Math.min(t, a.length())) : 0);
            for (var e : a.bones().entrySet()) {
                GeoModel.Track[] ch = e.getValue();
                add(p, e.getKey(), ch[0] != null ? GeoModel.sample(ch[0], tt) : null, ch[1] != null ? GeoModel.sample(ch[1], tt) : null);
            }
        }
        return p;
    }

    /** Ajoute des décalages en degrés (convention Bedrock) et en pixels de modèle. */
    public static void add(Pose p, String bone, float[] r, float[] q) {
        if (r != null) {
            float[] a = p.inp.computeIfAbsent(bone, k -> new float[3]);
            for (int i = 0; i < 3; i++) a[i] += r[i] * DEG;
        }
        if (q != null) {
            float[] a = p.off.computeIfAbsent(bone, k -> new float[3]);
            for (int i = 0; i < 3; i++) a[i] += q[i];
        }
    }

    /** Mélange deux poses : `a` vers `b`, `k` de 0 à 1. */
    public static Pose blend(Pose a, Pose b, float k) {
        Pose out = new Pose();
        out.t = a.t;
        mix(a.inp, b.inp, out.inp, k);
        mix(a.off, b.off, out.off, k);
        return out;
    }

    private static void mix(Map<String, float[]> a, Map<String, float[]> b, Map<String, float[]> out, float k) {
        Set<String> names = new HashSet<>(a.keySet());
        names.addAll(b.keySet());
        for (String n : names) {
            float[] x = a.getOrDefault(n, ZERO);
            float[] y = b.getOrDefault(n, ZERO);
            out.put(n, new float[]{x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k});
        }
    }

    /* ----------------------------------------------------------- les matrices */

    /** Une matrice locale (`rot` en radians Bedrock), ajoutée à droite de `m` : 3 colonnes et la translation. */
    private static void local(float[] m, int mo, float[] o, int oo, float[] at, float rx, float ry, float rz,
                              float px, float py, float pz, float[] scale) {
        float cx = (float) Math.cos(-rx);
        float sx = (float) Math.sin(-rx);
        float cy = (float) Math.cos(-ry);
        float sy = (float) Math.sin(-ry);
        float cz = (float) Math.cos(rz);
        float sz = (float) Math.sin(rz);
        float a = scale != null ? scale[0] : 1;
        float b = scale != null ? scale[1] : 1;
        float c = scale != null ? scale[2] : 1;
        float r0 = cz * cy * a;
        float r1 = sz * cy * a;
        float r2 = -sy * a;
        float r3 = (cz * sy * sx - sz * cx) * b;
        float r4 = (sz * sy * sx + cz * cx) * b;
        float r5 = cy * sx * b;
        float r6 = (cz * sy * cx + sz * sx) * c;
        float r7 = (sz * sy * cx - cz * sx) * c;
        float r8 = cy * cx * c;
        float tx = at[0] - px;
        float ty = at[1] + py;
        float tz = at[2] + pz;
        for (int l = 0; l < 3; l++) {
            float m0 = m[mo + l];
            float m1 = m[mo + 3 + l];
            float m2 = m[mo + 6 + l];
            o[oo + l] = m0 * r0 + m1 * r1 + m2 * r2;
            o[oo + 3 + l] = m0 * r3 + m1 * r4 + m2 * r5;
            o[oo + 6 + l] = m0 * r6 + m1 * r7 + m2 * r8;
            o[oo + 9 + l] = m0 * tx + m1 * ty + m2 * tz + m[mo + 9 + l];
        }
    }

    /** Toutes les matrices des os, dans le repère de `root`. */
    public void solve(Pose pose, Matrix4f root, Options options) {
        Map<String, Tisseuse.Extra> extra = Tisseuse.drive(id, pose, options != null ? options : new Options());
        float[] top = {root.m00(), root.m01(), root.m02(), root.m10(), root.m11(), root.m12(), root.m20(), root.m21(), root.m22(),
                root.m30(), root.m31(), root.m32()};
        for (int i : order) {
            Bone b = bones[i];
            Tisseuse.Extra e = extra.get(b.name());
            float[] a = e != null && e.abs ? ZERO : pose.inp.getOrDefault(b.name(), ZERO);
            float[] d = e != null && e.r != null ? e.r : ZERO;
            float[] q = pose.off.getOrDefault(b.name(), ZERO);
            float[] f = e != null && e.p != null ? e.p : ZERO;
            float[] r = b.rest();
            boolean child = b.parent() >= 0;
            local(child ? mats : top, child ? b.parent() * 12 : 0, mats, i * 12, b.pos(), r[0] + a[0] + d[0], r[1] + a[1] + d[1],
                    r[2] + a[2] + d[2], q[0] + f[0], q[1] + f[1], q[2] + f[2], e != null ? e.s : null);
        }
    }

    /** Où se trouve un os, dans le repère du modèle (chaîne animée seulement). */
    public Vector3f point(Pose pose, String name) {
        return point(pose, name, null, null, null, null);
    }

    /** Le même, avec des décalages (degrés) sur deux os : pour résoudre un bras. */
    Vector3f point(Pose pose, String name, String boneA, float[] degA, String boneB, float[] degB) {
        Integer at = index.get(name);
        if (at == null) return new Vector3f();
        int[] chain = new int[16];
        int n = 0;
        for (int i = at; i >= 0; i = bones[i].parent()) chain[n++] = i;
        float[] m = {1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0};
        float[] o = new float[12];
        while (n-- > 0) {
            Bone b = bones[chain[n]];
            float[] a = pose.inp.getOrDefault(b.name(), ZERO);
            float[] q = pose.off.getOrDefault(b.name(), ZERO);
            float[] v = b.name().equals(boneA) ? degA : b.name().equals(boneB) ? degB : ZERO;
            float[] r = b.rest();
            local(m, 0, o, 0, b.pos(), r[0] + a[0] + v[0] * DEG, r[1] + a[1] + v[1] * DEG, r[2] + a[2] + v[2] * DEG, q[0], q[1], q[2], null);
            float[] swap = m;
            m = o;
            o = swap;
        }
        return new Vector3f(m[9], m[10], m[11]);
    }

    /* -------------------------------------------------------------- le dessin */

    private static final Vector3f LIGHT = new Vector3f(-0.35f, 0.85f, 0.55f).normalize();

    /**
     * Écrit une couche (après `solve`, matrices dans le repère de la caméra), pour un
     * shader sans éclairage ({@code position_tex_color}) : l'ombrage est cuit dans la
     * couleur de chaque face si `shaded`.
     */
    public void emitFlat(VertexConsumer vc, Layer layer, boolean shaded, int rgb, float alpha) {
        int a = Math.round(Math.max(0, Math.min(1, alpha)) * 255) << 24;
        int r = (rgb >> 16) & 255;
        int g = (rgb >> 8) & 255;
        int b = rgb & 255;
        int color = a | (rgb & 0xFFFFFF);
        int from = first[layer.ordinal()];
        for (int f = from, to = from + count[layer.ordinal()]; f < to; f++) {
            int o = f * STRIDE;
            int m = (int) faces[o] * 12;
            if (shaded) {
                float nx = mats[m] * faces[o + 1] + mats[m + 3] * faces[o + 2] + mats[m + 6] * faces[o + 3];
                float ny = mats[m + 1] * faces[o + 1] + mats[m + 4] * faces[o + 2] + mats[m + 7] * faces[o + 3];
                float nz = mats[m + 2] * faces[o + 1] + mats[m + 5] * faces[o + 2] + mats[m + 8] * faces[o + 3];
                float len = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
                float dot = len > 0 ? (nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z) / len : 0;
                float lum = 0.55f + 0.45f * Math.max(0, dot);
                color = a | ((int) (r * lum) << 16) | ((int) (g * lum) << 8) | (int) (b * lum);
            }
            for (int q = o + 4; q < o + STRIDE; q += 5) {
                float x = faces[q];
                float y = faces[q + 1];
                float z = faces[q + 2];
                vc.addVertex(mats[m] * x + mats[m + 3] * y + mats[m + 6] * z + mats[m + 9],
                        mats[m + 1] * x + mats[m + 4] * y + mats[m + 7] * z + mats[m + 10],
                        mats[m + 2] * x + mats[m + 5] * y + mats[m + 8] * z + mats[m + 11])
                        .setUv(faces[q + 3], faces[q + 4]).setColor(color);
            }
        }
    }

    /** Écrit une couche pour un shader d'entité. `flat` : sans ombrage par face (normale vers le haut). */
    public void emitEntity(VertexConsumer vc, Layer layer, boolean flat, int light, int color) {
        int from = first[layer.ordinal()];
        for (int f = from, to = from + count[layer.ordinal()]; f < to; f++) {
            int o = f * STRIDE;
            int m = (int) faces[o] * 12;
            float nx = 0;
            float ny = 1;
            float nz = 0;
            if (!flat) {
                nx = mats[m] * faces[o + 1] + mats[m + 3] * faces[o + 2] + mats[m + 6] * faces[o + 3];
                ny = mats[m + 1] * faces[o + 1] + mats[m + 4] * faces[o + 2] + mats[m + 7] * faces[o + 3];
                nz = mats[m + 2] * faces[o + 1] + mats[m + 5] * faces[o + 2] + mats[m + 8] * faces[o + 3];
                float len = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
                // Un os masqué (échelle 0) n'a pas de normale, ni rien à montrer.
                if (len < 1e-9f) continue;
                nx /= len;
                ny /= len;
                nz /= len;
            }
            for (int q = o + 4; q < o + STRIDE; q += 5) {
                float x = faces[q];
                float y = faces[q + 1];
                float z = faces[q + 2];
                vc.addVertex(mats[m] * x + mats[m + 3] * y + mats[m + 6] * z + mats[m + 9],
                        mats[m + 1] * x + mats[m + 4] * y + mats[m + 7] * z + mats[m + 10],
                        mats[m + 2] * x + mats[m + 5] * y + mats[m + 8] * z + mats[m + 11],
                        color, faces[q + 3], faces[q + 4], OverlayTexture.NO_OVERLAY, light, nx, ny, nz);
            }
        }
    }
}
