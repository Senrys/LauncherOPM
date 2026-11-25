package fr.onepieceminecraft.opm.client;

import net.minecraft.Util;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.options.OptionsScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;
import net.minecraft.client.resources.sounds.SimpleSoundInstance;
import net.minecraft.network.chat.Component;
import net.minecraft.sounds.SoundEvents;
import org.lwjgl.glfw.GLFW;

/**
 * L'écran titre de One Piece Minecraft : le laboratoire de Xenodys en 3D
 * (client/LabScene) et, à gauche, le terminal du menu (client/Terminal). Elle
 * veille sur le joueur, part construire et expérimenter, suit la souris du
 * regard, regarde la ligne survolée, et tend la main quand on rejoint le serveur.
 *
 * On n'y rejoint qu'un serveur : celui d'OPM (pas de solo, pas de liste de
 * serveurs). C'est aussi l'écran où l'on revient après une déconnexion.
 */
public final class OpmTitleScreen extends Screen {
    private final OpmSession session = OpmSession.get();
    private final LabScene.View view = new LabScene.View();
    private final double[] glow = new double[3];
    private long last = -1;
    private double t;
    private int hover = -1;
    private int lastHover = -1;

    private double lastMx = -1;
    private double lastMy = -1;
    private double movedAt = -10;
    // Le salut (greet) avant de rejoindre : début, et action différée.
    private double greetAt = -1;
    private boolean joining;

    private int k = 1;
    private int vw;
    private int vh;
    private final int[][] buttons = new int[3][4];

    public OpmTitleScreen() {
        super(Component.literal("One Piece Minecraft"));
    }

    @Override
    protected void init() {
        OpmLive.start();
        Skins.start(session);
        Skins.fallbackOwn();
    }

    /** Le serveur ne répond pas (connu comme tel). */
    private static boolean offline() {
        return OpmLive.known && !OpmLive.online;
    }

    private double vpX(double guiX) {
        return guiX * minecraft.getWindow().getGuiScale() / k;
    }

