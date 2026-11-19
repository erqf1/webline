'use strict';

// Eigene Symbole für Programme: Bild (Datei oder Symbol der Webseite) -> quadratisches 256er-PNG + ICO
// unter userData/icons. Dekodiert wird in einem unsichtbaren, abgeschotteten Fenster mit <canvas>: so
// gehen alle Formate, die Chromium kennt (PNG, JPG, WebP, GIF, AVIF, BMP, ICO, SVG), auf allen Systemen gleich.

const { BrowserWindow, nativeImage, net } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 256;
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const MAX_BYTES = 8 * 1024 * 1024;

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

/** Dateityp an den ersten Bytes erkennen (Server schicken oft falsche content-types) */
function sniff(buf, hint = '') {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return MIME.png;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return MIME.jpeg;
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return MIME.webp;
  if (buf.length >= 6 && buf.toString('latin1', 0, 3) === 'GIF') return MIME.gif;
  if (buf.length >= 2 && buf.toString('latin1', 0, 2) === 'BM') return MIME.bmp;
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x00010000) return MIME.ico;
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp' && /avi[fs]/.test(buf.toString('latin1', 8, 12))) return MIME.avif;
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).replace(/^﻿/, '').trimStart();
  if (/^<(\?xml|svg|!--)/i.test(head) && /<svg/i.test(buf.toString('utf8', 0, Math.min(buf.length, 4096)))) return MIME.svg;
  return MIME[String(hint).toLowerCase()] || '';
}

let decoder = null;  // ein verstecktes Fenster, wird nach kurzer Zeit wieder geschlossen
let decoderTimer = null;

async function decoderWindow() {
  clearTimeout(decoderTimer);
  decoderTimer = setTimeout(() => {
    if (decoder && !decoder.isDestroyed()) decoder.destroy();
    decoder = null;
  }, 20000);
  if (decoder && !decoder.isDestroyed()) return decoder;
  decoder = new BrowserWindow({
    show: false,
    width: 320,
    height: 320,
    skipTaskbar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'webline-icons', spellcheck: false },
  });
  decoder.weblineHelper = true;
  decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  decoder.webContents.on('will-navigate', (e) => e.preventDefault());
  // Leere Seite, die nichts nachladen darf (Bilder kommen nur als data:-Adresse)
  const csp = "default-src 'none'; img-src data:";
  await decoder.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><title>icons</title>`)}`);
  return decoder;
}

/** Bilddaten -> quadratisches 256er-nativeImage (transparent aufgefüllt) oder null */
async function decode(buf, hint) {
  if (!buf || !buf.length || buf.length > MAX_BYTES) return null;
  const mime = sniff(buf, hint);
  if (!mime) return null;
  const win = await decoderWindow();
  const src = `data:${mime};base64,${buf.toString('base64')}`;
  const js = `new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const S = ${SIZE};
      const w = img.naturalWidth || S, h = img.naturalHeight || S;
      const k = Math.min(S / w, S / h);
      const dw = Math.max(1, Math.round(w * k)), dh = Math.max(1, Math.round(h * k));
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      // kleine Pixel-Symbole (16/32 px) scharf vergrößern statt verwaschen
      g.imageSmoothingEnabled = Math.max(w, h) > 64;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, Math.floor((S - dw) / 2), Math.floor((S - dh) / 2), dw, dh);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = ${JSON.stringify(src)};
  })`;
  let url = null;
  try {
    url = await win.webContents.executeJavaScript(js);
  } catch {
    url = null;
  }
  if (!url) return null;
  const out = nativeImage.createFromDataURL(url);
  return out.isEmpty() ? null : out;
}

/** ICO mit mehreren PNG-Einträgen (Windows liest PNG in ICO seit Vista, auch in kleinen Größen) */
function toIco(img) {
  const pngs = ICO_SIZES.map((s) => (s === SIZE ? img : img.resize({ width: s, height: s, quality: 'best' })).toPNG());
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach((png, i) => {
    const s = ICO_SIZES[i];
    const e = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, e);
    head.writeUInt8(s >= 256 ? 0 : s, e + 1);
    head.writeUInt8(0, e + 2);
    head.writeUInt8(0, e + 3);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs]);
}

/** Einträge einer ICO-Datei lesen (für Tests und Prüfung) */
function readIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
  const n = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const e = 6 + 16 * i;
    if (e + 16 > buf.length) return null;
    const size = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12);
    if (offset + size > buf.length) return null;
    entries.push({ width: buf[e] || 256, height: buf[e + 1] || 256, png: buf.subarray(offset, offset + size) });
  }
  return entries;
}

const safeId = (id) => String(id).replace(/[^a-z0-9_-]/gi, '_');

/** Alte Symbol-Dateien eines Programms löschen (außer keep) */
async function removeFiles(dir, id, keep = null) {
  let names = [];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  const prefix = `${safeId(id)}-`;
  for (const name of names) {
    if (!name.startsWith(prefix) && name !== `${safeId(id)}.png` && name !== `${safeId(id)}.ico`) continue;
    const full = path.join(dir, name);
    if (keep && full.replace(/\.(png|ico)$/, '') === keep.replace(/\.(png|ico)$/, '')) continue;
    await fs.promises.rm(full, { force: true }).catch(() => {});
  }
}

