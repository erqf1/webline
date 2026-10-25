'use strict';

// Zeigt Text-Dateien schön an: Markdown als Dokument, JSON eingerückt und farbig, CSV als Tabelle, Rest als Text.
// Den Inhalt liefert der Hauptprozess (viewer-preload.js), die Seite selbst darf keine Dateien lesen.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- Markdown (kleiner, sicherer Umsetzer)
// Alles wird erst maskiert, dann werden nur bekannte Muster zu HTML. Links nur http(s)/mailto/#.
function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_m, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => `<span class="img">[${alt || 'Bild'}]</span>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) =>
      /^(https?:|mailto:|#)/i.test(url) ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : label)
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[+i]}</code>`);
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function markdown(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isBlockStart = (l) => /^(#{1,6}\s|```|~~~|>|\s*([-*+]|\d+[.)])\s|\s*(---|\*\*\*|___)\s*$)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = /^(```|~~~)\s*([\w+-]*)/.exec(line))) {  // Code-Block
      const fence = m[1];
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith(fence); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
    } else if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>');
      i++;
    } else if (line.startsWith('>')) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'))}</blockquote>`);
    } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s/.test(lines[i]); i++) {
        let text = lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
        // Fortsetzungszeilen (eingerückt) gehören zum Punkt
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1])) text += ' ' + lines[++i].trim();
        const task = /^\[([ xX])\]\s+/.exec(text);
        const box = task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}>` : '';
        items.push(`<li>${box}${inline(task ? text.slice(task[0].length) : text)}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(splitRow(lines[i]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && !isBlockStart(lines[i]); i++) body.push(lines[i]);
      if (!body.length) body.push(lines[i++]);
      out.push(`<p>${body.map(inline).join('<br>')}</p>`);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- JSON
function jsonHtml(text) {
  let pretty;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
  return esc(pretty).replace(
    /(&quot;(?:[^&\\]|\\.|&(?!quot;))*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, lit, num) =>
      str ? `<span class="${colon ? 'k' : 's'}">${str}</span>${colon ?? ''}` : lit ? `<span class="b">${lit}</span>` : `<span class="n">${num}</span>`
  );
}

// ---------------------------------------------------------------- CSV
function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvHtml(text) {
  const first = text.split('\n', 1)[0];
  const sep = [';', '\t', ','].reduce((best, s) => (first.split(s).length > first.split(best).length ? s : best), ',');
  const rows = parseCsv(text, sep);
  const LIMIT = 5000;
  const [head = [], ...body] = rows;
  const isNum = (v) => /^\s*-?[\d.,]+\s*%?\s*$/.test(v);
  return `<div class="csv"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${body
    .slice(0, LIMIT)
    .map((r) => `<tr>${r.map((c) => `<td${isNum(c) ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>${body.length > LIMIT ? `<p class="note">… ${body.length - LIMIT} more rows</p>` : ''}`;
}

// ---------------------------------------------------------------- Start
window.viewer.load().then((file) => {
  const doc = document.getElementById('doc');
  if (!file || file.error) {
    doc.innerHTML = `<p>${esc(file?.error ?? 'Error')}</p>`;
    return;
  }
  document.title = file.name;
  const ext = file.ext;
  if (ext === '.md' || ext === '.markdown') {
    doc.classList.add('md');
    doc.innerHTML = markdown(file.text);
  } else if (ext === '.json' && jsonHtml(file.text) != null) {
    doc.innerHTML = `<pre class="plain json">${jsonHtml(file.text)}</pre>`;
  } else if (ext === '.csv') {
    doc.classList.add('wide');
    doc.innerHTML = csvHtml(file.text);
  } else {
    doc.innerHTML = `<pre class="plain">${esc(file.text)}</pre>`;
  }
  if (file.truncated) doc.insertAdjacentHTML('beforeend', `<p class="note">${esc(file.truncated)}</p>`);
});
