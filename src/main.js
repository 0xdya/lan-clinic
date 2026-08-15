/**
 * main.js - Electron Main Process
 * Entry point for the LAN Clinic application.
 * Manages BrowserWindow creation, IPC, and spawns server processes.
 */

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const os = require('os');

// Keep a global reference to prevent garbage collection
let mainWindow = null;
let serverProcess = null;

// ─────────────────────────────────────────────
// Dev Mode Flag
// ─────────────────────────────────────────────
const isDev = process.argv.includes('--dev') || !app.isPackaged;

// ─────────────────────────────────────────────
// Get LAN IP Address
// ─────────────────────────────────────────────
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ─────────────────────────────────────────────
// Create Main Window
// ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    backgroundColor: '#F8FAFC', // Slate-50
    titleBarStyle: 'default',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    show: false, // Show once ready
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
  });

  // Build minimal application menu
  const template = [
    {
      label: 'Application',
      submenu: [
        { label: 'About LAN Clinic', role: 'about' },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' },
        ...(isDev ? [{ label: 'Dev Tools', role: 'toggleDevTools' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────
// IPC Handlers
// ─────────────────────────────────────────────

/**
 * IPC: Start server (Doctor / Host Mode)
 * Spawns the Express + Socket.io server as a child process.
 */
ipcMain.handle('server:start', async (_event) => {
  if (serverProcess) {
    return { success: true, ip: getLanIp(), port: 3000 };
  }

  return new Promise((resolve) => {
    const serverPath = path.join(__dirname, 'server', 'index.js');

    // Use the app's user data path for the database in production
    const dbPath = app.isPackaged
      ? path.join(app.getPath('userData'), 'clinic.db')
      : path.join(__dirname, '..', 'data', 'clinic.db');

    serverProcess = fork(serverPath, [], {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        PORT: '3000',
        NODE_ENV: isDev ? 'development' : 'production',
      },
      silent: true,
    });

    serverProcess.on('message', (msg) => {
      if (msg.type === 'SERVER_READY') {
        resolve({ success: true, ip: getLanIp(), port: msg.port });
      } else if (msg.type === 'SERVER_ERROR') {
        resolve({ success: false, error: msg.error });
      }
    });

    serverProcess.stdout.on('data', (data) => {
      if (isDev) console.log('[Server]', data.toString().trim());
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Error]', data.toString().trim());
    });

    serverProcess.on('exit', (code) => {
      if (isDev) console.log('[Server] Process exited with code:', code);
      serverProcess = null;
    });

    // Safety timeout
    setTimeout(() => {
      resolve({ success: false, error: 'Server startup timed out.' });
    }, 10000);
  });
});

/**
 * IPC: Stop server
 */
ipcMain.handle('server:stop', async () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  return { success: true };
});

/**
 * IPC: Get system info (IP address, hostname)
 */
ipcMain.handle('system:info', () => {
  return {
    ip: getLanIp(),
    hostname: os.hostname(),
    platform: os.platform(),
  };
});

/**
 * IPC: Show native error dialog
 */
ipcMain.handle('dialog:error', (_event, { title, message }) => {
  dialog.showErrorBox(title || 'Error', message || 'An unexpected error occurred.');
});

// ─────────────────────────────────────────────
// App Lifecycle
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
