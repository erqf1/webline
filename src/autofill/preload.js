'use strict';

// Passwort-Autofill für Web-Programme. Läuft als Preload in der isolierten Welt: Die Seite sieht diese
// Funktionen nicht und kann sie nicht verändern. Welche Seite fragt, bestimmt der Hauptprozess selbst
// (Origin des Frames) - nicht diese Datei.
//  - Anmelden (Formular absenden, Enter im Passwortfeld, Klick auf den Anmelde-Knopf): Benutzer + Passwort
//    gehen an den Hauptprozess, der fragt, ob gespeichert werden soll.
//  - Feld anklicken: kleine Auswahl der gespeicherten Konten unter dem Feld; erst ein Klick darauf füllt aus.
//    Nichts wird ungefragt in die Seite geschrieben.

const { ipcRenderer } = require('electron');

const USER_TYPES = new Set(['text', 'email', 'tel', '']);
const visible = (el) => {
  if (!el || el.disabled || el.readOnly) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
const isPassword = (el) => el instanceof HTMLInputElement && el.type === 'password';
const isUserLike = (el) => el instanceof HTMLInputElement && USER_TYPES.has(el.type) && !/one-time-code/i.test(el.autocomplete);

/** Passwortfelder in der Nähe (gleiches Formular, sonst ganze Seite) */
function passwordFields(scope) {
  return [...(scope ?? document).querySelectorAll('input[type=password]')].filter(visible);
}

/** Benutzerfeld zu einem Passwortfeld: autocomplete=username, sonst das letzte Textfeld davor */
function userFieldFor(pw) {
  const scope = pw.form ?? document;
  const inputs = [...scope.querySelectorAll('input')].filter((i) => isUserLike(i) && visible(i));
  const tagged = inputs.find((i) => /username|email/i.test(i.autocomplete));
  if (tagged) return tagged;
  let best = null;
  for (const i of inputs) if (i.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) best = i;
  return best;
}

/** Zum Feld gehöriges Passwortfeld (für Benutzerfelder: das nächste danach) */
function passwordFor(el) {
  if (isPassword(el)) return el;
  const fields = passwordFields(el.form ?? document);
  return fields.find((p) => el.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) ?? null;
}

// ---------------------------------------------------------------- Anmeldung merken

let lastSent = '';
function capture(pw) {
  if (!pw || !pw.value) return;
  // Bei Registrierung/Passwortänderung mit Wiederholung: das neue Passwort (letztes ausgefülltes Feld)
  const fields = passwordFields(pw.form ?? document).filter((f) => f.value);
  const chosen = fields.find((f) => /new-password/i.test(f.autocomplete)) ?? fields.at(-1) ?? pw;
  const user = userFieldFor(fields[0] ?? pw);
  const username = (user?.value ?? '').trim();
  const key = `${username}\n${chosen.value}`;
  if (key === lastSent) return;
  lastSent = key;
  ipcRenderer.send('autofill:captured', { username, password: chosen.value });
}

document.addEventListener('submit', (event) => {
  const pw = passwordFields(event.target).find((f) => f.value);
  if (pw) capture(pw);
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && isPassword(event.target)) capture(event.target);
}, true);
// Seiten ohne echtes Formular (Single-Page-Apps): Klick auf einen Knopf in der Nähe eines ausgefüllten Passwortfelds
document.addEventListener('click', (event) => {
  const button = event.target instanceof Element && event.target.closest('button, input[type=submit], input[type=button], [role=button]');
  if (!button) return;
  const scope = button.closest('form') ?? document;
  const pw = passwordFields(scope).find((f) => f.value);
  if (pw) capture(pw);
}, true);

// ---------------------------------------------------------------- Auswahl unter dem Feld

let popup = null;
let field = null;
let choices = [];
let active = -1;
let filling = false; // beim Ausfüllen löst focus() sonst gleich wieder die Auswahl aus

const CSS = `
  :host { all: initial; position: fixed; z-index: 2147483647; }
  .list { min-width: 220px; max-width: 360px; padding: 4px; border-radius: 10px; background: #ffffff; color: #1c1f2e;
    font: 13px/1.35 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
    box-shadow: 0 10px 30px rgb(30 35 70 / 0.22), 0 0 0 1px rgb(30 35 70 / 0.1); }
  @media (prefers-color-scheme: dark) {
    .list { background: #171a23; color: #e8eaf2; box-shadow: 0 10px 30px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.08); }
    .item small { color: #8b91a7; } .item.active, .item:hover { background: #1f2331; }
  }
  .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 7px 10px; border: 0; border-radius: 7px;
    background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .item.active, .item:hover { background: #f0f1fa; }
  .key { flex: none; width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; background: #6366f1; }
  .key svg { width: 15px; height: 15px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .text { min-width: 0; display: flex; flex-direction: column; }
  .text b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item small { color: #6b7188; font-size: 11.5px; }
`;

