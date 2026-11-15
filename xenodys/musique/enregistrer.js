/**
 * Enregistre la musique du launcher (components/ambiance.js, générative) pour le
 * mod du jeu : 150 s par état de Xenodys, en temps réel, dans des fenêtres
 * cachées. Puis `encoder.py` en fait les OGG du mod.
 *
 *   cd launcher && node_modules/.bin/electron ../xenodys/musique/enregistrer.js
 *   python3 ../xenodys/musique/encoder.py
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const SECONDS = Number(process.env.REC_SECONDS || 150);
app.whenReady().then(async () => {
  const jobs = ['creatrice', 'corrompue'].map((etat) => new Promise((resolve) => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, webSecurity: false } });
    win.webContents.on('console-message', (_e, _l, msg) => console.log(`[${etat}] ${msg}`));
    win.loadFile(path.join(__dirname, 'page.html'), { query: { etat, seconds: String(SECONDS), out: path.join(__dirname, `${etat}.wav`) } });
    win.webContents.ipc.on('done', () => { resolve(); });
    const t = setInterval(async () => {
      const done = await win.webContents.executeJavaScript('window.__done === true').catch(() => false);
      if (done) { clearInterval(t); resolve(); }
    }, 2000);
  }));
  await Promise.all(jobs);
  app.quit();
});