    private double vpY(double guiY) {
        return guiY * minecraft.getWindow().getGuiScale() / k;
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        long now = Util.getMillis();
        double dt = last < 0 ? 0 : Math.min(0.1, (now - last) / 1000.0);
        last = now;
        t += dt;
        var window = minecraft.getWindow();
        k = Math.max(1, window.getHeight() / 270);
        vw = (int) Math.ceil(window.getWidth() / (double) k);
        vh = (int) Math.ceil(window.getHeight() / (double) k);
        float s = (float) (k / window.getGuiScale());
        double mx = vpX(mouseX);
        double my = vpY(mouseY);
        boolean corrupted = session.corrupted();

        // ------------------------------------------------- géométrie du menu
        int left = Math.max(10, Math.round(vw * 0.038f));
        int panelW = Math.min(236, Math.round(vw * 0.46f));
        int right = left + panelW;
        int panelH = Math.min(vh - 14, 270);
        int top = (vh - panelH) / 2;
        int bottom = top + panelH;
        int bx = left + 14;
        int bw = panelW - 28;
        int by = bottom - 88;
        set(0, bx, by, bw, 24);
        set(1, bx, by + 29, bw, 17);
        set(2, bx, by + 50, bw, 17);
        hover = -1;
        for (int i = 0; i < 3; i++) if (inside(i, mx, my)) hover = i;
        if (hover >= 0 && hover != lastHover) {
            minecraft.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.UI_BUTTON_CLICK.value(), 1.6f, 0.15f));
        }
        lastHover = hover;
        for (int i = 0; i < 3; i++) glow[i] += ((hover == i ? 1 : 0) - glow[i]) * (1 - Math.exp(-14 * dt));

        // ------------------------------------------------------ le laboratoire
        if (mx != lastMx || my != lastMy) {
            lastMx = mx;
            lastMy = my;
            movedAt = t;
        }
        boolean looks = hover >= 0 || t - movedAt < 2.5;
        double lx = hover >= 0 ? buttons[hover][0] + buttons[hover][2] / 2.0 : mx;
        double ly = hover >= 0 ? buttons[hover][1] + buttons[hover][3] / 2.0 : my;
        view.etat = session.etat;
        view.menu = 1;
        view.tankDown = 1;
        view.drain = 1;
        view.inMenu = true;
        view.lookX = looks ? (float) (lx / vw * 2 - 1) : Float.NaN;
        view.lookY = looks ? (float) (1 - ly / vh * 2) : Float.NaN;
        view.greet = greetAt >= 0 ? t - greetAt : -1;
        view.leave = greetAt >= 0 ? (float) Math.max(0, Math.min(1, (t - greetAt - 0.5) / 1.1)) : 0;
        view.waiting = OpmLive.full();
        view.away = offline();
        g.flush();
        LabScene.get().render(window.getWidth(), window.getHeight(), LabScene.clock(), view);

        // --------------------------------------------------------- le terminal
        var pose = g.pose();
        pose.pushPose();
        pose.scale(s, s, 1);
        // Il s'ouvre ligne à ligne.
        double open = LabScene.ease(t / 0.45);
        Sprites.alpha = (float) open;
        int shift = (int) Math.round((1 - open) * -16);
        pose.translate(shift, 0, 0);
        int y = Terminal.frame(g, left, top, right, bottom, corrupted, "Terminal OPM", 1) + 8;
        Sprites.Sheet banner = Sprites.get(corrupted ? "bandeau_960_corrompue" : "bandeau_960");
        if (banner != null) {
            float bs = Math.min(vh < 270 ? 0.13f : 0.17f, (bw - 10) / (float) banner.w());
            Sprites.draw(g, banner, 0, left + (panelW - banner.w() * bs) / 2f, y, false, 1f, bs);
            y += Math.round(banner.h() * bs) + 8;
        }
        String status = !OpmLive.known ? "Connexion au serveur…"
                : !OpmLive.online ? "Serveur hors ligne"
                : OpmLive.full() ? "Serveur complet · " + OpmLive.players + "/" + OpmLive.max
                : "Serveur en ligne · " + OpmLive.players + (OpmLive.players > 1 ? " joueurs" : " joueur");
        int dot = !OpmLive.known ? 0x7FA8A3 : !OpmLive.online ? 0xFF7A6A : OpmLive.full() ? 0xF2DC9A : 0x7FE97F;
        double blink = OpmLive.known && OpmLive.online ? 1 : 0.55 + 0.45 * Math.sin(t * 5);
        g.fill(bx, y + 2, bx + 4, y + 6, Terminal.argb(dot, blink));
        PixelFont.draw(g, status, bx + 10, y, Terminal.TEXT, 1f, 1f);
        y += 13;
        Terminal.trace(g, corrupted, t, 1, bx + 1, y, bx + bw * 2 / 5, y, bx + bw * 2 / 5, y + 4, bx + bw - 2, y + 4);
        y += 10;
        // Ce que dit Xenodys : l'annonce du staff, sinon l'état du monde.
        String said = session.message != null ? session.message
                : offline() ? "Le monde est hors d'atteinte… Xenodys le cherche dans la simulation."
                : OpmLive.full() ? "Le monde est plein. Xenodys vous garde une place."
                : corrupted ? "Xenodys n'est plus elle-même. Prudence, aventurier." : "Xenodys veille sur la simulation.";
        String news = OpmLive.news;
        PixelFont.draw(g, "Xenodys", bx, y, Terminal.accent(corrupted), 1f, 1f);
        y = wrap(g, said, bx, y + 10, bw, Terminal.TEXT, news != null ? 2 : 3);
        if (news != null && y + 22 < by) {
            PixelFont.draw(g, "Journal de bord", bx, y + 3, Terminal.accent(corrupted), 1f, 1f);
            wrap(g, news, bx, y + 13, bw, Terminal.PALE, y + 34 < by ? 2 : 1);
        }
        button(g, 0, joining ? "Xenodys vous emmène…" : offline() ? "Réessayer la connexion"
                : OpmLive.full() ? "Tenter de rejoindre" : "Rejoindre One Piece Minecraft", corrupted);
        button(g, 1, "Options", corrupted);
        button(g, 2, "Quitter", corrupted);
        String who = session.playerName != null ? "Connecté : " + session.playerName : "Lancez le jeu depuis le launcher OPM";
        PixelFont.draw(g, who, bx, bottom - 15, session.fromLauncher ? Terminal.DIM : 0xFF7A6A, 1f, 1f);
        Sprites.alpha = 1f;
        pose.popPose();
        DebugShots.maybe("titre", t);
        DebugShots.drive(this, t);
        double auto = Double.parseDouble(System.getProperty("opm.debug.join", "-1"));
        if (auto >= 0 && t >= auto && !joining && greetAt < 0) activate(0);

        if (joining && greetAt >= 0 && t - greetAt > 1.7) {
            joining = false;
            greetAt = -1;
            connect();
        }
    }

    private void button(GuiGraphics g, int i, String label, boolean corrupted) {
        int[] b = buttons[i];
        Terminal.line(g, b[0], b[1], b[2], b[3], label, corrupted, i == 0, glow[i], 1);
    }

    private int wrap(GuiGraphics g, String text, int x, int y, int width, int rgb, int maxLines) {
        StringBuilder line = new StringBuilder();
        int lines = 0;
        for (String word : text.split(" ")) {
            String next = line.isEmpty() ? word : line + " " + word;
            if (PixelFont.width(next) > width && !line.isEmpty()) {
                if (++lines > maxLines) return y;
                PixelFont.draw(g, line.toString(), x, y, rgb, 0.9f, 1f);
                y += 10;
                line = new StringBuilder(word);
            } else {
                line = new StringBuilder(next);
            }
        }
        if (!line.isEmpty() && ++lines <= maxLines) {
            PixelFont.draw(g, line.toString(), x, y, rgb, 0.9f, 1f);
            y += 10;
        }
        return y;
    }

    private void set(int i, int x, int y, int w, int h) {
        buttons[i][0] = x;
        buttons[i][1] = y;
        buttons[i][2] = w;
        buttons[i][3] = h;
    }

    private boolean inside(int i, double x, double y) {
        int[] b = buttons[i];
        return x >= b[0] && x < b[0] + b[2] && y >= b[1] && y < b[1] + b[3];
    }

    @Override
    public boolean mouseClicked(double mouseX, double mouseY, int button) {
        if (button != 0) return super.mouseClicked(mouseX, mouseY, button);
        double x = vpX(mouseX);
        double y = vpY(mouseY);
        for (int i = 0; i < 3; i++) {
            if (inside(i, x, y)) {
                activate(i);
                return true;
            }
        }
        return super.mouseClicked(mouseX, mouseY, button);
    }

    @Override
    public boolean keyPressed(int keyCode, int scanCode, int modifiers) {
        if (keyCode == GLFW.GLFW_KEY_ENTER || keyCode == GLFW.GLFW_KEY_KP_ENTER) {
            activate(0);
            return true;
        }
        return super.keyPressed(keyCode, scanCode, modifiers);
    }

    private void activate(int i) {
        minecraft.getSoundManager().play(SimpleSoundInstance.forUI(SoundEvents.UI_BUTTON_CLICK, 1f));
        switch (i) {
            case 0 -> {
                if (joining) return;
                // Elle tend la main, puis le serveur.
                joining = true;
                greetAt = t;
            }
            case 1 -> minecraft.setScreen(new OptionsScreen(this, minecraft.options));
            default -> minecraft.stop();
        }
    }

    /** Le seul serveur de cet écran : One Piece Minecraft. */
    private void connect() {
        String address = session.address();
        ServerData data = new ServerData("One Piece Minecraft", address, ServerData.Type.OTHER);
        ConnectScreen.startConnecting(this, minecraft, ServerAddress.parseString(address), data, false, null);
    }

    @Override
    public boolean shouldCloseOnEsc() {
        return false;
    }

    @Override
    public boolean isPauseScreen() {
        return false;
    }

    @Override
    public void renderBackground(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        // Le fond, c'est le laboratoire : rien à flouter.
    }
}
