'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Eingabefeld "Adresse vorübergehend ändern" (F6) über dem Programmfenster
contextBridge.exposeInMainWorld('urlbar', {
  onShow: (callback) => ipcRenderer.on('urlbar:show', (_event, data) => callback(data)),
  submit: (value) => ipcRenderer.send('urlbar:done', value == null ? null : String(value)),
});
