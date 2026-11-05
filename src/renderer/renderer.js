'use strict';

const api = window.launcher;
const I18N = window.WeblineI18n;
const $ = (selector) => document.querySelector(selector);
const isMac = api.platform === 'darwin';

// Sprache + Tastenkürzel (kommen aus dem Hauptprozess, Englisch ist der Standard)
let settings = { language: 'en', shortcuts: {} };
let t = I18N.make('en');
const locale = () => (settings.language === 'de' ? 'de-DE' : 'en-US');
const keyLabel = (id) => I18N.label(settings.shortcuts[id] || '', settings.language, isMac);

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13L19 12z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  spinner: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  resume: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13L19 12z"/></svg>',
  cancel: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>',
};

const KIND_ICONS = {
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24"><path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
};

let state = { items: [], running: [] };
let downloadsState = { items: [] };
let query = '';

// ---------------------------------------------------------------- Hilfen

function el(tag, { className, text, attrs } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  for (const [key, value] of Object.entries(attrs ?? {})) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

function iconButton(icon, label, onClick, extraClass = '') {
  const button = el('button', { className: `icon-btn ${extraClass}`.trim(), attrs: { type: 'button', title: label, 'aria-label': label } });
  button.innerHTML = ICONS[icon]; // statische Konstante, keine Nutzerdaten
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  // Enter/Leertaste auf dem Button soll nicht die Karte starten
  button.addEventListener('keydown', (event) => event.stopPropagation());
  return button;
}

function hueFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** "C:\Users\me\Spiele\snake\index.html" -> "…\snake\index.html" (mit dem Trenner des Systems) */
function shortPath(fullPath) {
  const sep = fullPath.includes('\\') ? '\\' : '/';
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : fullPath;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
}

function formatWhen(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
}

function toast(message, kind = 'info') {
  const node = el('div', { className: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

// ---------------------------------------------------------------- Dialoge

const modal = $('#modal');

/** Öffnet den Dialog; liefert den Text (bei input), true (bestätigt) oder null (abgebrochen). */
function ask({ title, text = '', input, confirm, danger = false }) {
  return new Promise((resolve) => {
    const field = $('#modal-input');
    const ok = $('#modal-ok');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    ok.textContent = confirm;
    ok.className = `btn ${danger ? 'danger' : 'primary'}`;
    field.hidden = input == null;
    field.value = input ?? '';

    const sync = () => {
      ok.disabled = !field.hidden && field.value.trim() === '';
    };
    field.oninput = sync;
    // Enter würde sonst den ersten Submit-Button auslösen: "Abbrechen"
    field.onkeydown = (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (!ok.disabled) ok.click();
    };
    sync();

    modal.addEventListener(
      'close',
      () => {
        if (modal.returnValue !== 'ok') return resolve(null);
        resolve(field.hidden ? true : field.value.trim());
      },
      { once: true }
    );
    modal.returnValue = 'cancel';
    modal.showModal();
    if (!field.hidden) field.select();
  });
}

// ---------------------------------------------------------------- Aktionen

async function launch(item) {
  const result = await api.launch(item.id);
  if (!result.ok) toast(result.error, 'error');
}

async function rename(item) {
  const name = await ask({ title: t('rename'), input: item.name, confirm: t('save') });
  if (name) await api.rename(item.id, name);
}

async function remove(item) {
  const confirmed = await ask({
    title: t('removeQuestion'),
    text: t('removeText', { name: item.name }),
    confirm: t('remove'),
    danger: true,
  });
  if (confirmed) await api.remove(item.id);
}

// ---------------------------------------------------------------- Darstellung

function card(item) {
  const running = state.running.includes(item.id);

  // HTML-Programme: Anfangsbuchstabe auf eigener Farbe. Andere Dateien: feste Farbe + Art (PDF, Bild …)
  const kind = item.kind && item.kind !== 'html' ? item.kind : null;
  const label = { pdf: 'PDF', image: '', video: '', audio: '', text: '' }[kind];
  const tile = el('div', { className: `tile${kind ? ` kind-${kind}` : ''}`, text: kind ? label : [...item.name][0] ?? '?' });
  if (kind && !label) tile.innerHTML = KIND_ICONS[kind]; // statische Konstante
  if (!kind) tile.style.setProperty('--h', hueFor(item.id));
  const play = el('span', { className: 'play' });
  play.innerHTML = ICONS.play;
  tile.append(play);

  const meta = el(
    'div',
    { className: 'meta' },
    el('h3', { className: 'name', text: item.name, attrs: { title: item.name } }),
    el('p', { className: 'path', text: shortPath(item.path), attrs: { title: item.path } })
  );
  if (item.missing) meta.append(el('span', { className: 'badge missing', text: t('fileMissing') }));
  else if (running) meta.append(el('span', { className: 'badge running', text: t('running') }));
  else if (kind) meta.append(el('span', { className: 'badge kind', text: t(`kind${kind[0].toUpperCase()}${kind.slice(1)}`) }));

  const actions = el(
    'div',
    { className: 'actions' },
    iconButton('edit', t('rename'), () => rename(item)),
    iconButton('folder', t('showInFolder'), () => api.reveal(item.id)),
    iconButton('trash', t('removeFromList'), () => remove(item), 'danger')
  );

  const node = el(
    'article',
    {
      className: `card${item.missing ? ' missing' : ''}`,
      attrs: { tabindex: 0, role: 'button', 'aria-label': t('start', { name: item.name }) },
    },
    tile,
    meta,
    actions
  );
  node.addEventListener('click', () => launch(item));
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      launch(item);
    } else if (event.key === 'F2') {
      rename(item);
    } else if (event.key === 'Delete') {
      remove(item);
    }
  });
  return node;
}

function render() {
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? state.items.filter((i) => i.name.toLowerCase().includes(needle) || i.path.toLowerCase().includes(needle))
    : state.items;

  const empty = state.items.length === 0;
  $('#empty').hidden = !empty;
  $('#nomatch').hidden = empty || visible.length > 0;
  $('.search').hidden = empty;

  const count = $('#count');
  count.hidden = empty;
  count.textContent = needle
    ? t('countOf', { n: visible.length, total: state.items.length })
    : state.items.length === 1
      ? t('countOne')
      : t('countMany', { n: state.items.length });

  $('#grid').replaceChildren(...visible.map(card));
}

// ---------------------------------------------------------------- Downloads

const downloadsModal = $('#downloads-modal');

function downloadRow(entry) {
  const isActive = entry.state === 'progressing' || entry.state === 'paused';
  const isError = !isActive && (entry.missing || entry.state === 'interrupted' || entry.state === 'cancelled');
  const progress = entry.total ? t('of', { a: formatSize(entry.received) || '0 KB', b: formatSize(entry.total) }) : formatSize(entry.received);
  const statusParts = [];
  if (entry.state === 'progressing') {
    statusParts.push(progress || t('loading'));
    if (entry.speed > 0) statusParts.push(`${formatSize(entry.speed)}/s`);
  } else if (entry.state === 'paused') {
    statusParts.push(t('paused'), progress);
  } else if (entry.state === 'interrupted') {
    statusParts.push(t('failed'));
  } else if (entry.state === 'cancelled') {
    statusParts.push(t('cancelled'));
  } else {
    if (entry.missing) statusParts.push(t('fileMissing'));
    statusParts.push(formatSize(entry.size));
  }
  if (!isActive) statusParts.push(formatWhen(entry.completedAt || entry.startedAt));

  const icon = el('div', { className: 'dl-icon' });
  icon.innerHTML = ICONS[isActive ? 'spinner' : 'file'];

  const info = el(
    'button',
    { className: 'dl-info', attrs: { type: 'button', title: entry.path || entry.filename } },
    el('div', { className: 'dl-name', text: entry.filename }),
    el('div', { className: `dl-meta${isError ? ' error' : ''}`, text: statusParts.filter(Boolean).join(' · ') })
  );
  if (isActive) {
    const fill = el('div', { className: 'dl-bar-fill' });
    const bar = el('div', { className: `dl-bar${entry.state === 'paused' ? ' paused' : ''}` }, fill);
    if (entry.total > 0) fill.style.width = `${Math.min(100, (entry.received / entry.total) * 100)}%`;
    else bar.classList.add('indeterminate');
    info.append(bar);
  }
  info.disabled = entry.missing || entry.state !== 'completed';
  info.addEventListener('click', () => api.downloadAction(entry.id, 'open'));

  const buttons = [];
  if (entry.state === 'progressing') {
    buttons.push(iconButton('pause', t('pause'), () => api.downloadAction(entry.id, 'pause')));
    buttons.push(iconButton('cancel', t('cancel'), () => api.downloadAction(entry.id, 'cancel'), 'danger'));
  } else if (entry.state === 'paused') {
    buttons.push(iconButton('resume', t('resume'), () => api.downloadAction(entry.id, 'resume')));
    buttons.push(iconButton('cancel', t('cancel'), () => api.downloadAction(entry.id, 'cancel'), 'danger'));
  } else {
    if (entry.state === 'interrupted' || entry.state === 'cancelled') {
      buttons.push(iconButton('retry', t('retry'), () => api.downloadAction(entry.id, 'retry')));
    }
    if (!entry.missing) buttons.push(iconButton('folder', t('showInFolder'), () => api.downloadAction(entry.id, 'reveal')));
    buttons.push(iconButton('trash', t('delete'), () => removeDownload(entry), 'danger'));
  }
  const actions = el('div', { className: 'dl-actions' }, ...buttons);

  const stateClass = isActive ? 'progressing' : isError ? 'missing' : '';
  return el('div', { className: `dl-row ${stateClass}`.trim() }, icon, info, actions);
}

async function removeDownload(entry) {
  const confirmed = await ask({
    title: t('deleteDownloadQuestion'),
    text: t('deleteDownloadText', { name: entry.filename }),
    confirm: t('delete'),
    danger: true,
  });
  if (confirmed) await api.removeDownload(entry.id, !entry.missing && entry.state === 'completed');
}

function renderDownloads() {
  const items = downloadsState.items;
  $('#downloads-list').replaceChildren(...items.map(downloadRow));
  $('#downloads-empty').hidden = items.length > 0;
  $('#downloads-clear').hidden = items.length === 0;
  $('#downloads-badge').hidden = !items.some((i) => i.state === 'progressing' || i.state === 'paused');
}

// ---------------------------------------------------------------- Verdrahtung

$('#add').addEventListener('click', () => api.pick());
$('#empty-add').addEventListener('click', () => api.pick());
$('#search').addEventListener('input', (event) => {
  query = event.target.value;
  render();
});


$('#downloads-btn').addEventListener('click', () => downloadsModal.showModal());
api.onShowDownloads(() => {
  if (modal.open) modal.close();
  if (!downloadsModal.open) downloadsModal.showModal();
});
$('#downloads-close').addEventListener('click', () => downloadsModal.close());
$('[data-close-downloads]').addEventListener('click', () => downloadsModal.close());
$('#downloads-clear').addEventListener('click', async () => {
  const confirmed = await ask({
    title: t('deleteAllQuestion'),
    text: t('deleteAllText'),
    confirm: t('deleteAll'),
    danger: true,
  });
  if (confirmed) await api.clearDownloads(true);
});

window.addEventListener('keydown', (event) => {
  if (modal.open || downloadsModal.open || settingsModal.open) return;
  const pressed = comboOf(event);
  if (pressed && pressed === settings.shortcuts.add) {
    event.preventDefault();
    api.pick();
  } else if (pressed && pressed === settings.shortcuts.search) {
    event.preventDefault();
    $('#search').focus();
  } else if (event.key === 'Escape' && document.activeElement === $('#search')) {
    $('#search').value = '';
    query = '';
    render();
    $('#search').blur();
  }
});

// Drop-Overlay (das eigentliche Ablegen wird im Preload verarbeitet)
let dragDepth = 0;
const carriesFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (event) => {
  if (!carriesFiles(event)) return;
  dragDepth++;
  $('#drop').hidden = false;
});
window.addEventListener('dragleave', (event) => {
  if (!carriesFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop').hidden = true;
});
window.addEventListener('drop', () => {
  dragDepth = 0;
  $('#drop').hidden = true;
});

api.onState((next) => {
  state = next;
  render();
});
api.onToast(({ message, kind }) => toast(message, kind));
api.getState().then((initial) => {
  state = initial;
  render();
});

// ---------------------------------------------------------------- Sprache + Tastenkürzel

const settingsModal = $('#settings-modal');

function comboOf(event) {
  return I18N.combo(
    { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey, key: event.key, code: event.code },
    isMac
  );
}

/** Alle festen Texte der Seite in der gewählten Sprache */
function applyTexts() {
  document.documentElement.lang = settings.language;
  document.querySelectorAll('[data-t]').forEach((n) => (n.textContent = t(n.dataset.t)));
  document.querySelectorAll('[data-t-title]').forEach((n) => (n.title = t(n.dataset.tTitle)));
  document.querySelectorAll('[data-t-placeholder]').forEach((n) => (n.placeholder = t(n.dataset.tPlaceholder)));
  document.querySelectorAll('[data-t-aria]').forEach((n) => n.setAttribute('aria-label', t(n.dataset.tAria)));
  const addKey = keyLabel('add');
  $('#add').title = addKey ? t('addHtmlTitle', { key: addKey }) : t('addHtml');
  $('#downloads-empty-text').textContent = t('noDownloadsText', { key: keyLabel('downloads') || t('none') });

  // Fußzeile: die wichtigsten Tasten im Programm, mit den aktuellen Belegungen
  const hint = $('#footer-hint');
  hint.replaceChildren(t('inProgram'));
  for (const [id, text] of [['fullscreen', 'hintFullscreen'], ['close', 'hintClose'], ['print', 'hintPrint'], ['reload', 'hintReload'], ['devtools', 'hintDevtools']]) {
    const key = keyLabel(id);
    if (!key) continue;
    hint.append(el('span', {}, el('kbd', { text: key }), ` ${t(text)}`));
  }
}

// Rauch für den Stil Acryl: weiche Wolken aus nur einer Farbfamilie, bewusst ohne Korn.
// Gleiche Rechnung wie in Vidline und Clipline, der Weichzeichner läuft mit laufender Summe.
const cache = new Map();

function boxBlur(px, w, h, r) {
  const c = 2 * r + 1;
  const line = new Uint8Array(Math.max(w, h) * 3);
  const run = (start, len, step) => {
    for (let i = 0; i < len; i++) {
      const o = start + i * step;
      line[i * 3] = px[o];
      line[i * 3 + 1] = px[o + 1];
      line[i * 3 + 2] = px[o + 2];
    }
    for (let ch = 0; ch < 3; ch++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += line[Math.min(len - 1, Math.max(0, i)) * 3 + ch];
      for (let i = 0; i < len; i++) {
        px[start + i * step + ch] = sum / c;
        sum += line[Math.min(len - 1, i + r + 1) * 3 + ch] - line[Math.max(0, i - r) * 3 + ch];
      }
    }
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) run(y * w * 4, w, 4);
    for (let x = 0; x < w; x++) run(x * 4, h, w * 4);
  }
}

