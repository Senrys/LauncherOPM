package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import fr.onepieceminecraft.opm.Opm;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.renderer.texture.OverlayTexture;
import org.joml.Quaternionf;

/**
 * Un modèle GeckoLib (géométrie Bedrock + animations), dessiné sans GeckoLib :
 * le portage exact de `buildModel` / `pose` du launcher (components/
 * xenodys3d.js) — même repère (Three.js, l'axe x de Bedrock inversé), mêmes
 * rotations « ZYX », mêmes UV « box », même interpolation (linéaire et
 * Catmull-Rom). L'écran titre l'utilise pour Xenodys en vraie 3D.
 */
public final class GeoModel {
    private static final float DEG = (float) (Math.PI / 180);

    private record Cube(float[] from, float[] size, float[] uv, float[] pivot, float[] rotation, float inflate) {}

    private static final class Bone {
        String name;
        Bone parent;
        float[] pivot;
        float[] position;
        float[] rotation;
        final List<Cube> cubes = new ArrayList<>();
        final List<Bone> children = new ArrayList<>();
    }

    private record Track(float[] times, float[][] values, boolean[] smooth) {}

    public record Animation(float length, boolean loop, Map<String, Track[]> bones) {}

    private final List<Bone> bones = new ArrayList<>();
    private final Map<String, Bone> byName = new HashMap<>();
    private final Bone root;
    private final float tw;
    private final float th;
    private final Map<String, Animation> animations = new HashMap<>();

    private GeoModel(JsonObject geo, JsonObject anims, String prefix) {
        JsonObject g = geo.getAsJsonArray("minecraft:geometry").get(0).getAsJsonObject();
        tw = g.getAsJsonObject("description").get("texture_width").getAsFloat();
        th = g.getAsJsonObject("description").get("texture_height").getAsFloat();
        for (JsonElement e : g.getAsJsonArray("bones")) {
            JsonObject d = e.getAsJsonObject();
            Bone b = new Bone();
            b.name = d.get("name").getAsString();
            float[] p = vec(d.getAsJsonArray("pivot"));
            b.pivot = new float[]{-p[0], p[1], p[2]};
            b.parent = d.has("parent") ? byName.get(d.get("parent").getAsString()) : null;
            float[] base = b.parent != null ? b.parent.pivot : new float[3];
            b.position = new float[]{b.pivot[0] - base[0], b.pivot[1] - base[1], b.pivot[2] - base[2]};
            float[] r = d.has("rotation") ? vec(d.getAsJsonArray("rotation")) : new float[3];
            b.rotation = new float[]{-r[0] * DEG, -r[1] * DEG, r[2] * DEG};
            if (d.has("cubes")) {
                for (JsonElement ce : d.getAsJsonArray("cubes")) {
                    JsonObject c = ce.getAsJsonObject();
                    float[] o = vec(c.getAsJsonArray("origin"));
                    float[] s = vec(c.getAsJsonArray("size"));
                    float[] cp = c.has("pivot") ? vec(c.getAsJsonArray("pivot")) : null;
                    float[] cr = c.has("rotation") ? vec(c.getAsJsonArray("rotation")) : null;
                    b.cubes.add(new Cube(new float[]{-(o[0] + s[0]), o[1], o[2]}, s, vec(c.getAsJsonArray("uv")),
                            cp != null ? new float[]{-cp[0], cp[1], cp[2]} : null,
                            cr != null ? new float[]{-cr[0] * DEG, -cr[1] * DEG, cr[2] * DEG} : null,
                            c.has("inflate") ? c.get("inflate").getAsFloat() : 0f));
                }
            }
            if (b.parent != null) b.parent.children.add(b);
            bones.add(b);
            byName.put(b.name, b);
        }
        root = bones.get(0);
        if (anims != null) {
            for (var entry : anims.getAsJsonObject("animations").entrySet()) {
                animations.put(entry.getKey().replace(prefix + ".", ""), compile(entry.getValue().getAsJsonObject()));
            }
        }
    }

    /** Charge un modèle du paquet : `geckolib/{geo,animations}/<nom>…` (animations facultatives). */
    public static GeoModel load(String name, String prefix) {
        try {
            JsonObject anims = read("geckolib/animations/" + name + ".animation.json");
            return new GeoModel(read("geckolib/geo/" + name + ".geo.json"), anims,
                    prefix != null ? prefix : "animation." + name);
        } catch (Exception e) {
            Opm.LOG.error("Modèle « {} » illisible", name, e);
            return null;
        }
    }

