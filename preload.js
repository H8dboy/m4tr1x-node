/**
 * M4TR1X - Preload Script
 * Secure bridge between the frontend (renderer) and Electron main process.
 * Exposes ONLY the necessary functions — nothing more.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('m4tr1x_native', {
  getVersion:      () => ipcRenderer.invoke('get-app-version'),
  getPlatform:     () => ipcRenderer.invoke('get-platform'),
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  getTorStatus:    () => ipcRenderer.invoke('get-tor-status'),
  getNodeConfig:   () => ipcRenderer.invoke('get-node-config'),
  isElectron:      true,
})
