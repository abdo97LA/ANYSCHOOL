/**
 * UniTimetable — preload (contextBridge). Aucune API Node.js ni commande système n'est exposée aux pages.
 * Configuration de l'adresse : acceptée par le processus principal uniquement depuis src/setup.html.
 * Gestion du serveur local : canaux fixes, sans paramètre de commande ; le processus principal vérifie
 * à chaque appel que l'utilisateur est Administrateur.
 */
const { contextBridge, ipcRenderer } = require('electron');
const on = (ch, cb) => { const f = (_, v) => cb(v); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  info: () => ipcRenderer.invoke('app:info'),
  openSettings: () => ipcRenderer.send('app:settings'),
  testServer: url => ipcRenderer.invoke('setup:test', String(url || '')),
  saveServer: url => ipcRenderer.invoke('setup:save', String(url || '')),
  openServer: () => ipcRenderer.invoke('setup:open'),
  serverControl: {
    available: () => ipcRenderer.invoke('srv:available'),
    login: (username, password) => ipcRenderer.invoke('srv:login', String(username || ''), String(password || '')),
    logout: () => ipcRenderer.invoke('srv:logout'),
    status: () => ipcRenderer.invoke('srv:status'),
    start: () => ipcRenderer.invoke('srv:start'),
    stop: () => ipcRenderer.invoke('srv:stop'),
    restart: () => ipcRenderer.invoke('srv:restart'),
    openLogs: () => ipcRenderer.invoke('srv:openLogs'),
    openLogFolder: () => ipcRenderer.invoke('srv:openLogFolder'),
    chooseFolder: () => ipcRenderer.invoke('srv:chooseFolder'),
    logInit: () => ipcRenderer.invoke('srv:logInit'),
    onStatus: cb => on('srv:status', cb),
    onLog: cb => on('srv:log', cb)
  }
});
