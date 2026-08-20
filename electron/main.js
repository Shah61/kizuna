import { app, BrowserWindow, ipcMain, shell, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

/*
 * Do NOT disable vsync or the frame-rate limit here. Doing so makes Chromium
 * rasterise as fast as it can — often past a thousand frames a second — which
 * exhausts the compositor's tile memory and floods the log with
 * "tile memory limits exceeded, some content may not draw".
 *
 * It also buys nothing: every timing decision in this game is derived from
 * AudioContext.currentTime (see conductor.ts), not from frame pacing, so
 * rendering at the display's refresh rate is exactly right.
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** Persisted settings live next to the app's user data, not in the bundle. */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[store] write failed', err);
    return false;
  }
}

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: Math.min(1440, Math.round(sw * 0.9)),
    height: Math.min(900, Math.round(sh * 0.9)),
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#07060a',
    show: false,
    autoHideMenuBar: true,
    title: 'Kizuna Blade',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win?.show());

  // Keep navigation inside the app; open real links in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const current = win?.webContents.getURL() ?? '';
    if (url !== current) event.preventDefault();
  });

  if (isDev) {
    win.loadURL('http://localhost:5273');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.on('closed', () => {
    win = null;
  });
}

ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (_e, data) => writeStore(data));
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
}));
// Playable music comes exclusively from content/music and must be MP3.
const AUDIO_EXTENSIONS = ['mp3'];

/**
 * Music the build ships with. In a packaged app this lives beside the app
 * resources; in development it is the repo's own content folder.
 */
function bundledMusicDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'content', 'music')
    : path.join(__dirname, '..', 'content', 'music');
}

async function listAudioIn(dir, source) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .filter((e) => AUDIO_EXTENSIONS.includes(path.extname(e.name).slice(1).toLowerCase()))
      .map((e) => ({
        path: path.join(dir, e.name),
        name: path.basename(e.name, path.extname(e.name)),
        source,
      }));
  } catch {
    return [];
  }
}

/** The shipped content/music folder is the entire playable music library. */
ipcMain.handle('audio:scan', async () => {
  return listAudioIn(bundledMusicDir(), 'music-folder');
});

ipcMain.handle('audio:music-folder', async () => {
  return bundledMusicDir();
});

ipcMain.handle('audio:reveal-music-folder', async () => {
  const dir = bundledMusicDir();
  shell.openPath(dir);
  return dir;
});

/**
 * Read one audio file as raw bytes. Only files with a known audio extension
 * are served, so a stray path from the renderer cannot pull arbitrary files.
 */
ipcMain.handle('audio:read', async (_e, filePath) => {
  if (typeof filePath !== 'string') throw new Error('bad path');
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!AUDIO_EXTENSIONS.includes(ext)) throw new Error(`unsupported file type: .${ext}`);
  const buf = await fs.promises.readFile(filePath);
  // Hand over a plain ArrayBuffer so the renderer can decodeAudioData it.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

/** Does a previously-imported file still exist where we left it? */
ipcMain.handle('audio:exists', async (_e, filePath) => {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('window:toggle-fullscreen', () => {
  if (!win) return false;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  return next;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
