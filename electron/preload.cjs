// Minimal, sandboxed preload. Exposes ONLY window controls, app info (incl. the /api token), the two
// desktop preferences and "copy an amount" - no Node, no generic IPC.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('mc:app-info') || {};

contextBridge.exposeInMainWorld('finora', {
  isDesktop: true,
  version: String(info.version || ''),
  platform: String(info.platform || ''),
  // Second factor for /api (X-Finora, see server/config.js). Only our own window gets it (main
  // checks the sender); it lives in memory only.
  apiToken: String(info.apiToken || ''),
  window: {
    minimize: () => ipcRenderer.send('mc:win', 'minimize'),
    toggleMaximize: () => ipcRenderer.send('mc:win', 'toggleMaximize'),
    close: () => ipcRenderer.send('mc:win', 'close'), // follows the "close to tray" preference
    isMaximized: () => ipcRenderer.invoke('mc:win-is-maximized'),
    onMaximizedChange: (cb) => {
      if (typeof cb !== 'function') return () => {};
      const listener = (_event, value) => cb(value === true);
      ipcRenderer.on('mc:maximized-changed', listener);
      return () => ipcRenderer.removeListener('mc:maximized-changed', listener);
    },
  },
  // "Copy amount": main validates the sender and that the text is a short amount (clipboard-rule.mjs).
  clipboard: {
    writeText: (text) => (typeof text === 'string' && text.length <= 64
      ? ipcRenderer.invoke('mc:clipboard-write', text) : Promise.resolve(false)),
  },
  // Addition: desktop-only preferences (also available from the tray menu).
  settings: {
    get: () => ipcRenderer.invoke('mc:settings-get'),
    set: (patch) => ipcRenderer.invoke('mc:settings-set', {
      closeToTray: typeof patch?.closeToTray === 'boolean' ? patch.closeToTray : undefined,
      openAtLogin: typeof patch?.openAtLogin === 'boolean' ? patch.openAtLogin : undefined,
    }),
  },
});
