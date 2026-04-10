const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'amux-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { connections: [], lastUrl: '' }; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let mainWindow = null;
let currentUrl = '';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d1117',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    } catch {}
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Show connect page
  showConnectPage();

  return mainWindow;
}

function showConnectPage() {
  const config = loadConfig();
  mainWindow.loadFile(path.join(__dirname, 'connect.html'));
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.send('init-config', config);
  });
}

function connectToServer(url) {
  currentUrl = url.replace(/\/+$/, '');
  const config = loadConfig();
  config.lastUrl = currentUrl;
  // Add to connections if not already there
  if (!config.connections.find(c => c.url.replace(/\/+$/, '') === currentUrl)) {
    const name = (() => {
      try { return new URL(currentUrl).host; } catch { return currentUrl; }
    })();
    config.connections.push({ name, url: currentUrl });
  }
  saveConfig(config);
  loadWithRetry(mainWindow, currentUrl, 0);
}

function loadWithRetry(win, url, attempts) {
  win.loadURL(url).catch(() => {
    if (attempts < 30) {
      setTimeout(() => loadWithRetry(win, url, attempts + 1), 1000);
    } else {
      // Failed to connect — go back to connect page
      showConnectPage();
    }
  });
}

// IPC handlers
ipcMain.on('connect', (event, url) => {
  connectToServer(url);
});

ipcMain.on('remove-connection', (event, url) => {
  const config = loadConfig();
  config.connections = config.connections.filter(c => c.url.replace(/\/+$/, '') !== url.replace(/\/+$/, ''));
  if (config.lastUrl.replace(/\/+$/, '') === url.replace(/\/+$/, '')) config.lastUrl = '';
  saveConfig(config);
  event.reply('init-config', config);
});

ipcMain.on('disconnect', () => {
  showConnectPage();
});

app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }
  // Trust self-signed certificates for localhost / private IPs
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    const h = request.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local') || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(h)) {
      callback(0);
    } else {
      callback(-3);
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
