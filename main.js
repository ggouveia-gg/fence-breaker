const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path     = require('path');
const http     = require('http');
const fs       = require('fs');
const { spawn } = require('child_process');
const license  = require('./license');
const { checkForUpdates } = require('./updater');

let mainWindow, splashWindow, activateWindow;
let relayProcess   = null;
let streamStartTime = null;

// ── Log file ──────────────────────────────────────────────────────────────────

let logStream = null;

function initLogFile() {
  const logDir  = app.getPath('userData');
  const logPath = path.join(logDir, 'fencebreaker.log');
  try {
    const stat = fs.statSync(logPath);
    if (stat.size > 500 * 1024) fs.renameSync(logPath, logPath + '.old');
  } catch {}
  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n${'='.repeat(60)}\n`);
  logStream.write(`FenceBreaker started: ${new Date().toISOString()}\n`);
  logStream.write(`Version: ${app.getVersion()}\n`);
  logStream.write(`${'='.repeat(60)}\n`);
  ipcMain.handle('get-log-path', () => logPath);
  ipcMain.on('open-log-folder', () => shell.showItemInFolder(logPath));
}

function writeLog(line) {
  if (!logStream) return;
  logStream.write(`[${new Date().toISOString()}] ${line}\n`);
}

// ── Relay ─────────────────────────────────────────────────────────────────────

function startRelay() {
  if (relayProcess) return;
  relayProcess = spawn(process.execPath, [path.join(__dirname, 'relay.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  relayProcess.stdout.on('data', d => {
    const msg = d.toString().trim();
    console.log('[relay]', msg);
    writeLog('[relay] ' + msg);
    if (msg.includes('READY')) { setTimeout(connectSSE, 300); startStatusTimer(); }
  });
  relayProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    console.error('[relay-err]', msg);
    writeLog('[relay-err] ' + msg);
  });
  relayProcess.on('close', code => {
    console.warn('[main] relay exited:', code);
    relayProcess = null;
    if (!app.isQuitting) setTimeout(startRelay, 2000);
  });
}

function stopRelay() {
  if (relayProcess) { relayProcess.kill(); relayProcess = null; }
}

function killStale(cb) {
  try { require('child_process').execSync('taskkill /F /IM ffmpeg.exe', { stdio: 'ignore', windowsHide: true }); } catch {}
  setTimeout(cb, 500);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request({
      hostname: '127.0.0.1', port: 9191, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 9191, path: endpoint }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    }).on('error', reject);
  });
}

// ── SSE → renderer ────────────────────────────────────────────────────────────

function connectSSE() {
  const req = http.request({ hostname: '127.0.0.1', port: 9191, path: '/api/events', method: 'GET' }, res => {
    let buf = '';
    res.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
      }
    });
    res.on('end', () => setTimeout(connectSSE, 1000));
  });
  req.on('error', () => setTimeout(connectSSE, 1000));
  req.end();
}

function handleEvent(evt) {
  const { type, data } = evt;
  if (type === 'connected') {
    streamStartTime = Date.now();
    mainWindow?.webContents.send('stream-event', { type: 'connected' });
  } else if (type === 'relaying') {
    mainWindow?.webContents.send('stream-event', { type: 'relaying' });
  } else if (type === 'disconnected') {
    streamStartTime = null;
    mainWindow?.webContents.send('stream-event', { type: 'disconnected' });
  } else if (type === 'delay-updated') {
    mainWindow?.webContents.send('delay-updated', { seconds: data });
  } else if (type === 'destinations-updated') {
    mainWindow?.webContents.send('destinations-updated', { names: data });
  } else if (type === 'destination-error') {
    mainWindow?.webContents.send('destination-error', data);
  } else if (type === 'encoder-detected') {
    mainWindow?.webContents.send('encoder-detected', { name: data });
  } else if (type === 'video-settings-updated') {
    mainWindow?.webContents.send('video-settings-updated', data);
  } else if (type === 'log') {
    mainWindow?.webContents.send('fb-log', data);
  }
}

// ── IPC — relay control ───────────────────────────────────────────────────────

ipcMain.handle('set-destinations', async (_, list) => {
  try { return await apiPost('/api/destinations', list); } catch { return { ok: false }; }
});

ipcMain.handle('set-delay', async (_, { seconds }) => {
  try { return await apiPost('/api/delay', { seconds }); } catch { return { ok: false }; }
});

ipcMain.handle('set-video-settings', async (_, settings) => {
  try { return await apiPost('/api/video-settings', settings); } catch { return { ok: false }; }
});

ipcMain.handle('get-status', async () => {
  try {
    const s = await apiGet('/api/status');
    s.uptime = streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : 0;
    return s;
  } catch { return { ok: false, isReceiving: false, isRelaying: false, delay: 0 }; }
});

function startStatusTimer() {
  setInterval(() => {
    if (streamStartTime) {
      mainWindow?.webContents.send('timer-update', {
        uptime: Math.floor((Date.now() - streamStartTime) / 1000),
      });
    }
  }, 1000);
}

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.on('window-close',    () => { stopRelay(); mainWindow?.close(); });

// ── IPC — license ─────────────────────────────────────────────────────────────

ipcMain.handle('get-app-version', () => app.getVersion());
ipcMain.handle('get-license-status', () => license.getStatus());

ipcMain.handle('activate-license', async (_, key) => {
  const result = await license.activate(key);
  writeLog(`[license] activate attempt: ${result.ok ? 'OK' : result.error}`);
  return result;
});

ipcMain.on('start-trial', () => {
  license.getStatus(); // ensures trialStart is written
  writeLog('[license] trial started');
  if (activateWindow && !activateWindow.isDestroyed()) activateWindow.close();
  showMainWindow();
});

ipcMain.on('activation-done', () => {
  writeLog('[license] activated successfully');
  if (activateWindow && !activateWindow.isDestroyed()) activateWindow.close();
  showMainWindow();
});

const BUY_URL = 'https://buy.stripe.com/dRm4gAgyr8vi0hr5r15gc01';

ipcMain.on('open-buy-page', () => {
  shell.openExternal(BUY_URL);
});

// ── IPC — updater ─────────────────────────────────────────────────────────────

ipcMain.handle('check-update', async () => {
  return await checkForUpdates(app.getVersion());
});

ipcMain.on('open-update-page', (_, url) => {
  shell.openExternal(url || BUY_URL);
});

// ── Windows ───────────────────────────────────────────────────────────────────

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 380, height: 260, frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'src', 'splash.html'));
  splashWindow.center();
}

function createActivateWindow() {
  activateWindow = new BrowserWindow({
    width: 500, height: 620, frame: false, resizable: false,
    backgroundColor: '#0a0a0f', center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  activateWindow.loadFile(path.join(__dirname, 'src', 'activate.html'));
  activateWindow.on('closed', () => { activateWindow = null; });
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show(); mainWindow.focus();
    // Send license status to renderer for banners
    const status = license.getStatus();
    mainWindow.webContents.send('license-status', status);
    return;
  }
  mainWindow = new BrowserWindow({
    width: 900, height: 620, minWidth: 800, minHeight: 540,
    show: false, frame: false, backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    icon: path.join(__dirname, 'build', 'icon.png'),
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow.show(); mainWindow.focus();
    const status = license.getStatus();
    writeLog(`[license] status: ${JSON.stringify(status)}`);
    mainWindow.webContents.send('license-status', status);
    // Check for updates after window loads (non-blocking)
    setTimeout(async () => {
      const update = await checkForUpdates(app.getVersion());
      if (update) mainWindow?.webContents.send('update-available', update);
    }, 3000);
    // Re-validate license weekly (silently)
    setInterval(async () => {
      if (!license.getStatus().licensed) return;
      const valid = await license.silentValidate();
      if (!valid) mainWindow?.webContents.send('license-status', license.getStatus());
    }, 7 * 24 * 60 * 60 * 1000);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── App startup ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  initLogFile();
  killStale(() => {
    startRelay();
    createSplash();

    // Check license — decide whether to show activate or main window
    setTimeout(() => {
      const status = license.getStatus();
      writeLog(`[license] startup check: ${JSON.stringify(status)}`);

      if (status.licensed || !status.trialExpired) {
        // Licensed OR trial still active → go straight to main
        showMainWindow();
      } else {
        // Trial expired, no license → show activation window
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
        createActivateWindow();
      }
    }, 2000); // let splash show briefly
  });
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => {
  stopRelay();
  if (process.platform !== 'darwin') app.quit();
});
