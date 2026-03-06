import { app, BrowserWindow, Menu } from 'electron';
import path from 'path';
import fs from 'fs';

// Use Electron's built-in packaged check instead of external dependency.
const isDev = !app.isPackaged;

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
    // Temp: Open devtools in production to debug UI issues
    mainWindow.webContents.openDevTools();
    
    // Production: Try multiple path resolution approaches with extensive diagnostics
    let indexPath: string | null = null;
    
    const pathCandidates = [];
    
    // Try 1: Using asarUnpack resources (dist is unpacked to app.asar.unpacked/dist)
    if (process.resourcesPath) {
      const unpackedDir = path.join(process.resourcesPath, 'app.asar.unpacked');
      const distDir = path.join(unpackedDir, 'dist');
      const p1 = path.join(distDir, 'index.html');
      pathCandidates.push(p1);
      logMain(`[Try 1] asarUnpack path: ${p1}`);
      if (fs.existsSync(unpackedDir)) {
        logMain(`  ✓ asarUnpack dir exists`);
        if (fs.existsSync(distDir)) {
          logMain(`  ✓ dist dir exists`);
          if (fs.existsSync(p1)) {
            logMain(`  ✓ index.html found!`);
            indexPath = p1;
          }
        } else {
          const unpackedContents = fs.readdirSync(unpackedDir).slice(0, 20);
          logMain(`  ✗ dist not found. asarUnpack contains: ${unpackedContents.join(', ')}`);
        }
      } else {
        logMain(`  ✗ asarUnpack dir does not exist`);
      }
    }
    
    // Try 2: Direct resources dist folder (for alternate packaging)
    if (!indexPath && process.resourcesPath) {
      const p2 = path.join(process.resourcesPath, 'dist', 'index.html');
      pathCandidates.push(p2);
      logMain(`[Try 2] Direct resources dist: ${p2}`);
      if (fs.existsSync(p2)) {
        logMain(`  ✓ Found`);
        indexPath = p2;
      } else {
        const resourcesContents = fs.readdirSync(process.resourcesPath).slice(0, 10);
        logMain(`  ✗ Not found. Resources dir contains: ${resourcesContents.join(', ')}`);
      }
    }
    
    // Try 3: Using app.getAppPath() + relative navigation through app.asar
    if (!indexPath) {
      const basePath = app.getAppPath();
      const asarUnpackedPath = path.join(basePath, 'app.asar.unpacked', 'dist', 'index.html');
      pathCandidates.push(asarUnpackedPath);
      logMain(`[Try 3] app.asar.unpacked from getAppPath: ${asarUnpackedPath}`);
      if (fs.existsSync(asarUnpackedPath)) {
        logMain(`  ✓ Found`);
        indexPath = asarUnpackedPath;
      } else {
        logMain(`  ✗ Not found`);
      }
    }
    
    // Try 4: Relative path from asar
    if (!indexPath) {
      const basePath = app.getAppPath();
      const p4 = path.join(basePath, '..', 'dist', 'index.html');
      pathCandidates.push(p4);
      logMain(`[Try 4] Relative from getAppPath: ${p4}`);
      if (fs.existsSync(p4)) {
        logMain(`  ✓ Found`);
        indexPath = p4;
      } else {
        logMain(`  ✗ Not found`);
      }
    }
    
    // Try 5: Direct exe path
    if (!indexPath) {
      const p5 = path.join(app.getPath('exe'), '..', 'resources', 'dist', 'index.html');
      pathCandidates.push(p5);
      logMain(`[Try 5] From exe path: ${p5}`);
      if (fs.existsSync(p5)) {
        logMain(`  ✓ Found`);
        indexPath = p5;
      } else {
        logMain(`  ✗ Not found`);
      }
    }
    
    // Try 6: From app directory (common for installed apps)
    if (!indexPath) {
      const appDir = path.dirname(app.getPath('exe'));
      const p6 = path.join(appDir, 'resources', 'app.asar.unpacked', 'dist', 'index.html');
      pathCandidates.push(p6);
      logMain(`[Try 6] From app dir: ${p6}`);
      if (fs.existsSync(p6)) {
        logMain(`  ✓ Found`);
        indexPath = p6;
      } else {
        logMain(`  ✗ Not found`);
      }
    }
    
    logMain(`=== Production load attempt: indexPath=${indexPath || 'NOT FOUND'} ===`);
    
    if (indexPath) {
      // Convert file path to file:// URL, properly handling Windows paths
      const fileUrl = `file://${path.resolve(indexPath).replace(/\\/g, '/')}`;
      logMain(`Loading URL: ${fileUrl}`);
      mainWindow.loadURL(fileUrl).catch((err: any) => {
        logMain(`✗ Failed to loadURL("${fileUrl}"): ${err.message}`);
        if (fs.existsSync(indexPath)) {
          const stats = fs.statSync(indexPath);
          logMain(`  File exists. Size: ${stats.size} bytes, mtime: ${stats.mtime}`);
        }
        logMain(`Falling back to about:blank`);
        mainWindow?.loadURL('about:blank');
      });
    } else {
      logMain(`✗ CRITICAL: index.html not found in ANY location`);
      logMain(`Tried paths:`);
      pathCandidates.forEach((p, i) => logMain(`  ${i + 1}. ${p}`));
      logMain(`=== Directory Diagnostics ===`);
      logMain(`process.resourcesPath: ${process.resourcesPath}`);
      logMain(`app.getAppPath(): ${app.getAppPath()}`);
      logMain(`app.getPath('exe'): ${app.getPath('exe')}`);
      try {
        const exeDir = path.dirname(app.getPath('exe'));
        const exeDirContents = fs.readdirSync(exeDir).slice(0, 15);
        logMain(`exe dir contents: ${exeDirContents.join(', ')}`);
      } catch (e) {
        logMain(`Failed to read exe dir: ${e}`);
      }
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
