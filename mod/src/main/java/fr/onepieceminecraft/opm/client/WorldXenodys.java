package fr.onepieceminecraft.opm.client;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.math.Axis;
import fr.onepieceminecraft.opm.Opm;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.Util;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.RenderGuiEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.client.event.RenderNameTagEvent;
import net.neoforged.neoforge.common.util.TriState;

/**
 * Xenodys dans le monde, sans rien installer sur le serveur.
 *
 * <p><b>Les apparitions du staff</b> : le serveur place une entité invisible
 * dont le nom commence par {@code opm:xenodys} (un support d'armure marqueur,
 * voir minecraft/xenodys.sk, {@code /xenodys apparaitre}) ; le mod dessine
 * Xenodys à sa place — immense (1,95 × le modèle), tournée comme l'entité, la
 * tête vers le joueur. Le nom choisit l'animation : {@code opm:xenodys:greet},
 * {@code opm:xenodys:fly}… ; corrompue, {@code idle} devient
 * {@code corrupted_idle}.
 *
 * <p><b>La première arrivée</b> : la toute première fois qu'un compte entre sur le
 * serveur (retenu par le serveur d'authentification, quel que soit le PC), Xenodys
 * le dépose dans le monde — un éclair blanc,
 * elle face à lui, la main tendue, puis elle s'envole.
 */
public final class WorldXenodys {
    private static final float SCALE = 1.95f / 16f;
    private static final Set<String> ANIMS = Set.of("idle", "greet", "fly", "cradle", "unveil", "lean",
            "corrupted_idle", "corrupted_lean");
    private static final Map<Integer, Object[]> STARTS = new HashMap<>();
    private static final double ARRIVAL = 7.0;

    private static long arrivalStart = -1;
    private static Vec3 arrivalPos;
    private static float arrivalYaw;

    private WorldXenodys() {}

    public static boolean isMarker(Entity e) {
        return e.hasCustomName() && e.getCustomName().getString().startsWith("opm:xenodys");
    }

    private static String animOf(Entity e) {
        String name = e.getCustomName().getString();
        String anim = name.length() > "opm:xenodys:".length() ? name.substring("opm:xenodys:".length()) : "idle";
        if (!ANIMS.contains(anim)) anim = "idle";
        if (OpmSession.get().corrupted() && anim.equals("idle")) anim = "corrupted_idle";
        if (OpmSession.get().corrupted() && anim.equals("lean")) anim = "corrupted_lean";
        return anim;
    }

    /** Le nom de l'entité marqueur ne s'affiche jamais. */
    public static void onNameTag(RenderNameTagEvent event) {
        if (isMarker(event.getEntity())) event.setCanRender(TriState.FALSE);
    }

    public static void onRender(RenderLevelStageEvent event) {
        if (event.getStage() != RenderLevelStageEvent.Stage.AFTER_ENTITIES) return;
        Minecraft mc = Minecraft.getInstance();
        if (mc.level == null || Xen.model() == null) return;
        float pt = event.getPartialTick().getGameTimeDeltaPartialTick(false);
        Vec3 cam = event.getCamera().getPosition();
        PoseStack ps = event.getPoseStack();
        double now = Util.getMillis() / 1000.0;

        for (Entity e : mc.level.entitiesForRendering()) {
            if (!isMarker(e) || e.distanceToSqr(cam) > 160 * 160) continue;
            String anim = animOf(e);
            Object[] st = STARTS.get(e.getId());
            if (st == null || !anim.equals(st[0])) {
                st = new Object[]{anim, now};
                STARTS.put(e.getId(), st);
            }
            Vec3 pos = e.getPosition(pt);
            float yaw = e.getViewYRot(pt);
            draw(ps, mc, pos, yaw, anim, now - (Double) st[1], cam, 1f, e.getId());
        }

        if (arrivalStart >= 0 && arrivalPos != null) {
            double t = (Util.getMillis() - arrivalStart) / 1000.0;
            if (t > ARRIVAL) {
                arrivalStart = -1;
                arrivalSeen();
            } else if (t > 0) {
                boolean flying = t > 4.0;
                double up = flying ? Math.pow(t - 4.0, 2) * 3.5 : 0;
                float alpha = (float) Math.min(Math.min(1, t / 0.6), 1 - Math.max(0, (t - 5.5) / 1.0));
                draw(ps, mc, arrivalPos.add(0, up, 0), arrivalYaw, flying ? "fly" : "greet", flying ? t - 4.0 : t, cam,
                        alpha, -1);
            }
        }
    }

