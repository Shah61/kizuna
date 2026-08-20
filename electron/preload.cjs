const { contextBridge, ipcRenderer } = require('electron');

// The renderer is sandboxed; this is the entire surface it gets.
contextBridge.exposeInMainWorld('kizuna', {
  isDesktop: true,
  loadSettings: () => ipcRenderer.invoke('store:get'),
  saveSettings: (data) => ipcRenderer.invoke('store:set', data),
  appInfo: () => ipcRenderer.invoke('app:info'),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  readAudio: (filePath) => ipcRenderer.invoke('audio:read', filePath),
  audioExists: (filePath) => ipcRenderer.invoke('audio:exists', filePath),
  scanMusic: () => ipcRenderer.invoke('audio:scan'),
  musicFolder: () => ipcRenderer.invoke('audio:music-folder'),
  revealMusicFolder: () => ipcRenderer.invoke('audio:reveal-music-folder'),
});
