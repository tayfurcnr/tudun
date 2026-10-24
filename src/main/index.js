const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const systemd = require('./systemd');
const remote = require('./remote');

let mainWindow;
let settingsWrite = Promise.resolve();
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function registerIpc() {
  const localOnly = (target) => {
    if (target !== 'local') throw new Error('Remote hosts are read-only. Select This computer to change services.');
  };
  ipcMain.handle('window:control', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !['minimize', 'maximize', 'close'].includes(action)) throw new Error('Invalid window action.');
    if (action === 'minimize') window.minimize();
    if (action === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    if (action === 'close') {
      window.close();
      return { maximized: false };
    }
    return { maximized: window.isMaximized() };
  });
  ipcMain.handle('hosts:check', (_event, host) => remote.checkHost(host));
  ipcMain.handle('hosts:inspect', (_event, host) => remote.inspectHost(host));
  ipcMain.handle('hosts:setup', (_event, token, password) => remote.setupHost(token, password));
  ipcMain.handle('services:list', (_event, target = 'local') => target === 'local' ? systemd.listServices() : remote.listServices(target));
  ipcMain.handle('service:metrics', (_event, unit, target = 'local') => {
    localOnly(target);
    return systemd.serviceMetrics(unit);
  });
  ipcMain.handle('settings:load', async () => {
    try {
      const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
      return {
        favorites: Array.isArray(saved.favorites) ? saved.favorites.filter((unit) => typeof unit === 'string') : [],
        hosts: Array.isArray(saved.hosts) ? saved.hosts.filter((host) => { try { remote.validateHost(host); return true; } catch { return false; } }).slice(0, 20) : [],
        selectedHost: typeof saved.selectedHost === 'string' ? saved.selectedHost : 'local',
        theme: saved.theme === 'light' ? 'light' : 'dark',
        sidebarCollapsed: saved.sidebarCollapsed === true,
        detailsCollapsed: saved.detailsCollapsed === true
      };
    } catch {
      return { favorites: [], hosts: [], selectedHost: 'local', theme: 'dark', sidebarCollapsed: false, detailsCollapsed: false };
    }
  });
  ipcMain.handle('settings:save', (_event, settings) => {
    const safe = {
      favorites: Array.isArray(settings?.favorites) ? settings.favorites.filter((unit) => typeof unit === 'string').slice(0, 1000) : [],
      hosts: Array.isArray(settings?.hosts) ? [...new Set(settings.hosts.filter((host) => { try { remote.validateHost(host); return true; } catch { return false; } }))].slice(0, 20) : [],
      selectedHost: 'local',
      theme: settings?.theme === 'light' ? 'light' : 'dark',
      sidebarCollapsed: settings?.sidebarCollapsed === true,
      detailsCollapsed: settings?.detailsCollapsed === true
    };
    safe.selectedHost = safe.hosts.includes(settings?.selectedHost) ? settings.selectedHost : 'local';
    settingsWrite = settingsWrite.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
      await fs.writeFile(settingsFile(), JSON.stringify(safe, null, 2), { mode: 0o600 });
      return true;
    });
    return settingsWrite;
  });
  ipcMain.handle('service:action', (_event, action, unit, target = 'local') => { localOnly(target); return systemd.serviceAction(action, unit); });
  ipcMain.handle('unit:draft', (_event, unit, target = 'local') => target === 'local' ? systemd.getUnitDraft(unit) : remote.getUnitDraft(target, unit));
  ipcMain.handle('unit:save', (_event, draft, target = 'local', password = '') => target === 'local' ? systemd.saveUnitDraft(draft) : remote.saveUnitDraft(target, draft, password));
  ipcMain.handle('unit:delete', (_event, unit, target = 'local') => { localOnly(target); return systemd.deleteService(unit); });
  ipcMain.handle('logs:history', (_event, unit, range, limit, target = 'local') => target === 'local' ? systemd.readHistory(unit, range, limit) : remote.readHistory(target, unit, range, limit));
  ipcMain.handle('logs:start', (event, unit, limit, target = 'local') => {
    if (target === 'local') systemd.startLogs(unit, event.sender, limit);
    else remote.startLogs(target, unit, event.sender, limit);
    return true;
  });
  ipcMain.handle('logs:stop', () => {
    systemd.stopLogs();
    remote.stopLogs();
    return true;
  });
  ipcMain.handle('logs:export', async (event, content) => {
    if (typeof content !== 'string' || content.length > 8 * 1024 * 1024) throw new Error('Invalid log export size.');
    const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Export logs', defaultPath: 'service-logs.log',
      filters: [{ name: 'Log file', extensions: ['log', 'txt'] }]
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, content, 'utf8');
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    title: 'TUDUN',
    frame: false,
    backgroundColor: '#171411',
    icon: path.join(__dirname, '..', '..', 'assets', 'icons', 'tudun.svg'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== `file://${path.join(__dirname, '..', 'renderer', 'index.html')}`) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    systemd.stopLogs();
    remote.stopLogs();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  systemd.stopLogs();
  remote.stopLogs();
  if (process.platform !== 'darwin') app.quit();
});