    private static void draw(PoseStack ps, Minecraft mc, Vec3 pos, float yaw, String anim, double t, Vec3 cam,
                             float alpha, int seed) {
        GeoModel.Pose p = Xen.model().pose(anim, (float) t);
        // La tête vers la caméra (repère du modèle : y vers le haut, visage vers −z).
        double headY = pos.y + 89 * SCALE;
        double dx = cam.x - pos.x;
        double dz = cam.z - pos.z;
        double r = Math.toRadians(yaw);
        double fx = -Math.sin(r);
        double fz = Math.cos(r);
        double rx = -fz;
        double rz = fx;
        double along = dx * fx + dz * fz;
        double side = dx * rx + dz * rz;
        float headYaw = (float) Math.max(-60, Math.min(60, Math.toDegrees(Math.atan2(side, Math.max(0.01, along)))));
        float headPitch = (float) Math.max(-35, Math.min(45, Math.toDegrees(Math.atan2(headY - cam.y, Math.hypot(dx, dz)))));
        if (!anim.startsWith("fly")) {
            // Si le joueur est tout près, elle se penche vers lui.
            double near = Math.max(0, Math.min(1, (14 - Math.hypot(dx, dz)) / 8));
            GeoModel.add(p, "chest", new float[]{(float) (near * 22), 0, 0}, null);
            GeoModel.add(p, "head", new float[]{headPitch * 0.75f, headYaw * 0.75f, 0}, null);
            GeoModel.add(p, "neck", new float[]{headPitch * 0.25f, headYaw * 0.25f, 0}, null);
        }
        int light = LevelRenderer.getLightColor(mc.level, BlockPos.containing(pos.x, pos.y + 6, pos.z));
        ps.pushPose();
        ps.translate(pos.x - cam.x, pos.y - cam.y, pos.z - cam.z);
        ps.mulPose(Axis.YP.rotationDegrees(180 - yaw));
        ps.scale(SCALE, SCALE, SCALE);
        String etat = OpmSession.get().etat;
        Xen.render(ps, mc.renderBuffers().bufferSource(), p, etat, Xen.blinking(t, seed & 7), light, alpha, null);
        ps.popPose();
    }

    /* ---------------------------------------------------------- l'arrivée */

    /**
     * Le registre local : la scène a été vue sur ce PC. Il évite de la rejouer si le
     * serveur d'authentification n'a pas pu le noter, et reprend celui des versions
     * précédentes du mod.
     */
    private static Path arrivals() {
        return FMLPaths.GAMEDIR.get().resolve("opm").resolve("arrivees.txt");
    }

    private static boolean seenHere(String id) {
        try {
            return Files.exists(arrivals()) && Files.readString(arrivals(), StandardCharsets.UTF_8).contains(id);
        } catch (Exception e) {
            Opm.LOG.debug("Registre des arrivées illisible", e);
            return true;
        }
    }

    /** La scène est finie : notée pour ce compte, une fois pour toutes. */
    private static void arrivalSeen() {
        var player = Minecraft.getInstance().player;
        if (player == null || Minecraft.getInstance().isLocalServer()) return;
        String id = player.getUUID().toString();
        if (!seenHere(id)) {
            try {
                Files.createDirectories(arrivals().getParent());
                Files.writeString(arrivals(), id + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                        StandardOpenOption.APPEND);
            } catch (Exception e) {
                Opm.LOG.debug("Registre des arrivées non écrit", e);
            }
        }
        GameApi.post("arrivee", new JsonObject(), o -> {});
    }

    public static void onLogin(ClientPlayerNetworkEvent.LoggingIn event) {
        arrivalStart = -1;
        Minecraft mc = Minecraft.getInstance();
        if (mc.isLocalServer()) {
            // En solo, seulement pour les captures de développement.
            if (!System.getProperty("opm.debug.world", "").isEmpty()) playArrival();
            return;
        }
        // Vue sur ce PC, ou animations coupées : c'est noté, elle ne viendra pas plus tard.
        if (seenHere(event.getPlayer().getUUID().toString()) || !OpmSession.get().animations) {
            GameApi.post("arrivee", new JsonObject(), o -> {});
            return;
        }
        var connection = event.getConnection();
        // Sans réponse du serveur d'authentification, pas de scène : on ne la rejoue pas par erreur.
        GameApi.get("arrivee", o -> mc.execute(() -> {
            boolean here = mc.getConnection() != null && mc.getConnection().getConnection() == connection;
            if (here && o.has("vue") && !o.get("vue").getAsBoolean()) playArrival();
        }));
    }

    public static void onLogout() {
        arrivalStart = -1;
        arrivalPos = null;
    }

    /** Joue la scène : première arrivée, ou à la demande du staff ({@code [OPM:ARRIVEE]}). */
    public static void playArrival() {
        // Le monde se charge encore : la scène commence un peu plus tard.
        arrivalStart = Util.getMillis() + 1500;
        arrivalPos = null;
    }

    /** Fixe la place de Xenodys au début de la scène : devant le joueur, face à lui. */
    public static void onClientTick() {
        if (arrivalStart < 0 || arrivalPos != null || Util.getMillis() < arrivalStart) return;
        var player = Minecraft.getInstance().player;
        if (player == null) return;
        float yaw = player.getYRot();
        double r = Math.toRadians(yaw);
        // Tout près : il faut lever les yeux pour voir son visage.
        arrivalPos = player.position().add(-Math.sin(r) * 8, -3.5, Math.cos(r) * 8);
        arrivalYaw = yaw + 180;
    }

    /** L'éclair blanc du dépôt. */
    public static void onGui(RenderGuiEvent.Post event) {
        if (arrivalStart < 0) return;
        double t = (Util.getMillis() - arrivalStart) / 1000.0;
        if (t < -1.5 || t > ARRIVAL) return;
        var g = event.getGuiGraphics();
        int core = OpmSession.get().corrupted() ? 0xFFD3DD : 0xE9FFFC;
        double flash = t < 0 ? 1 : Math.max(0, 1 - t / 1.0);
        if (flash > 0) g.fill(0, 0, g.guiWidth(), g.guiHeight(), ((int) (flash * 255) << 24) | core);
    }
}
