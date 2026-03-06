import { app, BrowserWindow, Menu } from 'electron';
import isDev from 'electron-is-dev';
import path from 'path';
import fs from 'fs';

// Emergency logging - write immediately on module load
const emergencyLog = (msg: string) => {
  try {
    const logDir = path.join(process.env.APPDATA || '', 'droneline-planner');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, 'main-process.log');
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (e) {
    // Ignore
  }
};

emergencyLog('Module loaded');

let mainWindow: BrowserWindow | null;

const logMain = (message: string) => {
  try {
    const logDir = app.getPath('userData');
    const logFile = path.join(logDir, 'main-process.log');
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
  } catch {
    try {
      emergencyLog(`logMain fallback: ${message}`);
    } catch {
      // Final fallback - ignore
    }
  }
};

const createWindow = () => {
  logMain('createWindow called');

  const iconPath = isDev
    ? path.join(__dirname, '../public/icon.ico')
    : path.join(process.resourcesPath, 'icon.ico');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Austhai UAV Line planner',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: iconPath,
  });

  // Load the app
  if (isDev) {
    logMain('Loading dev URL http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Production: Try multiple path resolution approaches
    let indexPath: string | null = null;
    
    // Try 1: Using process.resourcesPath (when available)
    if (process.resourcesPath) {
      const p1 = path.join(process.resourcesPath, 'dist', 'index.html');
      if (fs.existsSync(p1)) {
        indexPath = p1;
        logMain(`Found dist via process.resourcesPath: ${p1}`);
      }
    }
    
    // Try 2: Using app.getAppPath() + relative navigation
    if (!indexPath) {
      const basePath = app.getAppPath();
      const p2 = path.join(basePath, '..', 'dist', 'index.html');
      if (fs.existsSync(p2)) {
        indexPath = p2;
        logMain(`Found dist via app.getAppPath(): ${p2}`);
      }
    }
    
    // Try 3: Direct resources folder
    if (!indexPath) {
      const p3 = path.join(app.getPath('exe'), '..', 'resources', 'dist', 'index.html');
      if (fs.existsSync(p3)) {
        indexPath = p3;
        logMain(`Found dist via exe path: ${p3}`);
      }
    }
    
    logMain(`Production load attempt: indexPath=${indexPath || 'NOT FOUND'}`);
    
    if (indexPath) {
      mainWindow.loadFile(indexPath).catch((err: any) => {
        logMain(`Failed to loadFile: ${err.message}`);
        mainWindow?.loadURL('about:blank');
      });
    } else {
      logMain(`ERROR: index.html not found in any location`);
      logMain(`process.resourcesPath: ${process.resourcesPath}`);
      logMain(`app.getAppPath(): ${app.getAppPath()}`);
      logMain(`app.getPath('exe'): ${app.getPath('exe')}`);
      mainWindow.loadURL('about:blank');
    }
  }

  // Ensure window is shown
  mainWindow.once('ready-to-show', () => {
    logMain('Window ready-to-show');
    mainWindow?.show();
    mainWindow?.focus();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logMain('Renderer did-finish-load');
  });

  // Handle load errors
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    logMain(`Renderer did-fail-load code=${errorCode} description=${errorDescription}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logMain(`Renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.on('closed', () => {
    logMain('Main window closed');
    mainWindow = null;
  });

  createMenu();
};

const createMenu = () => {
  const template: any = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Exit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            // Create an about window
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};

// Disable hardware acceleration to fix potential GPU issues
app.disableHardwareAcceleration();

app.on('ready', () => {
  logMain('App ready event');
  createWindow();
});

app.on('window-all-closed', () => {
  logMain('window-all-closed event');
  if (process.platform !== 'darwin') {
    logMain('Quitting app from window-all-closed');
    app.quit();
  }
});

app.on('activate', () => {
  logMain('activate event');
  if (mainWindow === null) {
    createWindow();
  }
});

process.on('uncaughtException', (error) => {
  logMain(`uncaughtException: ${error.stack ?? error.message}`);
});

process.on('unhandledRejection', (reason) => {
  logMain(`unhandledRejection: ${String(reason)}`);
});
