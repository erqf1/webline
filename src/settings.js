'use strict';

const fs = require('fs');
const path = require('path');
const { SHORTCUTS, LANGUAGES } = require('./i18n');

// Sprache, Stil und eigene Tastenkürzel (userData/settings.json). Englisch und Standard-Stil sind die Vorgabe.
const STYLES = ['standard', 'minimal'];
const FILE_ICONS = ['auto', 'light', 'dark'];  // Dateisymbole im Explorer (Windows): wie Windows, hell, dunkel
class Settings {
  constructor(file) {
    this.file = file;
    this.data = { language: 'en', style: 'standard', fileIcons: 'auto', fileIconsApplied: 'light', shortcuts: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (LANGUAGES[raw.language]) this.data.language = raw.language;
      if (STYLES.includes(raw.style)) this.data.style = raw.style;
      if (FILE_ICONS.includes(raw.fileIcons)) this.data.fileIcons = raw.fileIcons;
      if (raw.fileIconsApplied === 'dark') this.data.fileIconsApplied = 'dark';
      if (raw.shortcuts && typeof raw.shortcuts === 'object') this.data.shortcuts = raw.shortcuts;
    } catch {
      // keine Datei / kaputt -> Standard
    }
  }

  get language() {
    return this.data.language;
  }

  get style() {
    return this.data.style;
  }

  get fileIcons() {
    return this.data.fileIcons;
  }

  get fileIconsApplied() {
    return this.data.fileIconsApplied;
  }

  /** Wirksame Kürzel: eigene Belegung (auch leer = keine Taste) oder Standard */
  shortcuts() {
    const out = {};
    for (const s of SHORTCUTS) out[s.id] = s.id in this.data.shortcuts ? String(this.data.shortcuts[s.id]) : s.def;
    return out;
  }

  set(patch) {
    if (patch.language && LANGUAGES[patch.language]) this.data.language = patch.language;
    if (STYLES.includes(patch.style)) this.data.style = patch.style;
    if (FILE_ICONS.includes(patch.fileIcons)) this.data.fileIcons = patch.fileIcons;
    if (patch.fileIconsApplied === 'light' || patch.fileIconsApplied === 'dark') this.data.fileIconsApplied = patch.fileIconsApplied;
    if (patch.shortcuts && typeof patch.shortcuts === 'object') {
      for (const s of SHORTCUTS) {
        if (!(s.id in patch.shortcuts)) continue;
        const v = String(patch.shortcuts[s.id] ?? '');
        if (v === s.def) delete this.data.shortcuts[s.id];
        else this.data.shortcuts[s.id] = v;
      }
    }
    if (patch.resetShortcuts) this.data.shortcuts = {};
    this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // nicht schlimm - dann gilt es nur bis zum Beenden
    }
  }
}

module.exports = { Settings };
