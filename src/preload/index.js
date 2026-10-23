const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serviceManager', Object.freeze({
  listServices: () => ipcRenderer.invoke('services:list'),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  serviceAction: (action, unit) => ipcRenderer.invoke('service:action', action, unit),
  getUnitDraft: (unit) => ipcRenderer.invoke('unit:draft', unit),
  saveUnitDraft: (draft) => ipcRenderer.invoke('unit:save', draft),
  deleteService: (unit) => ipcRenderer.invoke('unit:delete', unit),
  readHistory: (unit, range, limit) => ipcRenderer.invoke('logs:history', unit, range, limit),
  exportLogs: (content) => ipcRenderer.invoke('logs:export', content),
  startLogs: (unit, limit) => ipcRenderer.invoke('logs:start', unit, limit),
  stopLogs: () => ipcRenderer.invoke('logs:stop'),
  onLogLine: (callback) => {
    const listener = (_event, line) => callback(line);
    ipcRenderer.on('logs:line', listener);
    return () => ipcRenderer.removeListener('logs:line', listener);
  },
  onLogsEnded: (callback) => {
    const listener = (_event, code) => callback(code);
    ipcRenderer.on('logs:ended', listener);
    return () => ipcRenderer.removeListener('logs:ended', listener);
  }
}));