    private static JsonObject read(String path) throws Exception {
        return Pack.has(path) ? Pack.json(path) : null;
    }

    private static float[] vec(JsonArray a) {
        float[] v = new float[a.size()];
        for (int i = 0; i < v.length; i++) v[i] = a.get(i).getAsFloat();
        return v;
    }

    private static Track track(JsonElement channel) {
        if (channel.isJsonArray()) {
            return new Track(new float[]{0}, new float[][]{vec(channel.getAsJsonArray())}, new boolean[]{false});
        }
        var entries = new ArrayList<>(channel.getAsJsonObject().entrySet());
        entries.sort((a, b) -> Float.compare(Float.parseFloat(a.getKey()), Float.parseFloat(b.getKey())));
        float[] times = new float[entries.size()];
        float[][] values = new float[entries.size()][];
        boolean[] smooth = new boolean[entries.size()];
        for (int i = 0; i < entries.size(); i++) {
            times[i] = Float.parseFloat(entries.get(i).getKey());
            JsonElement raw = entries.get(i).getValue();
            if (raw.isJsonArray()) {
                values[i] = vec(raw.getAsJsonArray());
            } else {
                JsonObject o = raw.getAsJsonObject();
                values[i] = vec((o.has("post") ? o.get("post") : o.get("pre")).getAsJsonArray());
                smooth[i] = o.has("lerp_mode") && "catmullrom".equals(o.get("lerp_mode").getAsString());
            }
        }
        return new Track(times, values, smooth);
    }

    private static Animation compile(JsonObject d) {
        Map<String, Track[]> map = new HashMap<>();
        if (d.has("bones")) {
            for (var e : d.getAsJsonObject("bones").entrySet()) {
                JsonObject ch = e.getValue().getAsJsonObject();
                map.put(e.getKey(), new Track[]{ch.has("rotation") ? track(ch.get("rotation")) : null,
                        ch.has("position") ? track(ch.get("position")) : null});
            }
        }
        float length = d.has("animation_length") ? d.get("animation_length").getAsFloat() : 1;
        boolean loop = d.has("loop") && d.get("loop").isJsonPrimitive() && d.get("loop").getAsJsonPrimitive().isBoolean()
                && d.get("loop").getAsBoolean();
        return new Animation(length, loop, map);
    }

    private static float[] sample(Track tr, float t) {
        float[] times = tr.times();
        float[][] v = tr.values();
        int last = times.length - 1;
        if (t <= times[0]) return v[0];
        if (t >= times[last]) return v[last];
        int i = 0;
        while (t > times[i + 1]) i++;
        float k = (t - times[i]) / (times[i + 1] - times[i]);
        float[] a = v[i];
        float[] b = v[i + 1];
        float[] out = new float[a.length];
        if (!tr.smooth()[i] && !tr.smooth()[i + 1]) {
            for (int n = 0; n < a.length; n++) out[n] = a[n] + (b[n] - a[n]) * k;
            return out;
        }
        float[] p0 = v[Math.max(0, i - 1)];
        float[] p3 = v[Math.min(last, i + 2)];
        float k2 = k * k;
        float k3 = k2 * k;
        for (int n = 0; n < a.length; n++) {
            out[n] = 0.5f * (2 * a[n] + (-p0[n] + b[n]) * k + (2 * p0[n] - 5 * a[n] + 4 * b[n] - p3[n]) * k2
                    + (-p0[n] + 3 * a[n] - 3 * b[n] + p3[n]) * k3);
        }
        return out;
    }

    public Animation animation(String name) {
        return animations.get(name);
    }

    /** Une pose : rotation (radians, repère Three.js) et position de chaque os. */
    public static final class Pose {
        final Map<String, float[]> rot = new HashMap<>();
        final Map<String, float[]> pos = new HashMap<>();
        float weight = 1;

        public Pose copy() {
            Pose p = new Pose();
            rot.forEach((k, v) -> p.rot.put(k, v.clone()));
            pos.forEach((k, v) -> p.pos.put(k, v.clone()));
            return p;
        }
    }

    /** Repos + animation au temps `t` (secondes ; bouclée si l'animation boucle). */
    public Pose pose(String anim, float t) {
        Pose p = new Pose();
        for (Bone b : bones) {
            p.rot.put(b.name, b.rotation.clone());
            p.pos.put(b.name, b.position.clone());
        }
        Animation a = anim != null ? animations.get(anim) : null;
        if (a != null) {
            float tt = a.length() > 0 ? (a.loop() ? t % a.length() : Math.min(t, a.length())) : 0;
            for (var e : a.bones().entrySet()) {
                Track[] ch = e.getValue();
                add(p, e.getKey(), ch[0] != null ? sample(ch[0], tt) : null, ch[1] != null ? sample(ch[1], tt) : null);
            }
        }
        return p;
    }

