'use strict';

// Gespeicherte Anmeldungen für Web-Programme (Passwort-Autofill).
// Die ganze Liste liegt verschlüsselt in userData/passwords.json - mit dem Schlüsselspeicher des Systems
// (Windows: DPAPI, macOS: Schlüsselbund, Linux: libsecret/KWallet). Gibt es keinen sicheren Speicher
// (Linux ohne Schlüsselbund: Electron fiele auf ein festes Klartext-Passwort zurück), wird nichts gespeichert.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Verschlüsselung über Electrons safeStorage */
const systemCrypto = {
  available() {
    const { safeStorage } = require('electron');
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    return true;
  },
  encrypt: (text) => require('electron').safeStorage.encryptString(text),
  decrypt: (buf) => require('electron').safeStorage.decryptString(buf),
};

class Passwords {
  constructor(file, cipher = systemCrypto) {
    this.file = file;
    this.cipher = cipher;
    this.data = null; // erst beim ersten Zugriff entschlüsseln (macOS fragt dann ggf. nach dem Schlüsselbund)
  }

  available() {
    try {
      return this.cipher.available();
    } catch {
      return false;
    }
  }

  _load() {
    if (this.data) return this.data;
    this.data = { entries: [], never: [] };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return this.data;
    }
    try {
      const plain = JSON.parse(this.cipher.decrypt(Buffer.from(String(raw.data ?? ''), 'base64')));
      if (Array.isArray(plain.entries)) this.data.entries = plain.entries.filter((e) => e && typeof e.id === 'string' && typeof e.password === 'string');
      if (Array.isArray(plain.never)) this.data.never = plain.never.filter((n) => n && typeof n.site === 'string');
    } catch {
      // nicht entschlüsselbar (anderer Benutzer/Rechner): Datei aufheben, nicht überschreiben
      try {
        fs.copyFileSync(this.file, `${this.file}.unreadable`);
      } catch {}
    }
    return this.data;
  }

  _save() {
    const blob = this.cipher.encrypt(JSON.stringify(this.data));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, data: Buffer.from(blob).toString('base64') }), { mode: 0o600 });
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      fs.writeFileSync(this.file, fs.readFileSync(tmp), { mode: 0o600 });
      fs.rmSync(tmp, { force: true });
    }
  }

  /** Übersicht ohne Passwörter */
  list() {
    if (!this.available()) return { entries: [], never: [] };
    const { entries, never } = this._load();
    return {
      entries: entries.map(({ id, programId, origin, username, updatedAt }) => ({ id, programId, origin, username, updatedAt })),
      never: never.map(({ programId, site }) => ({ programId, site })),
    };
  }

  /** Anmeldungen eines Programms für eine Seite (site = Domain ohne www/Subdomain) */
  find(programId, site) {
    if (!this.available()) return [];
    return this._load().entries.filter((e) => e.programId === programId && e.site === site).sort((a, b) => b.usedAt - a.usedAt);
  }

  get(id) {
    if (!this.available()) return null;
    return this._load().entries.find((e) => e.id === id) ?? null;
  }

  /** 'new' | 'update' (anderes Passwort für denselben Benutzer) | 'same' (schon so gespeichert) */
  check(programId, site, username, password) {
    const hit = this.find(programId, site).find((e) => e.username === username);
    if (!hit) return 'new';
    return hit.password === password ? 'same' : 'update';
  }

  save(programId, site, origin, username, password) {
    if (!this.available() || !password) return false;
    const data = this._load();
    const now = Date.now();
    const hit = data.entries.find((e) => e.programId === programId && e.site === site && e.username === username);
    if (hit) Object.assign(hit, { password, origin, updatedAt: now, usedAt: now });
    else data.entries.push({ id: crypto.randomUUID(), programId, site, origin, username, password, createdAt: now, updatedAt: now, usedAt: now });
    this._save();
    return true;
  }

  used(id) {
    const e = this.get(id);
    if (!e) return;
    e.usedAt = Date.now();
    this._save();
  }

  remove(id) {
    if (!this.available()) return;
    const data = this._load();
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => e.id !== id);
    if (data.entries.length !== before) this._save();
  }

  isNever(programId, site) {
    return this.available() && this._load().never.some((n) => n.programId === programId && n.site === site);
  }

  setNever(programId, site, on = true) {
    if (!this.available()) return;
    const data = this._load();
    data.never = data.never.filter((n) => !(n.programId === programId && n.site === site));
    if (on) data.never.push({ programId, site });
    this._save();
  }
}

module.exports = { Passwords, systemCrypto };
