/**
 * preload.js - Electron Preload Script
 * Safely exposes a controlled API from the main process to the renderer
 * via contextBridge. No raw Node.js APIs are exposed to the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Server Control ──────────────────────────────────────────────
  /** Start the local Express + Socket.io server (Doctor/Host mode) */
  startServer: () => ipcRenderer.invoke('server:start'),

  /** Stop the local server */
  stopServer: () => ipcRenderer.invoke('server:stop'),

  // ── System Information ──────────────────────────────────────────
  /** Get LAN IP, hostname, platform */
  getSystemInfo: () => ipcRenderer.invoke('system:info'),

  // ── Native Dialogs ───────────────────────────────────────────────
  /** Show a native error dialog box */
  showError: (title, message) => ipcRenderer.invoke('dialog:error', { title, message }),
});