/** Bild als data-URL für CSS */
function smokeUrl(hue, dark) {
  const key = `${hue}-${dark ? 'd' : 'l'}`;
  if (cache.has(key)) return cache.get(key);
  const W = 640, H = 360;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = dark ? `hsl(${hue} 9% 15%)` : `hsl(${hue} 12% 91%)`;
  g.fillRect(0, 0, W, H);
  let seed = 11;
  const pick = (a, b) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return a + (seed >>> 8) % (b - a + 1);
  };
  for (let i = 0; i < 11; i++) {
    const h2 = (hue + pick(-14, 14) + 360) % 360;
    g.fillStyle = dark ? `hsl(${h2} ${pick(20, 36)}% ${pick(22, 31)}%)` : `hsl(${h2} ${pick(20, 35)}% ${pick(84, 89)}%)`;
    const rx = pick(60, 175), ry = pick(40, 120);
    g.beginPath();
    g.ellipse(pick(-80, W) + rx, pick(-80, H) + ry, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
  }
  const img = g.getImageData(0, 0, W, H);
  boxBlur(img.data, W, H, 55);
  g.putImageData(img, 0, 0);
  const url = c.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

// Stil Acryl: Farbton der Webline-Akzentfarbe, hell oder dunkel wie das System
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
function applySmoke() {
  const on = (settings.style || 'standard') === 'acryl';
  document.documentElement.style.setProperty('--smoke', on ? `url("${smokeUrl(237, prefersDark.matches)}")` : 'none');
}
prefersDark.addEventListener('change', applySmoke);

function renderSettings() {
  const lang = $('#language');
  lang.replaceChildren(...Object.entries(I18N.LANGUAGES).map(([code, name]) => el('option', { text: name, attrs: { value: code } })));
  lang.value = settings.language;
  const style = $('#style');
  const styleNames = { standard: 'styleStandard', minimal: 'styleMinimal', acryl: 'styleAcryl' };
  style.replaceChildren(...Object.keys(styleNames).map((s) => el('option', { text: t(styleNames[s]), attrs: { value: s } })));
  style.value = settings.style || 'standard';
  // Dateisymbole im Explorer: nur in der installierten Windows-Version
  $('#file-icons-row').hidden = !settings.fileIconsAvailable;
  const icons = $('#file-icons');
  icons.replaceChildren(...[['auto', 'fileIconsAuto'], ['light', 'fileIconsLight'], ['dark', 'fileIconsDark']].map(([v, k]) => el('option', { text: t(k), attrs: { value: v } })));
  icons.value = settings.fileIcons || 'auto';
  // Als Standard-App festlegen (Texte kommen aus dem Hauptprozess)
  api.defaults.info(settings.language).then((info) => {
    $('#defaults-label').textContent = info.texts.title;
    $('#defaults-open').textContent = info.texts.menu;
  });

  const list = $('#shortcut-list');
  list.replaceChildren(
    ...I18N.SHORTCUTS.map((sc) => {
      const button = el('button', { className: 'btn key-btn', text: keyLabel(sc.id) || t('none'), attrs: { type: 'button' } });
      button.addEventListener('click', () => recordKey(sc, button));
      return el('div', { className: 'shortcut-row' }, el('span', { text: t(sc.label) }), button);
    })
  );
}

/** Nächste Tastenkombination aufnehmen: Esc bricht ab, Rücktaste entfernt die Taste */
function recordKey(sc, button) {
  button.textContent = t('pressKey');
  button.classList.add('recording');
  const onKey = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(event.key)) return;  // auf die "echte" Taste warten
    window.removeEventListener('keydown', onKey, true);
    button.classList.remove('recording');
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (plain && event.key === 'Escape') return renderSettings();
    const value = plain && event.key === 'Backspace' ? '' : comboOf(event);
    const patch = { [sc.id]: value };
    // Hatte eine andere Aktion schon diese Taste, verliert sie sie (mit Hinweis)
    const note = $('#shortcut-note');
    note.hidden = true;
    if (value) {
      for (const other of I18N.SHORTCUTS)
        if (other.id !== sc.id && settings.shortcuts[other.id] === value) {
          patch[other.id] = '';
          note.textContent = t('shortcutMoved', { name: t(other.label) });
          note.hidden = false;
        }
    }
    await api.setSettings({ shortcuts: patch });
  };
  window.addEventListener('keydown', onKey, true);
}

