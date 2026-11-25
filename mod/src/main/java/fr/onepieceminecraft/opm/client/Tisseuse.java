package fr.onepieceminecraft.opm.client;

import java.util.HashMap;
import java.util.Map;

/**
 * Le mouvement de Xenodys la Tisseuse et de ses assistants : ce que leurs os font en
 * plus des animations (ailes, robe, cheveux, planétaire, monde entre ses mains…).
 * Les formules sont celles d'OPMTech ; le launcher a les mêmes (components/tisseuse.js).
 * Angles en radians, convention Bedrock, à ajouter au repos.
 */
final class Tisseuse {
    private static final int[][] RANGS = {{9, 52, 308}, {8, 64, 296}, {7, 76, 284}};
    private static final int[] PLUMES = {9, 8, 7};
    private static final double[] OPEN = {0.28, 0.22, -0.1};
    private static final double[] SHUT = {0.75, 0.45, 0.18};
    private static final float[] ZERO = new float[3];

    /** Ce qui s'ajoute à un os : rotation, position, échelle. `abs` : remplace l'angle de l'animation. */
    static final class Extra {
        float[] r;
        float[] p;
        float[] s;
        boolean abs;
    }

    private final Rig.Pose pose;
    private final Map<String, Extra> out = new HashMap<>(512);

    private Tisseuse(Rig.Pose pose) {
        this.pose = pose;
    }

    static Map<String, Extra> drive(String id, Rig.Pose pose, Rig.Options o) {
        Tisseuse d = new Tisseuse(pose);
        switch (id) {
            case "xenodys_tisseuse" -> d.tisseuse(pose.t, o);
            case "assistant_graine" -> d.graine(pose.t, o);
            case "assistant_luciole" -> d.luciole(pose.t);
            case "assistant_fileuse" -> d.fileuse(pose.t, o);
            default -> { }
        }
        return d.out;
    }

    /** La hauteur à laquelle flotte la luciole (blocs). */
    static double lucioleFloat(double t) {
        return 0.12 + 0.08 * Math.sin(2 * t);
    }

    private float[] inp(String bone) {
        return pose.inp.getOrDefault(bone, ZERO);
    }

    private Extra rot(String bone, double x, double y, double z) {
        Extra e = out.computeIfAbsent(bone, k -> new Extra());
        e.r = new float[]{(float) x, (float) y, (float) z};
        return e;
    }

    private Extra set(String bone, double x, double y, double z) {
        Extra e = rot(bone, x, y, z);
        e.abs = true;
        return e;
    }

    private static double lim(double v, double a, double b) {
        return Math.min(b, Math.max(a, v));
    }

    private static double sin(double v) {
        return Math.sin(v);
    }

