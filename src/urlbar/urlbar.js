'use strict';

const $ = (s) => document.querySelector(s);
const input = $('#url');
let open = false;

function done(value) {
  if (!open) return;
  open = false;
  window.urlbar.submit(value);
}

window.urlbar.onShow(({ url, texts, dark }) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#title').textContent = texts.title;
  $('#hint').textContent = texts.hint;
  $('#go').textContent = texts.go;
  $('#esc').textContent = texts.esc;
  input.value = url || '';
  open = true;
  input.focus();
  input.select();
});

$('#box').addEventListener('submit', (event) => {
  event.preventDefault();
  if (input.value.trim()) done(input.value.trim());
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    done(null);
  }
});
// Klick neben das Feld schließt
$('#bg').addEventListener('mousedown', (event) => {
  if (event.target === $('#bg')) done(null);
});