/** 256er-Bild als <id>-<zeit>.png + .ico ablegen. Neuer Name bei jeder Änderung: Windows merkt sich
 *  Symbole von Verknüpfungen pro Dateipfad, mit gleichem Namen bliebe dort das alte Bild stehen. */
async function store(dir, id, img) {
  await fs.promises.mkdir(dir, { recursive: true });
  const base = path.join(dir, `${safeId(id)}-${Date.now().toString(36)}`);
  await fs.promises.writeFile(`${base}.png`, img.toPNG());
  await fs.promises.writeFile(`${base}.ico`, toIco(img));
  await removeFiles(dir, id, base);
  return `${base}.png`;
}

const icoOf = (png) => png.replace(/\.png$/i, '.ico');

// ---------------------------------------------------------------- Symbol der Webseite

async function get(url, ms = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await net.fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function bytes(res) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > MAX_BYTES ? null : buf;
}

const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  const v = m ? (m[1] ?? m[2] ?? m[3]) : null;
  return v == null ? null : v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").trim();
};

/** größte Angabe aus sizes="16x16 32x32" bzw. "any" (SVG) */
function sizeOf(sizes) {
  if (!sizes) return 0;
  if (/any/i.test(sizes)) return 512;
  return Math.max(0, ...[...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].map((m) => Math.min(Number(m[1]), Number(m[2]))));
}

/** Kandidaten aus der Seite: <link rel="icon|apple-touch-icon">, Web-App-Manifest, /favicon.ico */
async function candidates(url) {
  const list = [];
  const page = await get(url);
  let base = url;
  if (page && /html|xml/i.test(page.headers.get('content-type') ?? 'text/html')) {
    base = page.url || url;
    const html = (await page.text()).slice(0, 500000);
    const baseHref = /<base\b[^>]*>/i.exec(html);
    if (baseHref && attr(baseHref[0], 'href')) {
      try {
        base = new URL(attr(baseHref[0], 'href'), base).href;
      } catch {}
    }
    let manifest = null;
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const rel = (attr(tag, 'rel') ?? '').toLowerCase().split(/\s+/);
      const href = attr(tag, 'href');
      if (!href) continue;
      if (rel.includes('manifest')) manifest = href;
      // mask-icon (einfarbige Safari-Vorlage) taugt nicht als Programmsymbol
      if (!rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed')) continue;
      let size = sizeOf(attr(tag, 'sizes'));
      if (!size) size = rel.some((r) => r.startsWith('apple-touch')) ? 180 : /\.svg(\?|$)/i.test(href) || /svg/i.test(attr(tag, 'type') ?? '') ? 512 : 32;
      try {
        list.push({ u: new URL(href, base).href, size });
      } catch {}
    }
    if (manifest) {
      try {
        const mu = new URL(manifest, base).href;
        const res = await get(mu, 5000);
        const data = res && JSON.parse((await res.text()).slice(0, 200000));
        for (const icon of Array.isArray(data?.icons) ? data.icons : []) {
          if (!icon?.src || /monochrome/i.test(icon.purpose ?? '')) continue;
          // "maskable" hat viel Rand für runde Masken - nur nehmen, wenn nichts anderes da ist
          const size = sizeOf(icon.sizes) || (/svg/i.test(icon.type ?? icon.src) ? 512 : 48);
          list.push({ u: new URL(icon.src, mu).href, size: /maskable/i.test(icon.purpose ?? '') && !/any/i.test(icon.purpose ?? '') ? size / 4 : size });
        }
      } catch {}
    }
  }
  for (const p of ['/apple-touch-icon.png', '/favicon.ico']) {
    try {
      list.push({ u: new URL(p, base).href, size: p.endsWith('.png') ? 100 : 16, guess: true });
    } catch {}
  }
  // größtes zuerst; ab 256 px gibt es keinen Gewinn mehr, dann lieber das kleinere (weniger Daten)
  const score = (c) => (c.size >= SIZE ? 1000 - c.size / 100 : c.size);
  const seen = new Set();
  return list.filter((c) => !seen.has(c.u) && seen.add(c.u)).sort((a, b) => score(b) - score(a));
}

/** Symbol der Webseite als 256er-nativeImage (oder null) */
async function fetchSiteIcon(url) {
  for (const c of await candidates(url)) {
    const res = await get(c.u, 6000);
    if (!res) continue;
    const buf = await bytes(res).catch(() => null);
    if (!buf) continue;
    const ext = (/\.([a-z0-9]+)(\?|#|$)/i.exec(new URL(c.u).pathname) ?? [])[1] ?? '';
    const img = await decode(buf, ext);
    if (img) return img;
  }
  return null;
}

/** Bilddatei vom Datenträger */
async function fromFile(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  return decode(await fs.promises.readFile(file), path.extname(file).slice(1));
}

module.exports = { decode, store, removeFiles, toIco, readIco, icoOf, fetchSiteIcon, fromFile, sniff, SIZE };
