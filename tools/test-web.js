'use strict';

// Unsichtbarer Test für Web-Programme: `npx electron tools/test-web.js [screenshot-ordner]`
// Eigener Datenordner (die echte Programmliste bleibt unberührt), Fenster unsichtbar und außerhalb des Bildschirms,
// lokaler Mini-Webserver statt echter Seiten (Namen wie www.webline.test zeigen per Chromium-Regel auf 127.0.0.1).
// Der Standardbrowser wird nie geöffnet (shell.openExternal ist ersetzt). Beendet sich mit Code 0 (alles ok) oder 1.

const { app, BrowserWindow, webContents: allContents, shell, dialog, nativeImage, screen } = require('electron');
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
// Test-Domains auf den lokalen Server, ohne Proxy
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1, MAP webline.test 127.0.0.1');
app.commandLine.appendSwitch('no-proxy-server');

// Standardbrowser nie öffnen, nur mitschreiben
const external = [];
shell.openExternal = async (url) => {
  external.push(url);
};

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
  results.push(!!ok);
  console.log(`${ok ? 'OK  ' : 'FEHL'} ${name}${extra ? ` - ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Testbilder und -seiten

/** einfarbiges Quadrat (BGRA) */
function solid(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = b;
    buf[i + 1] = g;
    buf[i + 2] = r;
    buf[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

/** Farbe in der Bildmitte als [r, g, b] */
function center(img) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return [bmp[i + 2], bmp[i + 1], bmp[i]];
}
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 24);
const RED = [220, 40, 40];
const BLUE = [40, 90, 220];
const PURPLE = [120, 60, 200];

const SNAP_PAGE = `<!doctype html><title>Snap-Test</title>
<script>
  // Größe, die die Seite beim allerersten Ausführen sieht (wie es Scroll-Bibliotheken tun)
  window.__first = { h: innerHeight, w: innerWidth };
  window.__resizes = 0;
  addEventListener('resize', () => window.__resizes++);
</script>
<style>
  html { scroll-snap-type: y mandatory; }
  body { margin: 0; font: 20px system-ui; }
  section { height: 100vh; scroll-snap-align: start; display: grid; place-items: center; }
  section:nth-child(1) { background: #e8ecff; } section:nth-child(2) { background: #dff5ea; } section:nth-child(3) { background: #f4e6ff; }
</style>
<section id="a"><h1>Abschnitt 1</h1></section>
<section id="b"><h1>Abschnitt 2</h1><a id="fremd" href="/fremd-link">fremde Seite</a></section>
<section id="c"><h1>Abschnitt 3</h1></section>`;

const LOGIN_PAGE = `<!doctype html><title>Anmelden</title>
<style>input:focus{outline:2px solid #6366f1;outline-offset:1px}</style>
<body style="font:16px system-ui;margin:60px auto;max-width:360px;background:#f6f7fb">
<h2>Anmelden</h2>
<form id="f" method="post" action="/eingeloggt" style="display:grid;gap:10px">
  <input id="user" name="user" autocomplete="username" placeholder="Benutzer" style="padding:10px;font:inherit">
  <input id="pw" name="pw" type="password" autocomplete="current-password" placeholder="Passwort" style="padding:10px;font:inherit">
  <button id="go" style="padding:10px;font:inherit">Anmelden</button>
</form>
<script>
  // Was die Seite selbst von Webline sieht (darf nichts sein)
  window.__leak = typeof require + '/' + typeof window.launcher + '/' + typeof window.ipcRenderer;
</script>`;

function startServer(icons) {
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const port = server.address().port;
    const send = (type, body, status = 200) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    const url = req.url;
    if (url === '/favicon.ico') return icons.favicon ? send('image/x-icon', icons.favicon) : send('text/plain', 'nein', 404);
    if (url === '/icon-192.png') return send('image/png', icons.red);
    if (url === '/apple-touch-icon.png') return send('text/plain', 'nein', 404);
    if (url === '/fremd-link') {
      // derselbe Pfad auf fremd.test ist eine fremde Seite
      res.writeHead(302, { location: `http://fremd.test:${port}/fremd` });
      return res.end();
    }
    if (url === '/fremd' || host === 'fremd.test') return send('text/html', `<!doctype html><title>Fremd</title><h1 id="f">Fremde Seite ${url}</h1><a id="weiter" href="/f6b">weiter</a>`);
    if (url.startsWith('/seite2')) return send('text/html', '<!doctype html><title>Seite 2</title><h1 id="s2">Seite 2</h1>');
    if (url === '/start') {
      // Weiterleitung per Skript auf eine andere Origin derselben Seite (ohne www -> www)
      return send('text/html', `<!doctype html><title>Start</title><script>location.replace('http://www.webline.test:${port}/snap')</script>`);
    }
    if (url === '/snap') return send('text/html', SNAP_PAGE);
    if (url === '/schleife') return send('text/html', `<!doctype html><title>Schleife</title><script>setTimeout(() => location.href = 'http://ziel.test:${port}/irgendwo', 50)</script>`);
    if (url === '/login' || url.startsWith('/login?')) return send('text/html', LOGIN_PAGE);
    if (url === '/eingeloggt') return send('text/html', '<!doctype html><title>Drin</title><h1 id="drin">Angemeldet</h1>');
    if (url === '/plain') return send('text/html', '<!doctype html><title>Ohne Symbol-Link</title><h1>plain</h1>');
    send('text/html', '<!doctype html><title>Hilfe-Test</title><link rel="icon" sizes="192x192" href="/icon-192.png"><link rel="mask-icon" href="/mask.svg"><body style="font:20px system-ui;background:#eef"><h1>Hilfe</h1><a id="l" href="/seite2">weiter</a></body>');
  });
  return server;
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

