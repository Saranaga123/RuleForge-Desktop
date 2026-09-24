const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const http = require('http');

// Without this, some Windows setups (VMs, remote desktop sessions, certain
// GPU drivers) render a fully-working DOM but never actually paint it to the
// window, showing a blank white screen. This app is mostly static UI, so
// there's little upside to hardware acceleration versus the reliability cost.
app.disableHardwareAcceleration();

// Dev mode runs straight out of the repo (this file's real location, next to
// the RuleForge backend and RuleForge-Lab frontend). A packaged build instead
// ships the backend and frontend dist as extraResources next to app.asar --
// Electron exposes that folder at runtime as process.resourcesPath, which
// does not exist relative to __dirname once everything is inside the asar.
const BACKEND_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'RuleForge')
  : path.join(__dirname, '..', 'RuleForge');
const BACKEND_ENTRY = path.join(BACKEND_ROOT, 'index.js');
const BACKEND_CWD = BACKEND_ROOT;
const FRONTEND_DIST = app.isPackaged
  ? path.join(process.resourcesPath, 'frontend-dist')
  : path.join(__dirname, '..', 'RuleForge-Lab', 'dist', 'ruleforge');

console.log('BACKEND_ENTRY:', BACKEND_ENTRY);
console.log('BACKEND_CWD:', BACKEND_CWD);
console.log('FRONTEND_DIST:', FRONTEND_DIST);

let backendProcess = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForBackend(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: 'localhost', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time'));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
      req.on('timeout', () => req.destroy());
    };
    tryOnce();
  });
}

// Spawns the RuleForge backend using this same packaged Electron binary
// running in plain-Node mode (ELECTRON_RUN_AS_NODE) -- so the end user never
// needs a separate Node.js install. DESKTOP_MODE tells the backend to skip
// cluster multi-worker mode and just run one instance for a single local user.
function startBackend(port) {
  return new Promise((resolve, reject) => {
    backendProcess = spawn(process.execPath, [BACKEND_ENTRY], {
      cwd: BACKEND_CWD,
      env: {
        ...process.env,
        PORT: String(port),
        DESKTOP_MODE: '1',
        ELECTRON_RUN_AS_NODE: '1',
        FRONTEND_DIST_PATH: FRONTEND_DIST,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    backendProcess.stdout.on('data', (data) => process.stdout.write(`[backend] ${data}`));
    backendProcess.stderr.on('data', (data) => process.stderr.write(`[backend] ${data}`));

    backendProcess.on('exit', (code, signal) => {
      console.log(`Backend process exited (code=${code}, signal=${signal})`);
      backendProcess = null;
    });

    backendProcess.on('error', reject);

    waitForBackend(port, 15000).then(resolve, reject);
  });
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

async function createWindow() {
  let port;
  try {
    port = await getFreePort();
    await startBackend(port);
  } catch (err) {
    dialog.showErrorBox('RuleForge Lab failed to start', String((err && err.stack) || err));
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'RuleForge Lab',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    // Without this, the window's default background is plain white until the
    // page finishes compositing. Matches the app's own dark theme.
    backgroundColor: '#0f172a',
    webPreferences: {
      contextIsolation: true,
    },
  });

  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer console] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (event, code, desc, url) => {
    console.log(`[renderer did-fail-load] ${code} ${desc} ${url}`);
  });

  win.loadURL(`http://localhost:${port}/`);

  if (process.env.RULEFORGE_DEVTOOLS) {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', stopBackend);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