function applySettings(next) {
  settings = next;
  t = I18N.make(settings.language);
  // Stil "Minimal": ruhigere Optik (style.css, Regeln unter :root[data-style="minimal"])
  document.documentElement.dataset.style = settings.style || 'standard';
  applySmoke();
  applyTexts();
  render();
  renderDownloads();
  if (settingsModal.open) renderSettings();
}

$('#settings-btn').addEventListener('click', () => {
  $('#shortcut-note').hidden = true;
  renderSettings();
  settingsModal.showModal();
});
$('#settings-close').addEventListener('click', () => settingsModal.close());
$('[data-close-settings]').addEventListener('click', () => settingsModal.close());
$('#language').addEventListener('change', (event) => api.setSettings({ language: event.target.value }));
$('#style').addEventListener('change', (event) => api.setSettings({ style: event.target.value }));
$('#file-icons').addEventListener('change', (event) => api.setSettings({ fileIcons: event.target.value }));
$('#shortcut-reset').addEventListener('click', () => {
  $('#shortcut-note').hidden = true;
  api.setSettings({ resetShortcuts: true });
});
api.onSettings(applySettings);
api.getSettings().then(applySettings);

api.onDownloads((next) => {
  downloadsState = next;
  renderDownloads();
});
api.getDownloads().then((initial) => {
  downloadsState = initial;
  renderDownloads();
});