async function shot(win, name, overlay = null) {
  if (!shotDir) return;
  // Für den Screenshot kurz deckend zeichnen (Fenster bleibt außerhalb des Bildschirms)
  win.setOpacity(1);
  win.webContents.invalidate();
  if (overlay) overlay.invalidate();
  await sleep(500);
  fs.mkdirSync(shotDir, { recursive: true });
  const img = await win.webContents.capturePage();
  win.setOpacity(0);
  fs.writeFileSync(path.join(shotDir, name), img.toPNG());
  if (overlay) fs.writeFileSync(path.join(shotDir, name.replace(/\.png$/, '-overlay.png')), (await overlay.capturePage()).toPNG());
}

const programWindows = (launcher) => BrowserWindow.getAllWindows().filter((w) => w !== launcher && !w.weblineHelper && !w.isDestroyed());
const urlbarContents = () => allContents.getAllWebContents().find((w) => !w.isDestroyed() && /urlbar\.html$/.test(w.getURL()));
const key = (wc, keyCode, modifiers = []) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
};
// Zurück: Alt+← (Windows/Linux) bzw. ⌘+[ (macOS)
const backKey = (wc) => (process.platform === 'darwin' ? key(wc, '[', ['meta']) : key(wc, 'Left', ['alt']));

app.whenReady().then(() => {
  const icons = { red: solid(192, RED).toPNG(), favicon: null };
  const server = startServer(icons);
  server.listen(0, '127.0.0.1', () => run(server, icons));
});

