'use strict';

// Windows: Dateisymbole (hell oder dunkel) für die Dateitypen von Webline umschalten.
// Der Installer legt je Typ eine ProgID an (Name aus package.json, z. B. "PDF-Dokument", Symbol: hell). Hier wird nur
// deren DefaultIcon in HKCU umgebogen - HKCU geht vor HKLM und braucht keine Adminrechte.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, nativeTheme } = require('electron');

// ProgID (fileAssociations[].name) -> Symbol in resources/filetypes/<hell|dunkel>/
const PROGIDS = {
  'HTML-Datei': 'html', 'HTM-Datei': 'htm', 'PDF-Dokument': 'pdf', 'SVG-Grafik': 'svg',
  'XHTML-Datei': 'xhtml', Webarchiv: 'mhtml', 'Markdown-Datei': 'md',
};

const dir = (variant) => path.join(process.resourcesPath || '', 'filetypes', variant);

function available() {
  return process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR && fs.existsSync(dir('light'));
}

/** 'auto' folgt dem Windows-Modus für Apps (wie der Explorer) */
function resolve(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

const run = (file, args) => new Promise((done) => execFile(file, args, { windowsHide: true, timeout: 20000 }, (err) => done(!err)));

async function apply(variant) {
  if (!available()) return false;
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const [progId, icon] of Object.entries(PROGIDS)) {
    lines.push(`[HKEY_CURRENT_USER\\Software\\Classes\\${progId}\\DefaultIcon]`, `@="${esc(path.join(dir(variant), `${icon}.ico`))}"`, '');
  }
  const regFile = path.join(os.tmpdir(), `webline-icons-${process.pid}.reg`);
  fs.writeFileSync(regFile, Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf16le'));  // reg import: UTF-16 mit BOM
  const ok = await run('reg.exe', ['import', regFile]);
  fs.rmSync(regFile, { force: true });
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -Namespace WC -Name Shell -MemberDefinition '[DllImport(\"shell32.dll\")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'; [WC.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)"]);
  return ok;
}

/** mode: gewünscht ('auto'|'light'|'dark'), applied: zuletzt geschrieben. Gibt die neue Variante zurück (oder null). */
async function sync(mode, applied, force = false) {
  if (!available()) return null;
  const want = resolve(mode || 'auto');
  // hell trägt der Installer selbst ein; dunkel nach jedem Update neu setzen
  if (!force && want === 'light' && applied !== 'dark') return null;
  return (await apply(want)) ? want : null;
}

module.exports = { available, sync, resolve };
