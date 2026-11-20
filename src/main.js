'use strict';

const { app, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, nativeTheme, shell, nativeImage, screen } = require('electron');
const fileIcons = require('./fileicons');
const appIcons = require('./appicons');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Library, isSupportedFile, fileKind, idFor, EXTENSIONS, normalizeUrl, nameForUrl, titleFromHtml, isWebItem, webId } = require('./store');
const { Downloads } = require('./downloads');
const { DownloadManager } = require('./download-manager');
const { Settings } = require('./settings');
const { Passwords } = require('./passwords');
const i18n = require('./i18n');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const LAUNCHER_PAGE = path.join(__dirname, 'renderer', 'index.html');
const VIEWER_PAGE = path.join(__dirname, 'viewer', 'viewer.html');
const VIEWER_PRELOAD = path.join(__dirname, 'viewer', 'viewer-preload.js');
const URLBAR_PAGE = path.join(__dirname, 'urlbar', 'urlbar.html');
const URLBAR_PRELOAD = path.join(__dirname, 'urlbar', 'preload.js');
const AUTOFILL_PRELOAD = path.join(__dirname, 'autofill', 'preload.js');
const TEXT_LIMIT = 25 * 1024 * 1024; // größere Textdateien werden gekürzt angezeigt

let library;
let downloads;
let downloadManager;
let settings;
let passwords;
let t = i18n.make('en');  // Übersetzer für die gewählte Sprache

// Webline hieß bis Version 1.8 "Webcase": Einstellungen, Bibliothek und Downloads aus dem alten Ordner übernehmen
(() => {
  const oldDir = path.join(app.getPath('appData'), 'Webcase');
  const newDir = app.getPath('userData');
  if (oldDir === newDir || fs.existsSync(newDir) || !fs.existsSync(oldDir)) return;
  try {
    fs.renameSync(oldDir, newDir);
  } catch {
    app.setPath('userData', oldDir);  // z. B. läuft noch die alte Version: dann einfach dort weiterarbeiten
  }
})();
const isMac = process.platform === 'darwin';
let launcherWin = null;
const programWins = new Map(); // id -> BrowserWindow
const launching = new Set(); // ids, die gerade starten (gegen Doppelklick)

// ---------------------------------------------------------------- Zustand

async function exists(file) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function getState() {
  const items = await Promise.all(
    library.items.map(async (item) =>
      isWebItem(item)
        ? { ...item, kind: 'web', missing: false, iconData: iconDataUrl(item) }
        : { ...item, kind: fileKind(item.path), missing: !(await exists(item.path)), iconData: iconDataUrl(item) }
    )
  );
  return { items, running: [...programWins.keys()] };
}

function send(channel, payload) {
  if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send(channel, payload);
}

async function broadcast() {
  if (launcherWin && !launcherWin.isDestroyed()) send('state:changed', await getState());
}

async function getDownloadsState() {
  const items = await Promise.all(
    downloads.items.map(async (entry) => {
      const item = downloadManager.describe(entry);
      // Während des Downloads existiert die Datei noch nicht unter ihrem Namen
      return { ...item, missing: item.active ? false : item.path ? !(await exists(item.path)) : true };
    })
  );
  return { items };
}

function broadcastDownloads() {
  getDownloadsState().then((state) => send('downloads:changed', state));
}

function toast(message, kind = 'info') {
  send('toast', { message, kind });
}

/** Wie toast(), aber wartet bei einem frisch geöffneten Fenster, bis dessen Seite geladen
 *  ist (und die Renderer-Skripte den 'toast'-Kanal abhören) - sonst geht die Meldung verloren. */
async function notify(message, kind) {
  if (!launcherWin || launcherWin.isDestroyed()) return;
  if (launcherWin.webContents.isLoading()) {
    await new Promise((resolve) => launcherWin.webContents.once('did-finish-load', resolve));
  }
  toast(message, kind);
}

// ---------------------------------------------------------------- Hinzufügen

async function addPaths(paths) {
  const valid = [];
  let rejected = 0;
  for (const file of paths) {
    if (await isSupportedFile(file)) valid.push(file);
    else rejected++;
  }
  const { added, duplicates } = await library.add(valid);

  const parts = [];
  if (added) parts.push(added === 1 ? t('addedOne') : t('addedMany', { n: added }));
  if (duplicates) parts.push(t('alreadyThere', { n: duplicates }));
  if (rejected) parts.push(t('notSupported', { n: rejected }));
  if (parts.length) toast(parts.join(' · '), added ? 'ok' : 'warn');

  await broadcast();
}

// ---------------------------------------------------------------- Web-Programme