/** Bilder für die Website (nur mit Screenshot-Ordner): deutsche Oberfläche, mehrere Programme mit Symbolen */
async function websiteShots(launcher, run, port, sw) {
  await run(`window.launcher.setSettings({ language: 'de' })`);
  const glyph = (bg, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${bg}"/>${inner}</svg>`;
  const programs = [
    ['notizen', 'Notizen', glyph('#4f46e5', '<path d="M20 16h18l8 8v24H20z" fill="#fff"/><path d="M26 32h14M26 39h10" stroke="#4f46e5" stroke-width="3" stroke-linecap="round"/>')],
    ['wetter', 'Wetter', glyph('#0ea5e9', '<circle cx="27" cy="27" r="9" fill="#fff"/><path d="M22 46h22a7 7 0 0 0 0-14 10 10 0 0 0-19 3 6 6 0 0 0-3 11z" fill="#e0f2fe"/>')],
    ['kalender', 'Kalender', glyph('#db2777', '<rect x="16" y="18" width="32" height="30" rx="5" fill="#fff"/><path d="M16 27h32" stroke="#db2777" stroke-width="3"/><text x="32" y="44" font-family="Segoe UI,Arial" font-size="13" font-weight="700" text-anchor="middle" fill="#db2777">19</text>')],
  ];
  // Test-Einträge weg, nur die Scroll-Seite (läuft gerade) bleibt
  const snapItem = (await run('window.launcher.getState()')).items.find((i) => /webline\.test/.test(i.url ?? ''));
  for (const w of programWindows(launcher)) if (w !== sw) w.close();
  for (const i of (await run('window.launcher.getState()')).items) if (i.id !== snapItem.id) await run(`window.launcher.remove('${i.id}')`);
  programs.push(['scroll', 'Scroll-Seite', glyph('#0f766e', '<rect x="20" y="14" width="24" height="36" rx="6" fill="none" stroke="#fff" stroke-width="3"/><path d="M32 22v8" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'), snapItem.id]);
  const realDialog = dialog.showOpenDialog;
  for (const [slug, name, svg, existing] of programs) {
    const r = existing ? { id: existing } : await run(`window.launcher.addUrl('http://${slug}.test:${port}/plain')`);
    await run(`window.launcher.rename('${r.id}', ${JSON.stringify(name)})`);
    const file = path.join(tmp, `${slug}.svg`);
    fs.writeFileSync(file, svg);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await run(`window.launcher.icon('${r.id}', 'pick')`);
  }
  dialog.showOpenDialog = realDialog;
  await sleep(5200); // Meldungen ausblenden lassen
  await shot(launcher, 'website-launcher.png');
  // Auswahl "Symbol ändern" auf der ersten Karte
  await run(`(() => { const b = document.querySelector('.card .icon-btn[aria-label="Symbol ändern"]'); b && b.click(); })()`);
  await sleep(500);
  await shot(launcher, 'website-symbol.png');
  await run(`document.getElementById('modal').close()`);
  // F6 auf Deutsch
  key(sw.webContents, 'F6');
  const bar = await waitFor(() => urlbarContents(), 5000);
  await waitFor(async () => bar && !bar.isLoading() && (await bar.executeJavaScript("document.getElementById('url').value")) !== '', 5000);
  await bar.executeJavaScript("document.getElementById('url').blur()");
  await shot(sw, 'website-f6.png', bar);
  key(bar, 'Escape');
  await waitFor(() => !urlbarContents(), 4000);
}

let loginWin = null;

async function passwordTests(launcher, run, port) {
  const asked = [];
  let answer = 0; // 0 Speichern/Aktualisieren, 1 Nicht jetzt, 2 Nie
  const realBox = dialog.showMessageBox;
  dialog.showMessageBox = async (_win, options) => {
    asked.push(options);
    return { response: answer, checkboxChecked: false };
  };
  const konto = await run(`window.launcher.addUrl('http://konto.test:${port}/login')`);
  await run(`window.launcher.launch('${konto.id}')`);
  const w = await waitFor(() => programWindows(launcher).find((x) => /konto\.test/.test(x.webContents.getURL())));
  loginWin = w;
  const wc = w.webContents;
  // wie ein Mensch: echter Mausklick auf ein Feld
  const clickOn = async (c, sel) => {
    c.focus();
    const p = await c.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.left + 20), y: Math.round(b.top + b.height / 2) }; })()`);
    c.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    c.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  };
  const loaded = (re) => waitFor(async () => re.test(wc.getURL()) && !wc.isLoading(), 6000);
  await loaded(/\/login$/);
  check('Seite sieht nichts von Webline (kein require/launcher/ipc)', (await wc.executeJavaScript('window.__leak')) === 'undefined/undefined/undefined', await wc.executeJavaScript('window.__leak'));

  const login = async (user, pass) => {
    await wc.executeJavaScript(`document.getElementById('user').value = ${JSON.stringify(user)}; document.getElementById('pw').value = ${JSON.stringify(pass)}; document.getElementById('go').click()`, true);
    await loaded(/\/eingeloggt$/);
    await sleep(400);
  };
  const back = async () => {
    wc.loadURL(`http://konto.test:${port}/login`);
    await loaded(/\/login$/);
  };

  await login('mert', 'geheim123');
  check('Anmelden fragt "Passwort speichern?"', asked.length === 1 && /konto\.test/.test(asked[0].message) && /mert/.test(asked[0].detail), asked[0] && asked[0].message);
  let st = await run('window.launcher.passwords.get()');
  check('Passwort gespeichert (ohne Passwort in der Übersicht)', st.available && st.entries.length === 1 && st.entries[0].username === 'mert' && !('password' in st.entries[0]), JSON.stringify(st.entries));
  const file = path.join(tmp, 'passwords.json');
  check('Datei verschlüsselt (kein Klartext)', fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('geheim123') && !fs.readFileSync(file, 'utf8').includes('mert'));

  // Ausfüllen per Tastatur: Feld anklicken, Auswahl erscheint, ↓ + Enter
  await back();
  check('Felder sind nicht ungefragt ausgefüllt', (await wc.executeJavaScript("document.getElementById('pw').value")) === '');
  await clickOn(wc, '#user');
  const popup = await waitFor(() => wc.executeJavaScript("!!document.querySelector('webline-autofill')"), 4000);
  check('Klick ins Benutzerfeld zeigt die Auswahl', !!popup);
  if (shotDir) await shot(w, 'website-autofill.png');
  key(wc, 'Down');
  key(wc, 'Return');
  const filled = await waitFor(async () => {
    const v = await wc.executeJavaScript("[document.getElementById('user').value, document.getElementById('pw').value]");
    return v[1] ? v : null;
  }, 4000);
  check('↓ + Enter füllt Benutzer und Passwort aus', filled && filled[0] === 'mert' && filled[1] === 'geheim123', JSON.stringify(filled));
  check('Auswahl ist danach weg', !(await wc.executeJavaScript("!!document.querySelector('webline-autofill')")));

  // Ausfüllen per Maus
  await back();
  await clickOn(wc, '#pw');
  await waitFor(() => wc.executeJavaScript("!!document.querySelector('webline-autofill')"), 4000);
  const r = await wc.executeJavaScript("(() => { const b = document.querySelector('webline-autofill').getBoundingClientRect(); return { x: b.left + 30, y: b.top + 18 }; })()");
  wc.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 });
  const filled2 = await waitFor(async () => (await wc.executeJavaScript("document.getElementById('pw').value")) || null, 4000);
  check('Klick auf das Konto füllt aus', filled2 === 'geheim123', String(filled2));

  // Die Seite selbst kann das Ausfüllen nicht auslösen (künstliche Tastendrücke zählen nicht)
  await back();
  await clickOn(wc, '#user');
  await waitFor(() => wc.executeJavaScript("!!document.querySelector('webline-autofill')"), 4000);
  await wc.executeJavaScript(`for (const k of ['ArrowDown', 'Enter']) document.getElementById('user').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))`);
  await sleep(600);
  check('Künstliche Tastendrücke der Seite füllen nichts aus', (await wc.executeJavaScript("document.getElementById('pw').value")) === '');
  key(wc, 'Escape');
  await back();
  await clickOn(wc, '#pw');
  await waitFor(() => wc.executeJavaScript("!!document.querySelector('webline-autofill')"), 4000);
  key(wc, 'Down');
  key(wc, 'Return');
  await waitFor(async () => (await wc.executeJavaScript("document.getElementById('pw').value")) || null, 4000);

  // Gleiche Anmeldung nochmal: keine Frage. Anderes Passwort: "aktualisieren?"
  await wc.executeJavaScript("document.getElementById('go').click()", true);
  await loaded(/\/eingeloggt$/);
  await sleep(400);
  check('Gleiche Anmeldung fragt nicht nochmal', asked.length === 1, `${asked.length} Fragen`);
  await back();
  await login('mert', 'neu456');
  check('Neues Passwort: "aktualisieren?"', asked.length === 2 && /aktualisieren|Update/i.test(asked[1].message), asked[1] && asked[1].message);
  st = await run('window.launcher.passwords.get()');
  check('und ersetzt den Eintrag', st.entries.length === 1);

  // Andere Seite (eigenes Programm): bekommt nichts angeboten
  const andere = await run(`window.launcher.addUrl('http://andere.test:${port}/login')`);
  await run(`window.launcher.launch('${andere.id}')`);
  const w2 = await waitFor(() => programWindows(launcher).find((x) => /andere\.test/.test(x.webContents.getURL())));
  await waitFor(async () => !w2.webContents.isLoading());
  await clickOn(w2.webContents, '#user');
  await sleep(800);
  check('Andere Seite bekommt keine Konten angeboten', !(await w2.webContents.executeJavaScript("!!document.querySelector('webline-autofill')")));
  // "Nie für diese Seite"
  answer = 2;
  await w2.webContents.executeJavaScript("document.getElementById('user').value = 'x'; document.getElementById('pw').value = 'y'; document.getElementById('go').click()", true);
  await waitFor(async () => /eingeloggt/.test(w2.webContents.getURL()) && !w2.webContents.isLoading(), 6000);
  await sleep(400);
  const nAsked = asked.length;
  w2.webContents.loadURL(`http://andere.test:${port}/login`);
  await waitFor(async () => /login/.test(w2.webContents.getURL()) && !w2.webContents.isLoading(), 6000);
  await w2.webContents.executeJavaScript("document.getElementById('user').value = 'x2'; document.getElementById('pw').value = 'y2'; document.getElementById('go').click()", true);
  await waitFor(async () => /eingeloggt/.test(w2.webContents.getURL()) && !w2.webContents.isLoading(), 6000);
  await sleep(400);
  st = await run('window.launcher.passwords.get()');
  check('"Nie für diese Seite" wird gemerkt', asked.length === nAsked && st.never.length === 1 && st.entries.length === 1, `${asked.length - nAsked} neue Fragen, ${st.never.length} nie`);
  w2.close();

  // Einstellungen: Liste und Schalter
  await run(`document.getElementById('settings-btn').click()`);
  const rows = await waitFor(() => run(`document.querySelectorAll('#password-list .pw-row').length`), 3000);
  check('Einstellungen zeigen gespeicherte und "nie"-Seiten', rows === 2, `${rows} Zeilen`);
  if (shotDir) {
    await run(`window.launcher.setSettings({ language: 'de' })`);
    await sleep(400);
    await run(`document.querySelector('#settings-modal').scrollTop = 0; document.querySelector('#password-list').scrollIntoView({ block: 'center' })`);
    await sleep(300);
    await shot(launcher, 'website-passwoerter.png');
    await run(`window.launcher.setSettings({ language: 'en' })`);
  }
  await run(`document.getElementById('settings-modal').close()`);
  await run(`window.launcher.setSettings({ autofill: false })`);
  await back();
  await login('zweiter', 'abc');
  check('Ausgeschaltet: keine Frage mehr', asked.length === nAsked, `${asked.length - nAsked}`);
  await run(`window.launcher.setSettings({ autofill: true })`);
  // Löschen
  const id = (await run('window.launcher.passwords.get()')).entries[0].id;
  st = await run(`window.launcher.passwords.remove('${id}')`);
  check('Löschen in den Einstellungen', st.entries.length === 0);
  await back();
  await clickOn(wc, '#user');
  await sleep(700);
  check('Gelöscht: keine Auswahl mehr', !(await wc.executeJavaScript("!!document.querySelector('webline-autofill')")));
  dialog.showMessageBox = realBox;
  w.close();
}

