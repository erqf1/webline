'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Der Betrachter bekommt nur den Inhalt "seiner" Datei - welche das ist, weiß der Hauptprozess.
contextBridge.exposeInMainWorld('viewer', {
  load: () => ipcRenderer.invoke('viewer:text'),
});