    /** Ajoute des décalages en degrés (convention Bedrock) et en unités. */
    public static void add(Pose p, String bone, float[] r, float[] q) {
        float[] rot = p.rot.get(bone);
        if (rot == null) return;
        if (r != null) {
            rot[0] += -r[0] * DEG;
            rot[1] += -r[1] * DEG;
            rot[2] += r[2] * DEG;
        }
        if (q != null) {
            float[] pos = p.pos.get(bone);
            pos[0] += -q[0];
            pos[1] += q[1];
            pos[2] += q[2];
        }
    }

    /** Mélange deux poses : `a` vers `b`, `k` de 0 à 1. */
    public static Pose blend(Pose a, Pose b, float k) {
        Pose out = new Pose();
        for (var e : a.rot.entrySet()) {
            float[] x = e.getValue();
            float[] y = b.rot.getOrDefault(e.getKey(), x);
            out.rot.put(e.getKey(), new float[]{x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k});
        }
        for (var e : a.pos.entrySet()) {
            float[] x = e.getValue();
            float[] y = b.pos.getOrDefault(e.getKey(), x);
            out.pos.put(e.getKey(), new float[]{x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k});
        }
        return out;
    }

    /**
     * Où se trouve un os (son pivot), dans le repère du modèle, pour une pose :
     * le même enchaînement de transformations que `render`.
     */
    public org.joml.Vector3f point(Pose pose, String bone) {
        Bone b = byName.get(bone);
        if (b == null) return new org.joml.Vector3f();
        List<Bone> chain = new ArrayList<>();
        for (Bone c = b; c != null; c = c.parent) chain.add(0, c);
        org.joml.Matrix4f m = new org.joml.Matrix4f();
        for (Bone c : chain) {
            float[] p = pose.pos.get(c.name);
            float[] r = pose.rot.get(c.name);
            m.translate(p[0], p[1], p[2]).rotate(new Quaternionf().rotationZYX(r[2], r[1], r[0]));
        }
        return m.transformPosition(new org.joml.Vector3f());
    }

    /** Tous les os sous ceux-ci (eux compris). */
    public Set<String> descendants(String... names) {
        Set<String> out = new java.util.HashSet<>(List.of(names));
        boolean changed = true;
        while (changed) {
            changed = false;
            for (Bone b : bones) {
                if (!out.contains(b.name) && b.parent != null && out.contains(b.parent.name)) {
                    out.add(b.name);
                    changed = true;
                }
            }
        }
        return out;
    }

    /**
     * Dessine le modèle dans le repère courant (y vers le haut, une unité par
     * unité du modèle). `only` : os dessinés (`null` : tous).
     */
    public void render(PoseStack ps, VertexConsumer vc, Pose pose, Set<String> only, int light, int color) {
        shade = false;
        renderBone(ps, vc, root, pose, only, light, color);
    }

    /**
     * Comme `render`, mais l'ombrage est cuit dans la couleur de chaque face
     * (lumière fixe par rapport à la caméra) : pour un shader sans éclairage
     * (`position_tex_color`), le seul disponible pendant le chargement du jeu.
     */
    public void renderShaded(PoseStack ps, VertexConsumer vc, Pose pose, Set<String> only, int color) {
        shade = true;
        renderBone(ps, vc, root, pose, only, 0, color);
        shade = false;
    }

    private boolean shade;
    private static final org.joml.Vector3f LIGHT = new org.joml.Vector3f(-0.35f, 0.85f, 0.55f).normalize();