async function run(server, icons) {
  const port = server.address().port;
  const appIcons = require('../src/appicons');
  icons.favicon = appIcons.toIco(solid(256, BLUE).resize({ width: 48, height: 48 }).resize({ width: 256, height: 256 }));
  // Test-Verschlüsselung statt Schlüsselbund (Linux-CI hat keinen, macOS würde nachfragen)
  const pw = require('../src/passwords');
  console.log(`INFO echter Schlüsselspeicher verfügbar: ${(() => { try { return pw.systemCrypto.available(); } catch { return false; } })()}`);
  const xor = (buf) => Buffer.from(buf).map((b, i) => b ^ (0x5a + i) & 0xff);
  Object.assign(pw.systemCrypto, { available: () => true, encrypt: (text) => xor(Buffer.from(text, 'utf8')), decrypt: (buf) => xor(buf).toString('utf8') });
  require('../src/main.js');
  // main.js hängt sich an app.whenReady() - das ist schon durch, läuft also gleich los
  try {
    const launcher = await waitFor(() => BrowserWindow.getAllWindows().find((w) => /renderer[\\/]index\.html/.test(w.webContents.getURL())));
    check('Launcher geladen', !!launcher);
    await waitFor(async () => !launcher.webContents.isLoading());
    const run = (js) => launcher.webContents.executeJavaScript(js);
    const state = () => run('window.launcher.getState()');

    const bad = await run(`window.launcher.addUrl('kein link')`);
    check('Ungültige Adresse abgelehnt', bad && bad.ok === false);

    const res = await run(`window.launcher.addUrl('http://127.0.0.1:${port}/hilfe')`);
    check('Webseite hinzugefügt', res && res.ok, JSON.stringify(res));
    const st = await state();
    const item = st.items.find((i) => i.id === res.id);
    check('Eintrag ist Web mit Seitentitel', item && item.kind === 'web' && item.name === 'Hilfe-Test', item && `${item.kind} / ${item.name}`);
    const dup = await run(`window.launcher.addUrl('127.0.0.1:${port}/hilfe')`);
    check('Doppelt wird erkannt (ohne http://)', dup && dup.id === res.id);
    await sleep(600);
    const cards = await run("document.querySelectorAll('.card').length");
    check('Karte erscheint im Launcher', cards === 1, `${cards} Karte(n)`);

    let shortcutFile = null;
    if (process.platform === 'win32' || process.platform === 'linux') {
      const made = await run(`window.launcher.shortcut('${res.id}')`);
      const files = fs.readdirSync(fakeDesktop);
      shortcutFile = files[0] && path.join(fakeDesktop, files[0]);
      check('Desktop-Verknüpfung erstellt', made === true && files.length === 1, files.join(', '));
      if (process.platform === 'win32' && shortcutFile) {
        const link = shell.readShortcutLink(shortcutFile);
        check('Verknüpfung startet Webline mit der Adresse', /127\.0\.0\.1/.test(link.args), `${link.target} ${link.args}`);
      }
    }

    // ------------------------------------------------------------ eigenes Symbol
    const siteIcon = await run(`window.launcher.icon('${res.id}', 'site')`);
    check('Symbol der Webseite übernommen (link rel=icon 192 px)', siteIcon && siteIcon.ok, JSON.stringify(siteIcon));
    const png = siteIcon?.icon;
    const pngImg = png && nativeImage.createFromPath(png);
    check('PNG liegt in userData/icons, 256 px, richtiges Bild', pngImg && !pngImg.isEmpty() && path.dirname(png) === path.join(tmp, 'icons')
      && pngImg.getSize().width === 256 && near(center(pngImg), RED), pngImg && `${JSON.stringify(pngImg.getSize())} ${center(pngImg)}`);
    const icoFile = png && appIcons.icoOf(png);
    const ico = icoFile && fs.existsSync(icoFile) && appIcons.readIco(fs.readFileSync(icoFile));
    const icoOk = ico && ico.length >= 5 && ico.some((e) => e.width === 16) && ico.some((e) => e.width === 256)
      && ico.every((e) => { const im = nativeImage.createFromBuffer(e.png); return !im.isEmpty() && im.getSize().width === e.width && near(center(im), RED); });
    check('ICO-Datei gültig (16 bis 256 px, jede Größe lesbar)', icoOk, ico ? ico.map((e) => e.width).join('/') : 'fehlt');
    await sleep(400);
    const tileImg = await run(`(() => { const i = document.querySelector('.card .tile-img'); return i && i.complete && i.naturalWidth; })()`);
    check('Kachel zeigt das Symbol', tileImg > 0, String(tileImg));
    if (shortcutFile && process.platform === 'linux') {
      const body = fs.readFileSync(shortcutFile, 'utf8');
      check('Vorhandene Verknüpfung bekommt das neue Symbol (.desktop)', body.includes(`Icon=${png}`), /Icon=.*/.exec(body)?.[0]);
    }
    if (shortcutFile && process.platform === 'win32') {
      const link = shell.readShortcutLink(shortcutFile);
      check('Vorhandene Verknüpfung zeigt das ICO', path.resolve(link.icon || '') === path.resolve(icoFile), link.icon);
    }

    // Seite ohne <link rel=icon>: /favicon.ico (ICO mit PNG darin)
    const plain = await run(`window.launcher.addUrl('http://127.0.0.1:${port}/plain')`);
    const plainIcon = await run(`window.launcher.icon('${plain.id}', 'site')`);
    const plainImg = plainIcon?.icon && nativeImage.createFromPath(plainIcon.icon);
    check('Ohne Symbol-Link: /favicon.ico wird genommen', plainImg && !plainImg.isEmpty() && near(center(plainImg), BLUE), plainImg && String(center(plainImg)));

    // Bild auswählen: der Dateidialog wird ersetzt
    const svgFile = path.join(tmp, 'symbol.svg');
    fs.writeFileSync(svgFile, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" rx="4" fill="rgb(${PURPLE.join(',')})"/></svg>`);
    const realDialog = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [svgFile] });
    const fileIcon = await run(`window.launcher.icon('${plain.id}', 'pick')`);
    const fileImg = fileIcon?.icon && nativeImage.createFromPath(fileIcon.icon);
    const corner = fileImg && fileImg.toBitmap()[3]; // Alpha oben links: nicht-quadratisch -> transparent aufgefüllt
    check('Datei-Symbol (SVG, nicht quadratisch) übernommen', fileImg && near(center(fileImg), PURPLE) && fileImg.getSize().width === 256 && corner === 0,
      fileImg && `${center(fileImg)} alpha=${corner}`);
    const oldFiles = fs.readdirSync(path.join(tmp, 'icons')).filter((f) => f.startsWith(plain.id));
    check('Altes Symbol wird aufgeräumt', oldFiles.length === 2, oldFiles.join(', '));
    const junk = path.join(tmp, 'kaputt.png');
    fs.writeFileSync(junk, 'das ist kein bild');
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [junk] });
    const badIcon = await run(`window.launcher.icon('${plain.id}', 'pick')`);
    check('Unlesbares Bild wird abgelehnt', badIcon && badIcon.ok === false && badIcon.error === 'unreadable');
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    const canceled = await run(`window.launcher.icon('${plain.id}', 'pick')`);
    check('Abbrechen ändert nichts', canceled && canceled.ok === false && (await state()).items.find((i) => i.id === plain.id).icon === fileIcon.icon);
    dialog.showOpenDialog = realDialog;
    await run(`window.launcher.icon('${plain.id}', 'reset')`);
    const afterReset = (await state()).items.find((i) => i.id === plain.id);
    const leftover = fs.readdirSync(path.join(tmp, 'icons')).filter((f) => f.startsWith(plain.id));
    check('Zurück zum Standard entfernt Symbol und Dateien', !afterReset.icon && !afterReset.iconData && leftover.length === 0, leftover.join(', '));
    await run(`window.launcher.remove('${plain.id}')`);
    await run(`window.launcher.icon('${res.id}', 'site')`); // für den Screenshot ein Symbol mehr
    await sleep(400);
    launcher.webContents.invalidate();
    await shot(launcher, 'launcher.png');

    // ------------------------------------------------------------ Programmfenster
    await run(`window.launcher.launch('${res.id}')`);
    const prog = await waitFor(() => programWindows(launcher).find((w) => /127\.0\.0\.1/.test(w.webContents.getURL())));
    check('Programmfenster öffnet die Seite', !!prog, prog && prog.webContents.getURL());
    await waitFor(async () => prog && !prog.webContents.isLoading());
    await shot(prog, 'programm.png');
    // macOS hat die globale Menüleiste (isMenuBarVisible ist dort immer true)
    if (process.platform !== 'darwin') check('Kein Adressleisten-Menü', prog && !prog.isMenuBarVisible());

    // Link auf derselben Seite bleibt im Fenster
    await prog.webContents.executeJavaScript("document.getElementById('l').click()", true);
    const nav = await waitFor(async () => /seite2/.test(prog.webContents.getURL()) && !prog.webContents.isLoading(), 5000);
    await sleep(500);
    check('Link auf derselben Seite bleibt im Fenster', !!nav && /seite2/.test(prog.webContents.getURL()), prog.webContents.getURL());
    // Zurück (Alt+←) und Maus-Zurück
    backKey(prog.webContents);
    const back = await waitFor(async () => /\/hilfe$/.test(prog.webContents.getURL()) && !prog.webContents.isLoading(), 5000);
    check('Zurück-Taste (Alt+← / ⌘+[) geht zurück', !!back, prog.webContents.getURL());
    prog.webContents.navigationHistory.goForward();
    await waitFor(async () => /seite2/.test(prog.webContents.getURL()) && !prog.webContents.isLoading(), 5000);
    prog.emit('app-command', {}, 'browser-backward');
    const mouseBack = await waitFor(async () => /\/hilfe$/.test(prog.webContents.getURL()) && !prog.webContents.isLoading(), 5000);
    check('Maus-Zurück geht zurück', !!mouseBack, prog.webContents.getURL());

    // ------------------------------------------------------------ Scroll-Seite, Weiterleitung, fremde Links
    const snap = await run(`window.launcher.addUrl('http://webline.test:${port}/start')`);
    check('Scroll-Seite hinzugefügt', snap && snap.ok, JSON.stringify(snap));
    await run(`window.launcher.launch('${snap.id}')`);
    const sw = await waitFor(() => programWindows(launcher).find((w) => /webline\.test/.test(w.webContents.getURL())));
    const landed = await waitFor(async () => sw && /www\.webline\.test:\d+\/snap$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 8000);
    await sleep(800);
    check('Weiterleitung auf andere Origin (ohne www -> www) bleibt im Fenster', !!landed && external.length === 0, `${sw && sw.webContents.getURL()} extern: ${external.join(', ')}`);
    const area = screen.getDisplayMatching(sw.getBounds()).workArea;
    const m = await sw.webContents.executeJavaScript('({ first: window.__first, now: { h: innerHeight, w: innerWidth }, resizes: window.__resizes })');
    const content = sw.getContentBounds();
    check('Fensterhöhe beim ersten Laden = endgültige Höhe (kein Nachträgliches Vergrößern)',
      m.first.h === m.now.h && m.first.w === m.now.w && m.resizes === 0, JSON.stringify(m));
    check('und entspricht dem Arbeitsbereich', Math.abs(m.first.h - content.height) <= 2 && m.first.h >= area.height - 120 && m.first.w >= area.width - 40,
      `innerHeight ${m.first.h}, Inhalt ${content.height}, Arbeitsbereich ${area.width}x${area.height}`);

    // zu Abschnitt 2 scrollen, fremden Link klicken: Browser bekommt ihn, Fenster bleibt bei Abschnitt 2
    await sw.webContents.executeJavaScript("document.getElementById('b').scrollIntoView(); new Promise(r => setTimeout(r, 300))");
    const y0 = await sw.webContents.executeJavaScript('scrollY');
    await sw.webContents.executeJavaScript("document.getElementById('fremd').click()", true);
    await waitFor(async () => external.length > 0, 6000);
    await waitFor(async () => /\/snap$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 6000);
    await sleep(800);
    const y1 = await sw.webContents.executeJavaScript('scrollY');
    check('Fremde Seite geht in den Browser', external.length === 1 && /fremd\.test.*\/fremd$/.test(external[0]), external.join(', '));
    check('Fenster bleibt, wo man war (Scroll-Position)', /\/snap$/.test(sw.webContents.getURL()) && Math.abs(y1 - y0) < 4 && y0 > 100, `${sw.webContents.getURL()} y ${y0} -> ${y1}`);
    await shot(sw, 'scroll-seite.png');

    // ------------------------------------------------------------ F6: Adresse vorübergehend ändern
    key(sw.webContents, 'F6');
    const bar = await waitFor(() => urlbarContents(), 5000);
    check('F6 öffnet das Eingabefeld', !!bar);
    await waitFor(async () => bar && !bar.isLoading() && (await bar.executeJavaScript("document.getElementById('url').value")) !== '', 5000);
    const shown = bar && (await bar.executeJavaScript("({ v: document.getElementById('url').value, t: document.getElementById('title').textContent, h: document.getElementById('hint').textContent })"));
    check('Eingabefeld zeigt die aktuelle Adresse', shown && /www\.webline\.test:\d+\/snap$/.test(shown.v) && shown.t && /Alt\+←|⌘\+\[/.test(shown.h), JSON.stringify(shown));
    if (bar) await shot(sw, 'f6.png', bar);
    // Esc schließt ohne etwas zu tun
    if (bar) key(bar, 'Escape');
    const closed = await waitFor(() => !urlbarContents(), 4000);
    check('Esc schließt das Eingabefeld', !!closed && /\/snap$/.test(sw.webContents.getURL()));
    // nochmal F6, eine fremde Seite eintippen
    key(sw.webContents, 'F6');
    const bar2 = await waitFor(() => urlbarContents(), 5000);
    await waitFor(async () => bar2 && !bar2.isLoading() && (await bar2.executeJavaScript("document.getElementById('url').value")) !== '', 5000);
    const before = external.length;
    await bar2.executeJavaScript(`document.getElementById('url').value = 'http://fremd.test:${port}/f6'; document.getElementById('box').requestSubmit()`);
    const f6 = await waitFor(async () => /fremd\.test:\d+\/f6$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 6000);
    check('F6-Adresse (andere Seite) öffnet im Fenster', !!f6 && external.length === before && !urlbarContents(), sw.webContents.getURL());
    await sw.webContents.executeJavaScript("document.getElementById('weiter').click()", true);
    const f6b = await waitFor(async () => /fremd\.test:\d+\/f6b$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 6000);
    check('Links auf der F6-Seite bleiben im Fenster', !!f6b && external.length === before, sw.webContents.getURL());
    const saved = (await state()).items.find((i) => i.id === snap.id);
    check('Gespeicherte Adresse bleibt unverändert', saved && /^http:\/\/webline\.test:\d+\/start$/.test(saved.url), saved && saved.url);
    backKey(sw.webContents);
    await waitFor(async () => /\/f6$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 5000);
    backKey(sw.webContents);
    const home = await waitFor(async () => /\/snap$/.test(sw.webContents.getURL()) && !sw.webContents.isLoading(), 5000);
    check('Zurück führt zur Programm-Adresse', !!home, sw.webContents.getURL());

    // ------------------------------------------------------------ Passwort-Autofill
    await passwordTests(launcher, run, port);

    // ------------------------------------------------------------ Schleifenschutz
    const loop = await run(`window.launcher.addUrl('http://loop.test:${port}/schleife')`);
    const ext0 = external.length;
    await run(`window.launcher.launch('${loop.id}')`);
    await sleep(3500);
    const loopWin = programWindows(launcher).find((w) => /loop\.test|ziel\.test/.test(w.webContents.getURL()));
    check('Seite, die per Skript immer wieder wegleitet: höchstens ein Browser-Tab', !!loopWin && external.length - ext0 <= 1, `${external.length - ext0} Tab(s), Fenster: ${loopWin && loopWin.webContents.getURL()}`);

    // Start wie aus einer Desktop-Verknüpfung: Webline wird mit einer Adresse aufgerufen
    const count = (await state()).items.length;
    const nWin = programWindows(launcher).length;
    app.emit('second-instance', {}, [process.execPath, 'tools/test-web.js', `http://127.0.0.1:${port}/seite2?direkt`]);
    const direct = await waitFor(() => programWindows(launcher).find((w) => /direkt/.test(w.webContents.getURL())), 8000);
    check('Start mit Adresse öffnet das Programm direkt', !!direct && programWindows(launcher).length > nWin);
    check('und legt es in der Liste an', (await state()).items.length === count + 1, `${(await state()).items.length} Einträge`);

    // Programm entfernen räumt sein Symbol weg
    await run(`window.launcher.remove('${res.id}')`);
    const rest = fs.readdirSync(path.join(tmp, 'icons')).filter((f) => f.startsWith(res.id));
    check('Entfernen löscht das Symbol', rest.length === 0, rest.join(', '));

    if (shotDir) await websiteShots(launcher, run, port, sw);
  } catch (e) {
    check('Ablauf', false, String((e && e.stack) || e));
  }
  const ok = results.every(Boolean);
  console.log(ok ? 'ALLES OK' : 'FEHLER');
  server.close();
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  app.exit(ok ? 0 : 1);
}
