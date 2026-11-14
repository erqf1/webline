'use strict';

// Unsichtbarer Test für Web-Programme: `npx electron tools/test-web.js [screenshot-ordner]`
// Eigener Datenordner (die echte Programmliste bleibt unberührt), Fenster unsichtbar und außerhalb des Bildschirms,
// lokaler Mini-Webserver statt echter Seite. Beendet sich mit Code 0 (alles ok) oder 1.

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shotDir = process.argv.find((a, i) => i > 1 && !a.startsWith('-') && !a.endsWith('.js')) || null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webline-test-'));
app.setPath('userData', tmp);
// Verknüpfungen landen im Test-Ordner, nicht auf dem echten Desktop
const fakeDesktop = path.join(tmp, 'desktop');
fs.mkdirSync(fakeDesktop, { recursive: true });
app.setPath('desktop', fakeDesktop);

// Fenster nie sichtbar machen
app.on('browser-window-created', (_e, win) => {
  win.setOpacity(0);
  win.setSkipTaskbar(true);
  win.setPosition(-32000, -32000);
  // "anzeigen" ohne Fokus (unsichtbar, außerhalb des Bildschirms) - sonst zeichnet Chromium das Fenster nicht
  const showInactive = win.showInactive.bind(win);
  win.show = () => showInactive();
  win.maximize = () => {};
  win.focus = () => {};
  // unsichtbare Fenster würden sonst nicht neu gezeichnet (Screenshots zeigen alten Stand)
  win.webContents.setBackgroundThrottling(false);
});

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${ok ? 'OK  ' : 'FEHL'} ${name}${extra ? ` - ${extra}` : ''}`);
};

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/seite2')) return res.end('<!doctype html><title>Seite 2</title><h1 id="s2">Seite 2</h1>');
  res.end('<!doctype html><title>Hilfe-Test</title><body style="font:20px system-ui;background:#eef"><h1>Hilfe</h1><a id="l" href="/seite2">weiter</a></body>');
});

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function shot(win, name) {
  if (!shotDir) return;
  // Für den Screenshot kurz deckend zeichnen (Fenster bleibt außerhalb des Bildschirms)
  win.setOpacity(1);
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 400));
  fs.mkdirSync(shotDir, { recursive: true });
  const img = await win.webContents.capturePage();
  win.setOpacity(0);
  fs.writeFileSync(path.join(shotDir, name), img.toPNG());
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  require('../src/main.js');
  app.whenReady().then(async () => {
    try {
      const launcher = await waitFor(() => BrowserWindow.getAllWindows().find((w) => /renderer[\\/]index\.html/.test(w.webContents.getURL())));
      check('Launcher geladen', !!launcher);
      await waitFor(async () => !launcher.webContents.isLoading());
      const run = (js) => launcher.webContents.executeJavaScript(js);

      const bad = await run(`window.launcher.addUrl('kein link')`);
      check('Ungültige Adresse abgelehnt', bad && bad.ok === false);

      const res = await run(`window.launcher.addUrl('http://127.0.0.1:${port}/hilfe')`);
      check('Webseite hinzugefügt', res && res.ok, JSON.stringify(res));
      const st = await run('window.launcher.getState()');
      const item = st.items.find((i) => i.id === res.id);
      check('Eintrag ist Web mit Seitentitel', item && item.kind === 'web' && item.name === 'Hilfe-Test', item && `${item.kind} / ${item.name}`);
      const dup = await run(`window.launcher.addUrl('127.0.0.1:${port}/hilfe')`);
      check('Doppelt wird erkannt (ohne http://)', dup && dup.id === res.id);
      await new Promise((r) => setTimeout(r, 600));
      const cards = await run("document.querySelectorAll('.card').length");
      check('Karte erscheint im Launcher', cards === 1, `${cards} Karte(n)`);
      launcher.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 300));
      await shot(launcher, 'launcher.png');

      if (process.platform === 'win32' || process.platform === 'linux') {
        const made = await run(`window.launcher.shortcut('${res.id}')`);
        const files = fs.readdirSync(fakeDesktop);
        check('Desktop-Verknüpfung erstellt', made === true && files.length === 1, files.join(', '));
        if (process.platform === 'win32' && files[0]) {
          const { shell } = require('electron');
          const link = shell.readShortcutLink(path.join(fakeDesktop, files[0]));
          check('Verknüpfung startet Webline mit der Adresse', /127\.0\.0\.1/.test(link.args), `${link.target} ${link.args}`);
        }
      }

      await run(`window.launcher.launch('${res.id}')`);
      const prog = await waitFor(() => BrowserWindow.getAllWindows().find((w) => w !== launcher && /127\.0\.0\.1/.test(w.webContents.getURL())));
      check('Programmfenster öffnet die Seite', !!prog, prog && prog.webContents.getURL());
      await waitFor(async () => prog && !prog.webContents.isLoading());
      await shot(prog, 'programm.png');
      check('Kein Adressleisten-Menü', prog && !prog.isMenuBarVisible());

      // Link auf derselben Seite bleibt im Fenster
      await prog.webContents.executeJavaScript("document.getElementById('l').click()");
      const nav = await waitFor(async () => /seite2/.test(prog.webContents.getURL()) && !prog.webContents.isLoading(), 5000);
      await new Promise((r) => setTimeout(r, 500));
      check('Link auf derselben Seite bleibt im Fenster', !!nav && /seite2/.test(prog.webContents.getURL()), prog.webContents.getURL());
      await shot(prog, 'programm-seite2.png');

      // Start wie aus einer Desktop-Verknüpfung: Webline wird mit einer Adresse aufgerufen
      const before = BrowserWindow.getAllWindows().length;
      app.emit('second-instance', {}, [process.execPath, 'tools/test-web.js', `http://127.0.0.1:${port}/seite2?direkt`]);
      const direct = await waitFor(() => BrowserWindow.getAllWindows().find((w) => /direkt/.test(w.webContents.getURL())), 8000);
      check('Start mit Adresse öffnet das Programm direkt', !!direct && BrowserWindow.getAllWindows().length > before);
      const st2 = await run('window.launcher.getState()');
      check('und legt es in der Liste an', st2.items.length === 2, `${st2.items.length} Einträge`);
    } catch (e) {
      check('Ablauf', false, String(e && e.stack || e));
    }
    const ok = results.every(Boolean);
    console.log(ok ? 'ALLES OK' : 'FEHLER');
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    app.exit(ok ? 0 : 1);
  });
});