    private void renderBone(PoseStack ps, VertexConsumer vc, Bone b, Pose pose, Set<String> only, int light, int color) {
        ps.pushPose();
        float[] p = pose.pos.get(b.name);
        float[] r = pose.rot.get(b.name);
        ps.translate(p[0], p[1], p[2]);
        ps.mulPose(new Quaternionf().rotationZYX(r[2], r[1], r[0]));
        if (only == null || only.contains(b.name)) {
            for (Cube c : b.cubes) {
                ps.pushPose();
                float[] center = {c.from()[0] + c.size()[0] / 2, c.from()[1] + c.size()[1] / 2, c.from()[2] + c.size()[2] / 2};
                if (c.rotation() != null) {
                    ps.translate(c.pivot()[0] - b.pivot[0], c.pivot()[1] - b.pivot[1], c.pivot()[2] - b.pivot[2]);
                    ps.mulPose(new Quaternionf().rotationZYX(c.rotation()[2], c.rotation()[1], c.rotation()[0]));
                    ps.translate(center[0] - c.pivot()[0], center[1] - c.pivot()[1], center[2] - c.pivot()[2]);
                } else {
                    ps.translate(center[0] - b.pivot[0], center[1] - b.pivot[1], center[2] - b.pivot[2]);
                }
                cube(ps.last(), vc, c, light, color);
                ps.popPose();
            }
        }
        for (Bone child : b.children) renderBone(ps, vc, child, pose, only, light, color);
        ps.popPose();
    }

    // Plans de BoxGeometry : face, axes u/v/w, sens u/v, dimension u, v, w (signée).
    private static final String[] FACES = {"east", "west", "up", "down", "south", "north"};
    private static final int[][] AXES = {{2, 1, 0}, {2, 1, 0}, {0, 2, 1}, {0, 2, 1}, {0, 1, 2}, {0, 1, 2}};
    private static final int[][] DIRS = {{-1, -1}, {1, -1}, {1, 1}, {1, -1}, {1, -1}, {-1, -1}};
    // Dimensions : 0 = w (x), 1 = h (y), 2 = d (z) ; le signe de la profondeur.
    private static final int[][] DIMS = {{2, 1, 0}, {2, 1, 0}, {0, 2, 1}, {0, 2, 1}, {0, 1, 2}, {0, 1, 2}};
    private static final int[] DEPTH_SIGN = {1, -1, 1, -1, 1, -1};

    private void cube(PoseStack.Pose last, VertexConsumer vc, Cube c, int light, int color) {
        float inflate = c.inflate();
        float w = c.size()[0];
        float h = c.size()[1];
        float d = c.size()[2];
        float u = c.uv()[0];
        float v = c.uv()[1];
        float[][] rects = {
                {u, v + d, d, h},             // east
                {u + d + w, v + d, d, h},     // west
                {u + d, v, w, d},             // up
                {u + d + w, v, w, d},         // down
                {u + 2 * d + w, v + d, w, h}, // south
                {u + d, v + d, w, h},         // north
        };
        for (int f = 0; f < 6; f++) {
            int ua = AXES[f][0];
            int va = AXES[f][1];
            int wa = AXES[f][2];
            float W = c.size()[DIMS[f][0]] + 2 * inflate;
            float H = c.size()[DIMS[f][1]] + 2 * inflate;
            float D = (c.size()[DIMS[f][2]] + 2 * inflate) * DEPTH_SIGN[f];
            float[] rect = rects[f];
            boolean flipV = f == 2 || f == 3;
            float[] n = new float[3];
            n[wa] = DEPTH_SIGN[f];
            int faceColor = color;
            if (shade) {
                org.joml.Vector3f nv = last.normal().transform(new org.joml.Vector3f(n[0], n[1], n[2])).normalize();
                float lum = 0.55f + 0.45f * Math.max(0, nv.dot(LIGHT));
                int r = Math.min(255, Math.round(((color >> 16) & 255) * lum));
                int gg = Math.min(255, Math.round(((color >> 8) & 255) * lum));
                int bb = Math.min(255, Math.round((color & 255) * lum));
                faceColor = (color & 0xFF000000) | (r << 16) | (gg << 8) | bb;
            }
            // Ordre de BoxGeometry : (0,0) (1,0) (0,1) (1,1) — on dessine le quad (0,0) (0,1) (1,1) (1,0).
            int[][] order = {{0, 0}, {0, 1}, {1, 1}, {1, 0}};
            for (int[] o : order) {
                int ix = o[0];
                int iy = o[1];
                float[] pt = new float[3];
                pt[ua] = (ix * W - W / 2) * DIRS[f][0];
                pt[va] = (iy * H - H / 2) * DIRS[f][1];
                pt[wa] = D / 2;
                float tu = (rect[0] + ix * rect[2]) / tw;
                float tv = (flipV ? rect[1] + (1 - iy) * rect[3] : rect[1] + iy * rect[3]) / th;
                vc.addVertex(last, pt[0], pt[1], pt[2]).setColor(faceColor).setUv(tu, tv)
                        .setOverlay(OverlayTexture.NO_OVERLAY).setLight(light).setNormal(last, n[0], n[1], n[2]);
            }
        }
    }
}