/** <title> der Seite holen (höchstens ein paar Sekunden, sonst Adresse als Name) */
async function fetchTitle(url) {
  const { net } = require('electron');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') ?? 'text/html')) return '';
    const reader = res.body?.getReader();
    if (!reader) return titleFromHtml(await res.text());
    let text = '';
    while (text.length < 65536) {
      const { done, value } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
      if (/<\/title>/i.test(text)) break;
    }
    reader.cancel().catch(() => {});
    return titleFromHtml(text);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/** Adresse hinzufügen; liefert { ok, id } */
async function addUrl(input, { quiet = false } = {}) {
  const url = normalizeUrl(input);
  if (!url) {
    if (!quiet) toast(t('invalidUrl'), 'warn');
    return { ok: false };
  }
  const known = library.find(webId(url));
  if (known) {
    if (!quiet) toast(t('alreadyThere', { n: 1 }), 'warn');
    return { ok: true, id: known.id };
  }
  const name = (await fetchTitle(url)) || nameForUrl(url);
  const { id } = library.addUrl(url, name);
  if (!quiet) toast(t('addedOne'), 'ok');
  await broadcast();
  return { ok: true, id };
}

// ---------------------------------------------------------------- Eigene Symbole

const iconDir = () => path.join(app.getPath('userData'), 'icons');

/** Eigenes Symbol, falls gesetzt und noch vorhanden (PNG-Pfad), sonst null */
function customIcon(item) {
  return item?.icon && fs.existsSync(item.icon) ? item.icon : null;
}

/** Fenster-Symbol: unter Windows das ICO (mehrere Größen für Taskleiste und Alt+Tab) */
function windowIcon(item) {
  const png = customIcon(item);
  if (!png) return ICON;
  const ico = appIcons.icoOf(png);
  return process.platform === 'win32' && fs.existsSync(ico) ? ico : png;
}

const iconCache = new Map(); // PNG-Pfad -> data:-URL für die Kachel
function iconDataUrl(item) {
  const png = customIcon(item);
  if (!png) return null;
  if (!iconCache.has(png)) {
    const img = nativeImage.createFromPath(png);
    iconCache.set(png, img.isEmpty() ? null : img.resize({ width: 112, height: 112, quality: 'best' }).toDataURL());
  }
  return iconCache.get(png);
}

/** Symbol setzen: mode = 'pick' (Bild auswählen), 'site' (Symbol der Webseite), 'reset' (Standard) */
async function changeIcon(id, mode) {
  const item = library.find(id);
  if (!item) return { ok: false };
  if (mode === 'reset') {
    library.setIcon(id, null);
    await appIcons.removeFiles(iconDir(), id);
    await afterIconChange(item);
    return { ok: true };
  }
  let img = null;
  if (mode === 'site') {
    if (!isWebItem(item)) return { ok: false };
    img = await appIcons.fetchSiteIcon(item.url).catch(() => null);
    if (!img) {
      toast(t('iconSiteMissing'), 'warn');
      return { ok: false, error: 'missing' };
    }
  } else {
    const res = await dialog.showOpenDialog(launcherWin, {
      title: t('chooseIcon'),
      properties: ['openFile'],
      filters: [{ name: t('images'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'ico', 'svg'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    img = await appIcons.fromFile(res.filePaths[0]).catch(() => null);
    if (!img) {
      toast(t('iconUnreadable'), 'warn');
      return { ok: false, error: 'unreadable' };
    }
  }
  const png = await appIcons.store(iconDir(), id, img);
  library.setIcon(id, png);
  await afterIconChange(item);
  toast(t('iconChanged'), 'ok');
  return { ok: true, icon: png };
}

/** Neues Symbol überall zeigen: Kachel, offenes Fenster, vorhandene Desktop-Verknüpfung */
async function afterIconChange(item) {
  iconCache.clear();
  const win = programWins.get(item.id);
  if (win && !win.isDestroyed() && process.platform !== 'darwin') win.setIcon(windowIcon(item));
  if (isWebItem(item)) await refreshShortcut(item).catch(() => {});
  await broadcast();
}

/** Name und Pfad der Desktop-Verknüpfung eines Web-Programms */
function shortcutFile(item) {
  const safe = item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Webline';
  const ext = process.platform === 'win32' ? '.lnk' : '.desktop';
  return { safe, file: path.join(app.getPath('desktop'), `${safe}${ext}`) };
}

/** Desktop-Verknüpfung, die das Web-Programm direkt startet (wie Doppelklick auf eine HTML-Datei) */
async function createShortcut(item) {
  const { safe, file } = shortcutFile(item);
  if (process.platform === 'win32') {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const png = customIcon(item);
    const ico = png && appIcons.icoOf(png);
    return shell.writeShortcutLink(file, {
      target,
      args: process.defaultApp ? `"${path.resolve(process.argv[1] ?? '.')}" "${item.url}"` : `"${item.url}"`,
      description: item.url,
      icon: ico && fs.existsSync(ico) ? ico : target,
      iconIndex: 0,
    });
  }
  if (process.platform === 'linux') {
    const exec = process.env.APPIMAGE || process.execPath;
    const args = process.defaultApp ? ` "${path.resolve(process.argv[1] ?? '.')}"` : '';
    const body = `[Desktop Entry]\nType=Application\nName=${safe}\nComment=${item.url}\nExec="${exec}"${args} "${item.url}"\nIcon=${customIcon(item) || 'webline'}\nTerminal=false\n`;
    await fs.promises.writeFile(file, body, { mode: 0o755 });
    return true;
  }
  return false;
}

/** Gibt es schon eine Verknüpfung für dieses Programm, bekommt sie das neue Symbol */
async function refreshShortcut(item) {
  const { file } = shortcutFile(item);
  if (!fs.existsSync(file)) return false;
  if (process.platform === 'win32') {
    let link;
    try {
      link = shell.readShortcutLink(file);
    } catch {
      return false;
    }
    if (!String(link.args ?? '').includes(item.url)) return false;
  } else if (process.platform === 'linux') {
    if (!(await fs.promises.readFile(file, 'utf8')).includes(`"${item.url}"`)) return false;
  } else return false;
  return createShortcut(item);
}

/** Dateien aus Kommandozeilenargumenten (z. B. "Öffnen mit" oder Drag & Drop auf die .exe). */
function htmlArgs(argv) {
  const args = process.defaultApp ? argv.slice(2) : argv.slice(1);
  return args.filter((a) => !a.startsWith('-'));
}

/**
 * Wird die App mit HTML-Dateien aufgerufen (Doppelklick, "Öffnen mit", Datei auf die
 * .exe gezogen), sollen sie sich wie eigene Programme verhalten: sofort im eigenen
 * Fenster, ohne den Umweg über das Menü. Das Menü kommt nur, wenn etwas nicht klappt.
 */
async function launchArgs(files) {
  // Web-Adressen (z. B. aus einer Desktop-Verknüpfung) starten genauso direkt wie Dateien
  const urls = files.filter((f) => /^https?:\/\//i.test(f));
  files = files.filter((f) => !/^https?:\/\//i.test(f));
  const webErrors = [];
  for (const u of urls) {
    const res = await addUrl(u, { quiet: true });
    if (!res.ok) webErrors.push(t('invalidUrl'));
    else {
      const r = await launch(res.id);
      if (!r.ok) webErrors.push(r.error);
    }
  }
  if (urls.length && !files.length) {
    if (webErrors.length) {
      showLauncher();
      for (const message of webErrors) await notify(message, 'error');
    }
    return;
  }
  const valid = [];
  for (const file of files) if (await isSupportedFile(file)) valid.push(file);

  if (!valid.length) {
    showLauncher();
    if (files.length) await notify(t('notSupportedFile'), 'warn');
    return;
  }

  const errors = [];
  for (const file of valid) {
    await library.add([file]);
    const result = await launch(idFor(path.resolve(file)));
    if (!result.ok) errors.push(result.error);
  }
  // Fehler erst melden, sobald das Menü (als Fallback) sichtbar und geladen ist.
  if (errors.length) {
    showLauncher();
    for (const message of errors) await notify(message, 'error');
  }
}

// ---------------------------------------------------------------- Programme starten

async function launch(id) {
  const item = library.find(id);
  if (!item) return { ok: false, error: t('entryNotFound') };

  const open = programWins.get(id);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.focus();
    return { ok: true };
  }
  if (launching.has(id)) return { ok: true };
  launching.add(id);

  try {
    const web = isWebItem(item);
    if (!web && !(await exists(item.path))) {
      await broadcast();
      return { ok: false, error: t('fileNotFound') };
    }

    // PDF: eingebauter Chromium-Viewer (Blättern, Zoom, Suchen, Drucken). Bilder, Videos und Musik zeigt Chromium
    // selbst an. Text, Markdown, JSON und CSV laufen über den eigenen Betrachter (viewer/).
    const kind = web ? 'web' : fileKind(item.path) ?? 'html';
    // Das Fenster hat schon beim ersten Laden seine endgültige Größe: es wird in Arbeitsbereich-Größe angelegt
    // und gleich maximiert (siehe unten), BEVOR die Seite lädt. Vorher startete es klein, wurde erst nach dem
    // ersten Bild maximiert - Seiten, die beim Laden ihre Höhe messen (100vh-Abschnitte, Scroll-Snap,
    // Scroll-Animationen), rechneten dann mit der falschen Höhe und scrollten verschoben.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const win = new BrowserWindow({
      title: item.name,
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      // Startet maximiert statt im echten Vollbild - fühlt sich wie ein normales
      // Programmfenster an. Vollbild bleibt über F11 einen Tastendruck entfernt.
      show: false,
      paintWhenInitiallyHidden: false,
      backgroundColor: web ? '#ffffff' : '#000000',
      autoHideMenuBar: true,
      icon: windowIcon(item),
      webPreferences: {
        // Jedes Programm hat seinen eigenen, dauerhaften Speicherbereich,
        // sonst würden sich alle file://-Seiten localStorage & Co. teilen.
        partition: `persist:app-${item.id}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        plugins: kind === 'pdf' || web,
        // Web-Programme: Passwort-Autofill (läuft isoliert von der Seite, siehe autofill/preload.js)
        preload: kind === 'text' ? VIEWER_PRELOAD : web ? AUTOFILL_PRELOAD : undefined,
      },
    });
    win.removeMenu();
    programWins.set(id, win);
    win.weblineItem = item.id;
    library.touch(id);

    // Sofort maximiert zeigen (mit der Hintergrundfarbe, bis das erste Bild der Seite da ist) - wie ein Browser.
    win.maximize();
    win.show();
    win.on('closed', () => {
      programWins.delete(id);
      broadcast();
      if (programWins.size === 0 && launcherWin && !launcherWin.isDestroyed()) {
        launcherWin.show();
        launcherWin.focus();
      }
    });

    const originalUrl = web ? item.url : kind === 'text' ? pathToFileURL(VIEWER_PAGE).href : pathToFileURL(item.path).href;
    attachProgramBehavior(win, originalUrl, item.id, web);
    if (web) {
      // Seite nicht erreichbar (offline, falsche Adresse): einfache Meldung statt weißer Fläche
      win.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
        if (!isMainFrame || code === -3) return; // -3 = abgebrochen (z. B. Download)
        const html = `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:40px;color:#333">`
          + `<h2>${t('webUnreachable')}</h2><p>${String(failedUrl).replace(/[<>&"]/g, '')}</p><p style="color:#888">${String(desc).replace(/[<>&"]/g, '')}</p>`
          + `<p><button onclick="location.href='${String(originalUrl).replace(/['<>&"\\]/g, '')}'">${t('retry')}</button></p></body>`;
        win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      });
    }
    win.loadURL(originalUrl);
    await broadcast();
    return { ok: true };
  } finally {
    launching.delete(id);
  }
}

// Geteilte Hosting-Domains: dort ist erst die Subdomain "die Seite" (nutzer.github.io ≠ anderer.github.io)
const SHARED_HOSTS = /(^|\.)(github\.io|gitlab\.io|pages\.dev|workers\.dev|vercel\.app|netlify\.app|web\.app|firebaseapp\.com|herokuapp\.com|onrender\.com|fly\.dev|glitch\.me|surge\.sh|blogspot\.com|wordpress\.com|neocities\.org|itch\.io|azurewebsites\.net|cloudfront\.net|ngrok\.io|ngrok-free\.app)$/;
const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne|go|gv|ltd|plc|nhs|sch|mil|gob|nic)$/;

/**
 * "Seite" einer Adresse: die Domain ohne www und Subdomains (mert.win, www.mert.win, help.mert.win -> mert.win;
 * example.co.uk bleibt zusammen). http/https zählen gleich. IP-Adressen und localhost genau mit Port.
 */
function siteOf(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.startsWith('[')) return `${host}:${url.port}`;
  const parts = host.split('.');
  let n = parts.length >= 3 && parts.at(-1).length === 2 && SECOND_LEVEL.test(parts.at(-2)) ? 3 : 2;
  const shared = SHARED_HOSTS.exec(host);
  if (shared) n = shared[2].split('.').length + 1;
  return parts.slice(-Math.min(n, parts.length)).join('.');
}

function attachProgramBehavior(win, originalUrl, programId, web = false) {
  const { webContents } = win;
  // Web-Programme: die eigene Seite bleibt im Fenster - mit und ohne www, auf Subdomains und wohin sie beim
  // ersten Laden umleitet. Fremde Seiten öffnen im Browser, wie bei HTML-Dateien.
  const sites = new Set();
  if (web) sites.add(siteOf(originalUrl));
  // Mit F6 vorübergehend geöffnete Adressen (gelten nur in diesem Fenster, bis es zu ist)
  const tempSites = new Set();
  const isOwn = (u) => {
    if (/^data:/i.test(u)) return web;
    const site = siteOf(u);
    return !!site && ((web && sites.has(site)) || tempSites.has(site));
  };
  let firstLoad = web;
  const bounced = new Map(); // Seite -> Zeitpunkt, zu dem sie zuletzt in den Browser geschickt wurde

  // Links ins Web öffnen im Standardbrowser statt das "Programm" zu ersetzen.
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) webContents.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });

  // will-navigate wird bewusst NICHT blockiert: Ein Klick, der am Ende eine Datei herunterlädt
  // (Content-Disposition:attachment), löst dieses Ereignis zwar aus, "navigiert" aber nie wirklich - die Seite
  // bleibt stehen und will-download (siehe unten) übernimmt. Erst wenn die Navigation tatsächlich committet
  // (did-navigate mit einer fremden http(s)-Adresse: es war also doch eine echte Seite), geht sie in den Browser
  // und das Fenster einen Schritt zurück - dorthin, wo man war, samt Scroll-Position (früher wurde die
  // Startadresse neu geladen: man landete wieder oben auf der Startseite).
  webContents.on('did-navigate', (_event, url) => {
    if (firstLoad && /^https?:\/\//i.test(url)) {
      firstLoad = false;
      sites.add(siteOf(url));
    }
    if (!/^https?:\/\//i.test(url) || isOwn(url)) return;
    const site = siteOf(url);
    // Schleifenschutz: Leitet die Seite gleich wieder dorthin (z. B. per Skript beim Laden), bleibt das Ziel eben
    // im Fenster, statt immer neue Browser-Tabs zu öffnen und hin- und herzuspringen.
    if (Date.now() - (bounced.get(site) ?? 0) < 15000) {
      tempSites.add(site);
      return;
    }
    bounced.set(site, Date.now());
    openExternal(url);
    // Genau einen Eintrag zurück (goBack() würde Einträge ohne Nutzer-Klick überspringen) - erst nach diesem
    // Ereignis: direkt darin zurückzuspringen verwirft den gespeicherten Zustand der Seite (Scroll-Position).
    const history = webContents.navigationHistory;
    const index = history.getActiveIndex();
    setTimeout(() => {
      if (webContents.isDestroyed()) return;
      if (index > 0) history.goToIndex(index - 1);
      else webContents.loadURL(originalUrl);
    }, 30);
  });

  // Downloads laufen wie im Browser: direkt in den Downloads-Ordner, Blase mit Fortschritt
  // oben rechts im Fenster, Fortschritt in der Taskleiste. Siehe download-manager.js.
  downloadManager.wire(programId, webContents.session);
  downloadManager.prepare(programId);

  // Tastenkürzel aus den Einstellungen; Esc bleibt bewusst dem Programm überlassen (Pausemenüs usw.).
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = programShortcut(input);
    if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    else if (action === 'close') win.close();
    else if (action === 'reload') webContents.reload();
    else if (action === 'hardReload') webContents.reloadIgnoringCache();
    else if (action === 'devtools') webContents.toggleDevTools();
    else if (action === 'downloads') downloadManager.open(programId, 'toggle');
    else if (action === 'print') printProgram(win);
    else if (action === 'editUrl' && web) {
      editUrlTemporarily(win, originalUrl, (url) => {
        tempSites.add(siteOf(url));
        webContents.loadURL(url);
      });
    } else if (action === 'back' && webContents.navigationHistory.canGoBack()) webContents.navigationHistory.goBack();
    else return;
    event.preventDefault();
  });
  // Maus-Zurück/Vor (Windows/Linux) und Wischen (macOS) wie im Browser
  const history = webContents.navigationHistory;
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' && history.canGoBack()) history.goBack();
    else if (cmd === 'browser-forward' && history.canGoForward()) history.goForward();
  });
  win.on('swipe', (_e, direction) => {
    if (direction === 'right' && history.canGoBack()) history.goBack();
    else if (direction === 'left' && history.canGoForward()) history.goForward();
  });
}

