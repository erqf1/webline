'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, shell } = require('electron');
const fileIcons = require('./fileicons');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Library, isSupportedFile, fileKind, idFor, EXTENSIONS, normalizeUrl, nameForUrl, titleFromHtml, isWebItem, webId } = require('./store');
const { Downloads } = require('./downloads');
const { DownloadManager } = require('./download-manager');
const { Settings } = require('./settings');
const i18n = require('./i18n');

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const PRELOAD = path.join(__dirname, 'preload.js');
const LAUNCHER_PAGE = path.join(__dirname, 'renderer', 'index.html');
const VIEWER_PAGE = path.join(__dirname, 'viewer', 'viewer.html');
const VIEWER_PRELOAD = path.join(__dirname, 'viewer', 'viewer-preload.js');
const TEXT_LIMIT = 25 * 1024 * 1024; // größere Textdateien werden gekürzt angezeigt

let library;
let downloads;
let downloadManager;
let settings;
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
        ? { ...item, kind: 'web', missing: false }
        : { ...item, kind: fileKind(item.path), missing: !(await exists(item.path)) }
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

/** Desktop-Verknüpfung, die das Web-Programm direkt startet (wie Doppelklick auf eine HTML-Datei) */
async function createShortcut(item) {
  const desktop = app.getPath('desktop');
  const safe = item.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Webline';
  if (process.platform === 'win32') {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const ok = shell.writeShortcutLink(path.join(desktop, `${safe}.lnk`), {
      target,
      args: process.defaultApp ? `"${path.resolve(process.argv[1] ?? '.')}" "${item.url}"` : `"${item.url}"`,
      description: item.url,
      icon: target,
      iconIndex: 0,
    });
    return ok;
  }
  if (process.platform === 'linux') {
    const exec = process.env.APPIMAGE || process.execPath;
    const body = `[Desktop Entry]\nType=Application\nName=${safe}\nExec="${exec}" "${item.url}"\nIcon=webline\nTerminal=false\n`;
    const file = path.join(desktop, `${safe}.desktop`);
    await fs.promises.writeFile(file, body, { mode: 0o755 });
    return true;
  }
  return false;
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
    const win = new BrowserWindow({
      title: item.name,
      // Startet maximiert statt im echten Vollbild - fühlt sich wie ein normales
      // Programmfenster an. Vollbild bleibt über F11 einen Tastendruck entfernt.
      show: false,
      backgroundColor: web ? '#ffffff' : '#000000',
      autoHideMenuBar: true,
      icon: ICON,
      webPreferences: {
        // Jedes Programm hat seinen eigenen, dauerhaften Speicherbereich,
        // sonst würden sich alle file://-Seiten localStorage & Co. teilen.
        partition: `persist:app-${item.id}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        plugins: kind === 'pdf' || web,
        preload: kind === 'text' ? VIEWER_PRELOAD : undefined,
      },
    });
    win.removeMenu();
    programWins.set(id, win);
    win.weblineItem = item.id;
    library.touch(id);

    win.once('ready-to-show', () => {
      win.maximize();
      win.show();
    });
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
      if (!win.isVisible()) setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) { win.maximize(); win.show(); } }, 3000);
    }
    win.loadURL(originalUrl);
    await broadcast();
    return { ok: true };
  } finally {
    launching.delete(id);
  }
}

function attachProgramBehavior(win, originalUrl, programId, web = false) {
  const { webContents } = win;
  // Web-Programme: die eigene Seite (und wohin sie beim ersten Laden umleitet) bleibt im Fenster,
  // fremde Seiten öffnen im Browser - wie bei HTML-Dateien.
  const origins = new Set();
  const originOf = (u) => {
    try {
      return new URL(u).origin;
    } catch {
      return '';
    }
  };
  if (web) origins.add(originOf(originalUrl));
  const isOwn = (u) => web && (origins.has(originOf(u)) || /^data:/i.test(u));
  let firstLoad = true;

  // Links ins Web öffnen im Standardbrowser statt das "Programm" zu ersetzen.
  const openExternal = (url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    if (isOwn(url)) webContents.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });

  // will-navigate wird bewusst NICHT mehr blockiert: Ein Klick, der am Ende eine
  // Datei herunterlädt (Content-Disposition:attachment), löst dieses Ereignis
  // zwar aus, "navigiert" aber nie wirklich - die Seite bleibt stehen und
  // will-download (siehe unten) übernimmt. Nur wenn die Navigation tatsächlich
  // committet (did-navigate mit einer fremden http(s)-Adresse: es war also doch
  // eine echte Seite), springen wir zurück und öffnen sie extern.
  webContents.on('did-navigate', (event, url) => {
    if (web && firstLoad) {
      firstLoad = false;
      origins.add(originOf(url));
    }
    if (isOwn(url)) return;
    if (url !== originalUrl && /^https?:\/\//i.test(url)) {
      openExternal(url);
      webContents.loadURL(originalUrl);
    }
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
    else return;
    event.preventDefault();
  });
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
  for (const id of ['fullscreen', 'close', 'reload', 'hardReload', 'devtools', 'downloads', 'print'])
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
    await broadcast();
  });

  ipcMain.handle('library:rename', async (_event, id, name) => {
    library.rename(String(id), name);
    await broadcast();
  });

  ipcMain.handle('app:launch', (_event, id) => launch(String(id)));

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
