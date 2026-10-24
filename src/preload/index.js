const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serviceManager', Object.freeze({
  checkHost: (host) => ipcRenderer.invoke('hosts:check', host),
  listServices: (target) => ipcRenderer.invoke('services:list', target),
  serviceMetrics: (unit, target) => ipcRenderer.invoke('service:metrics', unit, target),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  serviceAction: (action, unit, target) => ipcRenderer.invoke('service:action', action, unit, target),
  getUnitDraft: (unit, target) => ipcRenderer.invoke('unit:draft', unit, target),
  saveUnitDraft: (draft, target, password) => ipcRenderer.invoke('unit:save', draft, target, password),
  deleteService: (unit, target) => ipcRenderer.invoke('unit:delete', unit, target),
  readHistory: (unit, range, limit, target) => ipcRenderer.invoke('logs:history', unit, range, limit, target),
  exportLogs: (content) => ipcRenderer.invoke('logs:export', content),
  startLogs: (unit, limit, target) => ipcRenderer.invoke('logs:start', unit, limit, target),
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