/**
 * F6: Adresse dieses Fensters vorübergehend ändern (eine Unterseite oder auch eine ganz andere Seite).
 * Gilt nur in diesem Fenster, bis es geschlossen wird; Zurück (Alt+←, Maus-Zurück) führt wieder hin. Das
 * gespeicherte Programm behält seine Adresse. Das Eingabefeld ist eine eigene, abgeschottete Ansicht über der
 * Seite (wie die Download-Blase) - nicht in die Seite eingebaut, damit Inhaltsrichtlinien (CSP) oder Tasten-
 * abfragen der Seite (z. B. Spiele) es nicht stören können und die Seite es nicht auslesen kann.
 */
const urlbars = new Map(); // webContents-ID der Eingabe -> finish()

function editUrlTemporarily(win, originalUrl, onUrl) {
  if (win.isDestroyed()) return;
  if (win.weblineUrlbar) return win.weblineUrlbar(null); // F6 nochmal: schließen
  const view = new WebContentsView({
    webPreferences: { preload: URLBAR_PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  view.setBackgroundColor('#00000000');
  const wc = view.webContents;
  const layout = () => {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  let finished = false;
  const finish = (value) => {
    if (finished) return;
    finished = true;
    urlbars.delete(wc.id);
    win.weblineUrlbar = null;
    if (!win.isDestroyed()) {
      win.off('resize', layout);
      win.contentView.removeChildView(view);
      win.webContents.focus();
    }
    if (!wc.isDestroyed()) wc.close();
    if (value == null || win.isDestroyed()) return;
    const url = normalizeUrl(value);
    if (url) onUrl(url);
    else toast(t('invalidUrl'), 'warn');
  };
  win.weblineUrlbar = finish;
  urlbars.set(wc.id, finish);
  win.contentView.addChildView(view);
  layout();
  win.on('resize', layout);
  win.once('closed', () => finish(null));
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const action = programShortcut(input);
    if (action === 'editUrl') finish(null);
    else if (action === 'close') win.close();
    else if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    else return;
    event.preventDefault();
  });
  const current = win.webContents.getURL();
  wc.once('did-finish-load', () => {
    if (finished) return;
    wc.send('urlbar:show', {
      url: /^https?:/i.test(current) ? current : originalUrl,
      dark: nativeTheme.shouldUseDarkColors,
      texts: {
        title: t('editUrlTitle'),
        hint: t('editUrlHint', { key: i18n.label(settings.shortcuts().back, settings.language, isMac) || t('none') }),
        go: t('editUrlGo'),
        esc: t('editUrlEsc'),
      },
    });
    wc.focus();
  });
  wc.loadFile(URLBAR_PAGE);
}

// ---------------------------------------------------------------- Passwort-Autofill

/** Von welchem Web-Programm und welcher Seite kommt die Anfrage? Bestimmt der Hauptprozess selbst - nur der
 *  Hauptframe eines offenen Web-Programmfensters zählt, die Origin kommt von Chromium, nicht von der Seite. */
function autofillSource(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  const item = win && library.find(win.weblineItem);
  if (!item || !isWebItem(item) || programWins.get(item.id) !== win) return null;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return null;
  const origin = String(frame.origin ?? '');
  const site = /^https?:\/\//i.test(origin) ? siteOf(origin) : '';
  return site ? { win, item, origin, site } : null;
}

const siteLabel = (origin) => origin.replace(/^https?:\/\//i, '');

async function onCredentialsCaptured(event, data) {
  const src = autofillSource(event);
  if (!src || !settings.autofill || !passwords.available()) return;
  const username = typeof data?.username === 'string' ? data.username.slice(0, 500) : '';
  const password = typeof data?.password === 'string' ? data.password.slice(0, 1000) : '';
  if (!password || passwords.isNever(src.item.id, src.site)) return;
  const state = passwords.check(src.item.id, src.site, username, password);
  if (state === 'same' || src.win.weblineAsking) return;
  src.win.weblineAsking = true;
  try {
    const { response } = await dialog.showMessageBox(src.win, {
      type: 'question',
      title: 'Webline',
      message: t(state === 'update' ? 'pwUpdateQuestion' : 'pwSaveQuestion', { site: siteLabel(src.origin) }),
      detail: `${username ? t('pwUser', { user: username }) : t('noUsername')}\n${t('pwWhere')}`,
      buttons: [t(state === 'update' ? 'pwUpdate' : 'pwSave'), t('pwNotNow'), t('pwNever')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) passwords.save(src.item.id, src.site, src.origin, username, password);
    else if (response === 2) passwords.setNever(src.item.id, src.site, true);
    if (response !== 1) send('passwords:changed');
  } catch {
    // Fenster inzwischen zu
  } finally {
    if (!src.win.isDestroyed()) src.win.weblineAsking = false;
  }
}

function passwordsState() {
  const { entries, never } = passwords.list();
  const name = (id) => library.find(id)?.name ?? '';
  return {
    available: passwords.available(),
    entries: entries.map((e) => ({ ...e, program: name(e.programId), site: siteLabel(e.origin) })).sort((a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username)),
    never: never.map((n) => ({ ...n, program: name(n.programId) })),
  };
}

/** Drucken mit dem Druckdialog des Systems. Bei PDFs druckt der eingebaute Viewer das ganze Dokument. */
function printProgram(win) {
  if (win.isDestroyed()) return;
  win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
    if (!ok && reason && reason !== 'cancelled' && reason !== 'Print job canceled') toast(t('printFailed', { reason }), 'error');
  });
}

/** Welche Aktion löst diese Taste im Programmfenster aus? (null = keine, dann bekommt sie das Programm) */
function programShortcut(input) {
  const pressed = i18n.combo(
    { ctrl: input.control, meta: input.meta, alt: input.alt, shift: input.shift, key: input.key, code: input.code },
    isMac
  );
  if (!pressed) return null;
  const sc = settings.shortcuts();
  for (const id of ['fullscreen', 'close', 'reload', 'hardReload', 'devtools', 'downloads', 'print', 'editUrl', 'back'])
    if (sc[id] && sc[id] === pressed) return id;
  // Gewohnte Zweitbelegungen, solange die Standardtasten gelten
  if (sc.reload === 'F5' && pressed === 'Mod+R') return 'reload';
  if (sc.devtools === 'F12' && pressed === 'Mod+Shift+I') return 'devtools';
  return null;
}

function settingsState() {
  return {
    language: settings.language, style: settings.style, shortcuts: settings.shortcuts(), platform: process.platform,
    fileIcons: settings.fileIcons, fileIconsAvailable: fileIcons.available(),
    autofill: settings.autofill, passwordsAvailable: passwords ? passwords.available() : false,
  };
}

// Dateisymbole im Explorer hell/dunkel (Windows, installierte Version)
async function syncFileIcons(force) {
  const applied = await fileIcons.sync(settings.fileIcons, settings.fileIconsApplied, force);
  if (applied) settings.set({ fileIconsApplied: applied });
}

// ---------------------------------------------------------------- Launcher-Fenster

function createLauncher() {
  launcherWin = new BrowserWindow({
    title: 'Webline',
    width: 1040,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    icon: ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1117' : '#f4f5f9',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  launcherWin.removeMenu();
  launcherWin.once('ready-to-show', () => launcherWin.show());
  launcherWin.on('focus', broadcast); // "Datei fehlt" aktuell halten
  launcherWin.on('closed', () => {
    launcherWin = null;
  });
  launcherWin.webContents.on('will-navigate', (event) => event.preventDefault());
  launcherWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcherWin.loadFile(LAUNCHER_PAGE);
}

function showLauncher() {
  if (!launcherWin || launcherWin.isDestroyed()) createLauncher();
  if (launcherWin.isMinimized()) launcherWin.restore();
  launcherWin.show();
  launcherWin.focus();
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('state:get', getState);

  ipcMain.handle('library:pick', async () => {
    const result = await dialog.showOpenDialog(launcherWin, {
      title: t('addHtmlDialog'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: t('supportedFiles'), extensions: EXTENSIONS },
        { name: t('htmlFiles'), extensions: ['html', 'htm', 'xhtml', 'mhtml', 'mht', 'svg'] },
        { name: 'PDF', extensions: ['pdf'] },
      ],
    });
    if (!result.canceled) await addPaths(result.filePaths);
  });

  ipcMain.handle('library:add-paths', async (_event, paths) => {
    if (Array.isArray(paths)) await addPaths(paths.filter((p) => typeof p === 'string'));
  });

  ipcMain.handle('library:add-url', async (_event, url) => addUrl(String(url ?? '')));

  ipcMain.handle('app:shortcut', async (_event, id) => {
    const item = library.find(String(id));
    if (!item || !isWebItem(item)) return false;
    let ok = false;
    try {
      ok = await createShortcut(item);
    } catch {
      ok = false;
    }
    toast(ok ? t('shortcutCreated') : t('shortcutFailed'), ok ? 'ok' : 'warn');
    return ok;
  });

  ipcMain.handle('library:remove', async (_event, id) => {
    library.remove(String(id));
    await appIcons.removeFiles(iconDir(), String(id));
    await broadcast();
  });

  ipcMain.handle('library:rename', async (_event, id, name) => {
    library.rename(String(id), name);
    await broadcast();
  });

  ipcMain.handle('app:launch', (_event, id) => launch(String(id)));
  ipcMain.handle('autofill:list', (event) => {
    const src = autofillSource(event);
    if (!src) return [];
    return passwords.find(src.item.id, src.site).map(({ id, username }) => ({ id, username, noUser: t('noUsername') }));
  });
  ipcMain.handle('autofill:fill', (event, id) => {
    const src = autofillSource(event);
    const entry = src && passwords.get(String(id));
    if (!entry || entry.programId !== src.item.id || entry.site !== src.site) return null;
    passwords.used(entry.id);
    return { username: entry.username, password: entry.password };
  });
  ipcMain.on('autofill:captured', onCredentialsCaptured);
  ipcMain.handle('passwords:get', () => passwordsState());
  ipcMain.handle('passwords:remove', (_event, id) => {
    passwords.remove(String(id));
    return passwordsState();
  });
  ipcMain.handle('passwords:allow', (_event, programId, site) => {
    passwords.setNever(String(programId), String(site), false);
    return passwordsState();
  });
  ipcMain.on('urlbar:done', (event, value) => urlbars.get(event.sender.id)?.(typeof value === 'string' ? value : null));
  ipcMain.handle('library:icon', (_event, id, mode) => {
    const m = String(mode ?? 'pick');
    return ['pick', 'site', 'reset'].includes(m) ? changeIcon(String(id), m) : { ok: false };
  });

  // Text-Betrachter fragt nach dem Inhalt "seiner" Datei (welche, steht am Fenster - nicht in der Anfrage)
  ipcMain.handle('viewer:text', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const item = win && library.find(win.weblineItem);
    if (!item) return { error: t('entryNotFound') };
    try {
      const handle = await fs.promises.open(item.path, 'r');
      try {
        const size = (await handle.stat()).size;
        const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(Math.min(size, TEXT_LIMIT)), position: 0 });
        const text = buffer.toString('utf8', 0, bytesRead).replace(/^\uFEFF/, '');
        return {
          name: item.name,
          ext: path.extname(item.path).toLowerCase(),
          text,
          truncated: size > TEXT_LIMIT ? t('truncated', { mb: Math.round(TEXT_LIMIT / 1048576) }) : '',
        };
      } finally {
        await handle.close();
      }
    } catch {
      return { error: t('fileNotFound') };
    }
  });

  ipcMain.handle('app:reveal', (_event, id) => {
    const item = library.find(String(id));
    if (item && isWebItem(item)) shell.openExternal(item.url);
    else if (item) shell.showItemInFolder(item.path);
  });

  ipcMain.handle('downloads:get', getDownloadsState);

  // open, reveal, pause, resume, cancel, retry
  ipcMain.handle('downloads:action', async (_event, id, action) => {
    const error = await downloadManager.action(String(id), String(action));
    if (error) toast(error, 'error');
  });

  ipcMain.handle('downloads:remove', async (_event, id, deleteFile) => {
    downloadManager.remove(String(id), !!deleteFile);
  });

  ipcMain.handle('downloads:clear', async (_event, deleteFiles) => {
    downloadManager.clear(!!deleteFiles);
  });

  // "Als Standard-App festlegen"
  require('./defaults').setupDefaults({ ...require('./shared/default-types'), ipcMain, shell });

  // Sprache + Tastenkürzel
  ipcMain.handle('settings:get', settingsState);
  ipcMain.handle('settings:set', (_event, patch) => {
    if (!patch || typeof patch !== 'object') return settingsState();
    const iconsBefore = settings.fileIcons;
    settings.set(patch);
    if (settings.fileIcons !== iconsBefore) syncFileIcons(true);
    t = i18n.make(settings.language);
    const state = settingsState();
    send('settings:changed', state);
    downloadManager.settingsChanged(state);
    return state;
  });
}

// ---------------------------------------------------------------- Updates

/** Sucht kurz nach dem Start und dann stündlich nach einer neuen Version (GitHub-Releases),
 *  lädt sie im Hintergrund und fragt, ob jetzt neu gestartet werden soll. */
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  // Die portable .exe, tar.gz und die unsignierte Mac-App können sich nicht selbst ersetzen:
  // dort nur nachsehen und bei einer neuen Version zur Download-Seite schicken
  if (process.env.PORTABLE_EXECUTABLE_DIR || process.platform === 'darwin' || isTarGz()) {
    setupUpdateNotice();
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // "Später": wird beim nächsten Beenden installiert
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  let retry = null;
  autoUpdater.on('error', () => {
    // offline oder GitHub-Limit: in 10 Minuten nochmal
    clearTimeout(retry);
    retry = setTimeout(check, 10 * 60 * 1000);
  });
  // "Später": erst wieder fragen, wenn eine noch neuere Version erscheint oder zwei Wochen um sind
  const laterFile = path.join(app.getPath('userData'), 'update.json');
  const readLater = () => {
    try {
      return JSON.parse(fs.readFileSync(laterFile, 'utf8'));
    } catch {
      return {};
    }
  };
  let asking = false;
  autoUpdater.on('update-downloaded', async (info) => {
    const later = readLater();
    if (asking || (later.version === info.version && Date.now() < later.until)) return;
    asking = true;
    const parent = launcherWin && !launcherWin.isDestroyed() ? launcherWin : BrowserWindow.getFocusedWindow();
    const options = {
      type: 'info',
      buttons: [t('restartNow'), t('later')],
      defaultId: 0,
      cancelId: 1,
      title: t('updateTitle'),
      message: t('updateReady', { version: info.version }),
      detail: t('updateDetail'),
    };
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    asking = false;
    if (response === 0) {
      autoUpdater.quitAndInstall();
    } else {
      try {
        fs.writeFileSync(laterFile, JSON.stringify({ version: info.version, until: Date.now() + 14 * 24 * 3600 * 1000 }));
      } catch {
        // egal - dann wird eben beim nächsten Mal wieder gefragt
      }
    }
  });
  setTimeout(check, 5000);
  setInterval(check, 60 * 60 * 1000);
}

/** Linux ohne Paketverwaltung (entpacktes tar.gz): electron-updater kann dort nichts ersetzen */
function isTarGz() {
  if (process.platform !== 'linux') return false;
  const exe = app.getPath('exe');
  return !exe.startsWith('/usr/') && !exe.startsWith('/opt/');
}

/** Neue Version auf GitHub? Dann fragen, ob die Download-Seite aufgehen soll ("Später" = zwei Wochen Ruhe pro Version) */
function setupUpdateNotice() {
  const { net } = require('electron');
  const laterFile = path.join(app.getPath('userData'), 'update.json');
  const newer = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    return false;
  };
  let asked = false;
  const check = async () => {
    if (asked) return;
    try {
      const res = await net.fetch('https://api.github.com/repos/erqf1/webline/releases/latest', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Webline' },
      });
      if (!res.ok) return;
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!version || !newer(version, app.getVersion())) return;
      let later = {};
      try {
        later = JSON.parse(fs.readFileSync(laterFile, 'utf8'));
      } catch {
        // keine Datei -> fragen
      }
      if (later.version === version && Date.now() < later.until) return;
      asked = true;
      const parent = launcherWin && !launcherWin.isDestroyed() ? launcherWin : BrowserWindow.getFocusedWindow();
      const options = {
        type: 'info',
        buttons: [t('openDownloadPage'), t('later')],
        defaultId: 0,
        cancelId: 1,
        title: t('updateTitle'),
        message: t('updateAvailable', { version }),
        detail: t('updateManualDetail'),
      };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (response === 0) shell.openExternal(rel.html_url || 'https://github.com/erqf1/webline/releases/latest');
      else fs.writeFileSync(laterFile, JSON.stringify({ version, until: Date.now() + 14 * 24 * 3600 * 1000 }));
    } catch {
      // offline - später nochmal
    }
  };
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------- Start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', async (_event, argv) => {
    const files = htmlArgs(argv);
    if (files.length) await launchArgs(files);
    else showLauncher();
  });

  app.on('window-all-closed', () => app.quit());
  // Versteckte Hilfsfenster (Symbole dekodieren) halten die App nicht am Leben
  app.on('browser-window-created', (_event, created) => {
    created.once('closed', () => {
      const rest = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== created);
      if (rest.length && rest.every((w) => w.weblineHelper)) for (const w of rest) w.destroy();
    });
  });

  app.whenReady().then(async () => {
    // Unter Windows/Linux gibt es keine Menüleiste. macOS braucht ein Menü, sonst
    // funktionieren Cmd+Q sowie Kopieren/Einfügen in Textfeldern nicht.
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { label: 'Ansicht', submenu: [{ role: 'togglefullscreen' }] },
            { role: 'windowMenu' },
          ])
        : null
    );
    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    t = i18n.make(settings.language);
    setTimeout(() => syncFileIcons(false), 4000);
    library = new Library(path.join(app.getPath('userData'), 'library.json'));
    passwords = new Passwords(path.join(app.getPath('userData'), 'passwords.json'));
    downloads = new Downloads(path.join(app.getPath('userData'), 'downloads.json'));
    downloadManager = new DownloadManager({
      downloads,
      getProgramWindow: (id) => programWins.get(id),
      onChange: broadcastDownloads,
      onToast: toast,
      t: (...args) => t(...args),
      shortcut: (input) => programShortcut(input),
      settings: () => settingsState(),
      showAll: async () => {
        showLauncher();
        if (launcherWin.webContents.isLoading()) {
          await new Promise((resolve) => launcherWin.webContents.once('did-finish-load', resolve));
        }
        send('downloads:show');
      },
    });
    registerIpc();
    setupAutoUpdate();
    const files = htmlArgs(process.argv);
    if (files.length) await launchArgs(files);
    else createLauncher();
  });
}
