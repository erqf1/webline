'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Welche Dateien Webcase starten kann - und wie (siehe launch() in main.js)
const KINDS = {
  html: ['.html', '.htm', '.xhtml', '.mhtml', '.mht', '.svg'],
  pdf: ['.pdf'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico'],
  video: ['.mp4', '.webm', '.ogv', '.m4v', '.mov'],
  audio: ['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.flac', '.opus', '.aac'],
  text: ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml', '.ini', '.toml'],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((e) => [e, kind])));
const EXTENSIONS = [...KIND_OF.keys()].map((e) => e.slice(1));
const TITLE_KINDS = new Set(['.html', '.htm', '.xhtml', '.svg']);
const NAME_LIMIT = 80;

/** "html" | "pdf" | "image" | "video" | "audio" | "text" | null */
function fileKind(file) {
  return typeof file === 'string' ? KIND_OF.get(path.extname(file).toLowerCase()) ?? null : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const num = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try {
        return String.fromCodePoint(num);
      } catch {
        return match;
      }
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

async function isSupportedFile(file) {
  if (!fileKind(file)) return false;
  try {
    return (await fs.promises.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Liest den <title> aus dem Anfang der Datei; Fallback ist der Dateiname. */
async function readTitle(file) {
  const fallback = path.basename(file, path.extname(file));
  if (!TITLE_KINDS.has(path.extname(file).toLowerCase())) return fallback.slice(0, NAME_LIMIT);
  try {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(32768), position: 0 });
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buffer.toString('utf8', 0, bytesRead));
      const title = match && decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
      if (title) return title.slice(0, NAME_LIMIT);
    } finally {
      await handle.close();
    }
  } catch {
    // Datei nicht lesbar -> Dateiname reicht
  }
  return fallback;
}

/**
 * Die ID ist ein Hash des Dateipfads. Sie bestimmt auch den Speicherbereich
 * (localStorage, IndexedDB ...) des Programms - wer ein Programm entfernt und
 * später wieder hinzufügt, behält damit seine Daten.
 */
function idFor(file) {
  const key = process.platform === 'win32' ? file.toLowerCase() : file;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

class Library {
  constructor(file) {
    this.file = file;
    this.items = this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    try {
      const data = JSON.parse(raw);
      return (Array.isArray(data.items) ? data.items : []).filter(
        (i) => i && typeof i.id === 'string' && typeof i.path === 'string' && typeof i.name === 'string'
      );
    } catch {
      // Kaputte Datei nicht stillschweigend überschreiben
      try {
        fs.copyFileSync(this.file, `${this.file}.corrupt`);
      } catch {
        // ignorieren
      }
      return [];
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const data = JSON.stringify({ version: 1, items: this.items }, null, 2);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // EXDEV: tmp und Zielordner liegen auf unterschiedlichen Laufwerken/Mounts
      // (z. B. %APPDATA% per Gruppenrichtlinie umgeleitet) - rename() geht dann nicht
      // atomar, ein Kopieren + Löschen tut es aber noch.
      if (err.code !== 'EXDEV') throw err;
      fs.writeFileSync(this.file, data);
      fs.unlinkSync(tmp);
    }
  }

  find(id) {
    return this.items.find((i) => i.id === id);
  }

  async add(files) {
    let added = 0;
    let duplicates = 0;
    for (const file of files) {
      const full = path.resolve(file);
      const id = idFor(full);
      const name = await readTitle(full);
      if (this.find(id)) {
        duplicates++;
        continue;
      }
      this.items.push({ id, path: full, name, addedAt: Date.now(), lastLaunched: null });
      added++;
    }
    if (added) this._save();
    return { added, duplicates };
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== before) this._save();
  }

  rename(id, name) {
    const item = this.find(id);
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT) : '';
    if (!item || !clean) return;
    item.name = clean;
    this._save();
  }

  touch(id) {
    const item = this.find(id);
    if (!item) return;
    item.lastLaunched = Date.now();
    this._save();
  }
}

module.exports = { Library, isSupportedFile, fileKind, idFor, EXTENSIONS };