// ---------------------------------------------------------------- Als Standard-App festlegen
// Gleiche Logik wie in Textline und Picline (src/defaults.js im Hauptprozess). Vorausgewählt ist nur, was kein
// anderes W-Software-Programm schon hat; unter Windows bleibt das Fenster offen und hakt live ab.
const defaultsModal = $('#defaults-modal');
let defaultsTimer = null;
async function openDefaults() {
  const info = await api.defaults.info(settings.language);
  const T = (k, vars = {}) => Object.entries(vars).reduce((s, [a, b]) => s.split(`{${a}}`).join(String(b)), info.texts[k] || k);
  const name = info.name;
  const lang = settings.language;
  const checks = {};
  let state = null;
  const list = $('#defaults-list');
  const note = $('#defaults-note');
  const applyBtn = $('#defaults-apply');
  const closeBtn = $('#defaults-close');
  const win = api.platform === 'win32';
  $('#defaults-title').textContent = T('title');
  $('#defaults-intro').textContent = T('intro', { app: name });
  $('#defaults-how').hidden = !win;
  $('#defaults-how').textContent = T('winHow', { app: name });
  applyBtn.textContent = T(win ? 'openSettings' : 'apply');
  closeBtn.textContent = T('cancel');
  note.textContent = '';
  note.className = 'defaults-note';
  list.replaceChildren(el('p', { className: 'defaults-loading', text: T('loading') }));
  const status = (s) => (s.mine ? T('mine', { app: name }) : s.total > 1 && s.done ? T('part', { n: s.done, m: s.total }) : s.current ? T('now', { app: s.current }) : T('nobody'));
  const pending = () => info.groups.filter((g) => checks[g.id] && !(state.groups.find((x) => x.id === g.id) || {}).mine).map((g) => g.id);
  const render = () => {
    list.replaceChildren(...info.groups.map((g) => {
      const s = state.groups.find((x) => x.id === g.id) || { mine: false };
      if (checks[g.id] === undefined) checks[g.id] = !s.mine && g.primary && !(s.owner && s.owner !== name);
      const box = el('input', { attrs: { type: 'checkbox' } });
      box.checked = s.mine || checks[g.id];
      box.disabled = s.mine;
      box.addEventListener('change', () => {
        checks[g.id] = box.checked;
        applyBtn.disabled = !pending().length;
      });
      const hint = g.exts.map((e) => `.${e}`).join(' ');
      return el('label', { className: `defaults-row${s.mine ? ' mine' : ''}` }, box,
        el('span', { className: 'defaults-name' }, el('b', { text: g.label[lang] || g.label.en }), el('small', { text: hint })),
        el('span', { className: `defaults-now${s.owner && s.owner !== name ? ' owned' : ''}`, text: status(s) }));
    }));
    applyBtn.disabled = !pending().length;
  };
  const refresh = async () => {
    state = await api.defaults.state();
    render();
  };
  applyBtn.onclick = async () => {
    const ids = pending();
    if (!ids.length) return;
    applyBtn.disabled = true;
    if (win && state.registered === '') {
      note.textContent = T('notRegistered', { app: name });
      note.className = 'defaults-note warn';
    }
    const r = await api.defaults.apply(ids);
    if (!r.ok) {
      note.textContent = `${T('failed', { e: r.error || '?' })} ${api.platform === 'darwin' ? T('macHand', { app: name }) : ''}`;
      note.className = 'defaults-note warn';
    } else if (r.settings) {
      closeBtn.textContent = T('close');
      clearInterval(defaultsTimer);
      defaultsTimer = setInterval(() => (defaultsModal.open ? refresh() : clearInterval(defaultsTimer)), 2500);
    } else {
      await refresh();
      note.textContent = T('done', { app: name, n: state.groups.filter((g) => g.mine).length });
      note.className = 'defaults-note ok';
      closeBtn.textContent = T('close');
    }
  };
  closeBtn.onclick = () => defaultsModal.close();
  defaultsModal.onclose = () => clearInterval(defaultsTimer);
  if (settingsModal.open) settingsModal.close();
  defaultsModal.showModal();
  await refresh();
}
$('#defaults-open').addEventListener('click', openDefaults);
window.__openDefaults = openDefaults;