    private void tisseuse(double t, Rig.Options o) {
        float[] body = inp("body");
        float[] chest = inp("chest");
        float[] head = inp("head");
        for (int s = 1; s >= -1; s -= 2) {
            String side = s > 0 ? "left" : "right";
            String g = s > 0 ? "g" : "d";
            float[] arm = inp("arm_" + side);
            float[] fore = inp("forearm_" + side);
            rot("pauldron_" + side, 0, 0, -s * 0.25 * Math.max(0, -s * arm[2]));
            rot("manche_" + g, lim(-0.55 * (arm[0] + fore[0] + body[0] + chest[0]), -0.3, 1.1) + 0.05 * sin(1.3 * t + s), 0,
                    0.04 * sin(1.1 * t + s));
            rot("meche_" + g, lim(-0.5 * (head[0] + body[0] + chest[0]), -0.2, 0.7) + 0.03 * sin(1.5 * t + s), 0, 0);
            // Les ailes.
            float[] wing = inp("wing_" + side);
            double ouv = -s * wing[2];
            double shut = ouv < 0 ? -ouv : 0;
            for (int w = 0; w < 3; w++) {
                double part = ouv > 0 ? OPEN[w] : SHUT[w];
                rot("aile_" + w + "_" + g, 0, 0.5 * wing[1] - s * (0.1 + 0.04 * sin(1.1 * t - 0.7 * w)) - 0.45 * s * shut,
                        -s * ouv * part + 0.02 * s * sin(1.1 * t - 0.9 * w));
                int n = PLUMES[w];
                for (int k = 0; k < n; k++) {
                    double q = k / (double) (n - 1);
                    rot("aile_" + w + "_" + k + "_" + g, 0, 0,
                            s * (-0.16 * ouv * (q - 0.35) + 0.018 * sin(1.4 * t - 0.55 * k - w) + 0.22 * shut * (1 - q)));
                }
            }
        }
        // Les cheveux.
        double rx = 0;
        double rz = 0;
        for (int i = 0; i < 4; i++) {
            float[] c = inp("cable_" + i);
            rx += c[0] / 4;
            rz += c[2] / 4;
        }
        rx = lim(rx, -0.5, 0.55);
        for (int i = 0; i < 9; i++) {
            double u = (i - 4) / 4.0;
            rot("fibre_" + i, 0.55 * rx + 0.035 * sin(1.6 * t + 1.1 * i), 0,
                    0.55 * rz - 0.05 * u * Math.max(0, rx) + 0.03 * sin(1.3 * t + i));
            rot("fibre_" + i + "_b", 0.5 * rx + 0.06 * sin(1.6 * t + 1.1 * i - 0.9), 0, 0.5 * rz + 0.05 * sin(1.3 * t + i - 0.8));
        }
        rot("astres", 0, 0, 0.16 * sin(0.5 * t)).p = new float[]{0, (float) (-0.5 * sin(0.8 * t)), 0};
        // Les jambes, la robe.
        float[] sp = inp("spire");
        double spx = lim(sp[0] - 0.8 * body[0], -0.35, 1.35);
        double spz = lim(sp[2] - 0.8 * body[2], -0.5, 0.5);
        set("spire", spx, 0, spz);
        rot("pointe", 0, 0.9 * t, 0);
        float[] sl = inp("skirt_left");
        float[] sr = inp("skirt_right");
        float[] sb = inp("skirt_back");
        float[] sf = inp("skirt_front");
        double traine = (sl[0] + sr[0]) / 2 + 0.25 * sb[0];
        double travers = 0.4 * (sl[2] + sr[2]);
        for (int rang = 0; rang < 3; rang++) {
            int n = RANGS[rang][0];
            for (int i = 0; i < n; i++) {
                double a = Math.toRadians(RANGS[rang][1] + (RANGS[rang][2] - RANGS[rang][1]) * i / (double) (n - 1));
                double ca = Math.cos(a);
                double sa = sin(a);
                double ouvre = lim(Math.max(0, sa) * -sl[2] + Math.max(0, -sa) * sr[2] + Math.max(0, -ca) * lim(sb[0], -0.1, 0.5)
                        + 0.4 * Math.max(0, ca) * lim(-sf[0], 0, 0.5), -0.12, 0.8);
                double suit = spx * (0.45 + 0.5 * (1 - ca) / 2);
                double phi = 0.8 * ouvre + 0.025 * sin(1.5 * t + 0.8 * i + 0.7 * rang);
                double phi2 = 0.35 * ouvre + 0.04 * sin(1.5 * t + 0.8 * i + 0.7 * rang - 0.9);
                String name = "petale_" + rang + "_" + i;
                rot(name, suit + 0.35 * traine - phi * ca, 0, 0.8 * spz + travers - phi * sa);
                rot(name + "_b", 0.4 * traine - phi2 * ca + 0.08 * suit, 0, 0.5 * travers - phi2 * sa);
            }
        }
        // Le planétaire.
        float[] halo = inp("halo");
        float[] inner = inp("halo_inner");
        double pz = 0.4 * halo[2];
        rot("planetaire", 0.5 * halo[0], 0, pz);
        double[] rings = {0.13 * t + 0.3 * inner[2], -0.085 * t - 0.5 * halo[2], 0.055 * t + 0.25 * halo[2]};
        for (int i = 0; i < 3; i++) rot("anneau_" + i, 0, 0, rings[i]);
        for (int k = 0; k < 7; k++) {
            double ring = rings[k < 2 ? 0 : k < 4 ? 1 : 2];
            rot("monde_" + k, 0, 0.2 * t + k, -(pz + ring) - chest[2] - body[2]);
        }
        // Le monde en création : entre ses mains, ou au-dessus d'elle quand elles servent.
        double h = 1 - o.hands;
        Extra c = rot("creation", -body[0] * h, 0.25 * t, 0);
        c.p = new float[]{0, (float) (38 * h - 0.5 * sin(1.1 * t)), (float) (-6 * sin(Math.PI * h) + 8.5 * h)};
        float size = (float) (1 - 0.15 * h + 0.02 * sin(2 * t));
        c.s = new float[]{size, size, size};
        rot("creation_0", 0, -0.7 * t, 0);
        rot("creation_1", 0.2 * sin(0.7 * t), 0, 0.5 * t);
        if (o.blink) rot("visiere", 0, 0, 0).s = new float[]{1, 0.12f, 1};
        rot("coeur", 0, 0, 0).s = new float[3];
    }

    private void graine(double t, Rig.Options o) {
        for (String side : new String[]{"left", "right"}) {
            float[] a = inp("arm_" + side);
            double k = Math.max(Math.abs(a[0]), Math.abs(a[2])) > 0.9 ? 1 : 0.25;
            set("arm_" + side, a[0] * k, a[1] * k, a[2] * k);
        }
        for (int s = 1; s >= -1; s -= 2) rot("feuille_" + (s > 0 ? "g" : "d"), 0, 0, s * (0.1 * sin(2.2 * t + s) + 0.25 * o.walk));
        rot("cube", 0, 0, 0).p = new float[]{0, (float) (-0.3 * sin(2.4 * t)), 0};
        set("halo", 0, 1.2 * t, 0);
    }

    private void luciole(double t) {
        float[] head = inp("head");
        rot("body", head[0], head[1], head[2]);
        for (int s = 1; s >= -1; s -= 2) {
            String g = s > 0 ? "g" : "d";
            rot("aile_0_" + g, 0, 0.75 * s * sin(22 * t), 0);
            rot("aile_1_" + g, 0, 0.75 * s * sin(22 * t - 0.9), 0);
        }
        for (String side : new String[]{"left", "right"}) {
            float[] a = inp("arm_" + side);
            set("arm_" + side, 0.6 * a[0], 0.6 * a[1], 0.6 * a[2]);
        }
        set("halo", 0, 1.2 * t, 0);
    }

    private void fileuse(double t, Rig.Options o) {
        float l = inp("leg_left")[0];
        float r = inp("leg_right")[0];
        for (int s = 1; s >= -1; s -= 2) {
            String g = s > 0 ? "g" : "d";
            float a = s > 0 ? l : r;
            float b = s > 0 ? r : l;
            rot("patte_0_" + g, 0.5 * a, 0, 0);
            rot("patte_1_" + g, 0.5 * b, 0, 0);
            rot("pied_0_" + g, -0.25 * a, 0, 0);
            rot("pied_1_" + g, -0.25 * b, 0, 0);
            rot("arm_" + (s > 0 ? "left" : "right"), 0.16 * sin(5 * t + 1.6 * s), 0, 0.1 * sin(5 * t + 1.6 * s + 1));
        }
        rot("bobine", -t * (0.8 + 3 * o.walk), 0, 0);
        set("halo", 0, 1.2 * t, 0);
    }
}