function hide() {
  popup?.remove();
  popup = null;
  field = null;
  choices = [];
  active = -1;
}

function place() {
  if (!popup || !field) return;
  const r = field.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > innerHeight) return hide();
  const below = r.bottom + 4;
  popup.style.left = `${Math.max(4, Math.min(r.left, innerWidth - 240))}px`;
  popup.style.top = `${below + 120 > innerHeight && r.top > 130 ? r.top - 4 - popup.offsetHeight : below}px`;
  popup.style.minWidth = `${Math.round(Math.min(r.width, 360))}px`;
}

function highlight(i) {
  active = i;
  popup?.shadowRootRef.querySelectorAll('.item').forEach((n, k) => n.classList.toggle('active', k === i));
}

async function choose(i) {
  const target = field;
  const choice = choices[i];
  hide();
  if (!target || !choice) return;
  const cred = await ipcRenderer.invoke('autofill:fill', choice.id);
  if (!cred) return;
  const pw = passwordFor(target);
  const user = pw ? userFieldFor(pw) : isPassword(target) ? null : target;
  filling = true;
  try {
    setValue(user, cred.username);
    setValue(pw, cred.password);
  } finally {
    filling = false;
  }
  lastSent = `${cred.username}\n${cred.password}`; // nicht gleich wieder "speichern?" fragen
}

/** Wert so setzen, dass auch React/Vue & Co. die Änderung mitbekommen */
function setValue(el, value) {
  if (!el || value == null) return;
  el.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function offer(el) {
  if (filling || (el === field && popup)) return;
  const pw = passwordFor(el);
  if (!pw || /new-password/i.test(pw.autocomplete) && passwordFields(pw.form ?? document).length > 1) return hide();
  const list = await ipcRenderer.invoke('autofill:list');
  if (document.activeElement !== el || !Array.isArray(list) || !list.length) return hide();
  hide();
  field = el;
  choices = list;
  const host = document.createElement('webline-autofill');
  const root = host.attachShadow({ mode: 'closed' });
  host.shadowRootRef = root;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  const box = document.createElement('div');
  box.className = 'list';
  list.forEach((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'item';
    b.tabIndex = -1;
    const key = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    key.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M14.5 4a5.5 5.5 0 1 1-4.9 8L4 17.6V20h2.6l.9-.9v-1.6h1.6l1-1v-1.6h1.6l.8-.8A5.5 5.5 0 1 1 14.5 4zM16 7.5h.01');
    key.append(p);
    const k = document.createElement('span');
    k.className = 'key';
    k.append(key);
    const text = document.createElement('span');
    text.className = 'text';
    const name = document.createElement('b');
    name.textContent = c.username || c.noUser;
    const dots = document.createElement('small');
    dots.textContent = '••••••••';
    text.append(name, dots);
    b.append(k, text);
    // mousedown statt click: das Feld behält den Fokus
    b.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.isTrusted) choose(i);
    });
    box.append(b);
  });
  root.append(box);
  (document.body ?? document.documentElement).append(host);
  popup = host;
  place();
}

document.addEventListener('focusin', (event) => {
  const el = event.target;
  if (isPassword(el) || (isUserLike(el) && passwordFor(el))) offer(el);
  else if (popup && el !== field) hide();
}, true);
document.addEventListener('mousedown', (event) => {
  if (!event.isTrusted) return;
  const el = event.target;
  if (popup && event.composedPath().includes(popup)) return;
  if (el === field) return;
  if (isPassword(el) || (isUserLike(el) && passwordFor(el))) setTimeout(() => offer(el), 0);
  else hide();
}, true);
document.addEventListener('focusout', (event) => {
  if (event.target === field) setTimeout(() => document.activeElement !== field && hide(), 120);
}, true);
// Nur echte Eingaben des Nutzers: Die Seite könnte sonst selbst ↓ + Enter auslösen und mitlesen.
document.addEventListener('keydown', (event) => {
  if (!event.isTrusted || !popup || event.target !== field) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const n = choices.length;
    highlight(event.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
  } else if (event.key === 'Enter' && active >= 0) {
    event.preventDefault();
    event.stopPropagation();
    choose(active);
  } else if (event.key === 'Escape') {
    hide();
  } else if (event.key.length === 1 || event.key === 'Backspace') {
    hide(); // tippt selbst
  }
}, true);
addEventListener('scroll', place, true);
addEventListener('resize', place);
