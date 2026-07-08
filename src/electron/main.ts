import { app, BrowserWindow, dialog, Menu, screen, shell } from 'electron';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type { RunningServer } from '../server/server.js';
import { readAppSettings, writeAppSettings } from '../server/services/appSettingsService.js';
import { readJsonFile, safeWriteJson } from '../server/utils/safeWrite.js';

interface ServerPortState {
  port: number;
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

const DEFAULT_WINDOW_WIDTH = 1180;
const DEFAULT_WINDOW_HEIGHT = 860;
const MIN_WINDOW_WIDTH = 720;
const MIN_WINDOW_HEIGHT = 520;

let mainWindow: BrowserWindow | null = null;
let runningServer: RunningServer | null = null;
let lastWindowState: WindowState | null = null;
let closing = false;
let regenerateShortcutsOnStartup = false;

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    focusMainWindow();
  });

  app.whenReady().then(bootstrap).catch((err) => {
    showStartupError(err);
    app.exit(1);
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (closing || !runningServer) return;

    event.preventDefault();
    closing = true;
    const server = runningServer;
    const timeout = setTimeout(() => {
      app.exit(1);
    }, 5000);

    mainWindow?.webContents.stop();
    Promise.all([saveMainWindowState(), server.close({ force: true })])
      .then(() => {
        clearTimeout(timeout);
        app.exit(0);
      })
      .catch((err) => {
        console.error('[electron] Failed to close server:', err);
        clearTimeout(timeout);
        app.exit(1);
      });
  });
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null);
  await prepareAppSettingsBeforeServer();

  runningServer = await startServerWithPersistedPort();
  await writeServerPort(runningServer.port);
  if (regenerateShortcutsOnStartup) {
    const { regenerateAllShortcuts } = await import('../server/services/shortcutService.js');
    await regenerateAllShortcuts().catch((err) => {
      console.warn('[electron] Failed to regenerate project shortcuts:', err);
    });
  }

  mainWindow = await createMainWindow(runningServer.port);
}

async function prepareAppSettingsBeforeServer(): Promise<void> {
  process.env.YUMEWEAVING_APP_SETTINGS_PATH = path.join(app.getPath('userData'), 'app-settings.json');
  const hadExternalDataDir = Boolean(process.env.YUMEWEAVING_DATA_DIR);
  const settings = await readAppSettings();
  if (!hadExternalDataDir && settings.dataDir) {
    process.env.YUMEWEAVING_DATA_DIR = settings.dataDir;
    process.env.YUMEWEAVING_DATA_DIR_SOURCE = 'app-settings';
  } else if (hadExternalDataDir) {
    process.env.YUMEWEAVING_DATA_DIR_SOURCE = 'external';
  } else {
    process.env.YUMEWEAVING_DATA_DIR_SOURCE = 'default';
  }

  if (!hadExternalDataDir && settings.dataDir && settings.pendingCleanup) {
    await cleanupPendingDataDir(settings.dataDir, settings.pendingCleanup);
    regenerateShortcutsOnStartup = true;
  }
}

async function cleanupPendingDataDir(dataDir: string, pendingCleanup: string): Promise<void> {
  try {
    const stat = await fs.stat(dataDir);
    if (!stat.isDirectory()) return;
    if (
      samePath(dataDir, pendingCleanup) ||
      isPathInside(dataDir, pendingCleanup) ||
      isPathInside(pendingCleanup, dataDir)
    ) {
      return;
    }
    const { copyMissingFiles, verifyManifestForCleanup } = await import(
      '../server/services/dataDirMoveService.js'
    );
    const diff = await verifyManifestForCleanup(pendingCleanup, dataDir);
    if (diff.missingInNew.length > 0) {
      await copyMissingFiles(pendingCleanup, dataDir, diff.missingInNew);
    }
    await fs.rm(pendingCleanup, { recursive: true, force: true });
    const settings = await readAppSettings();
    await writeAppSettings({ ...settings, pendingCleanup: null });
  } catch (err) {
    console.warn('[electron] Pending data cleanup failed:', err);
  }
}

async function startServerWithPersistedPort(): Promise<RunningServer> {
  const { startServer } = await import('../server/server.js');
  const savedPort = await readServerPort();
  try {
    return await startServer({
      host: '127.0.0.1',
      port: savedPort ?? 0,
      onShutdownRequest: () => app.quit(),
      onRestartRequest: restartApp,
      onRuntimeError: (err) => {
        dialog.showErrorBox('Yumeweaving サーバーエラー', err.message);
        app.quit();
      },
    });
  } catch (err) {
    if (savedPort && isPortUnavailable(err)) {
      return startServer({
        host: '127.0.0.1',
        port: 0,
        onShutdownRequest: () => app.quit(),
        onRestartRequest: restartApp,
        onRuntimeError: (runtimeErr) => {
          dialog.showErrorBox('Yumeweaving サーバーエラー', runtimeErr.message);
          app.quit();
        },
      });
    }
    throw err;
  }
}

function restartApp(): void {
  closing = true;
  void saveMainWindowState().finally(() => {
    app.relaunch();
    app.exit(0);
  });
}

async function createMainWindow(serverPort: number): Promise<BrowserWindow> {
  const savedState = await readWindowState();
  const windowOptions = resolveWindowOptions(savedState);
  const win = new BrowserWindow({
    ...windowOptions,
    show: false,
    icon: resolveIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureNavigationGuards(win, serverPort);
  configureSupportShortcuts(win);

  if (savedState?.isMaximized) {
    win.maximize();
  }

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('close', () => {
    lastWindowState = captureWindowState(win);
    void writeWindowStateSnapshot(lastWindowState).catch((err) => {
      console.warn('[electron] Failed to save window state:', err);
    });
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  await win.loadURL(`http://127.0.0.1:${serverPort}`);
  return win;
}

function configureNavigationGuards(win: BrowserWindow, serverPort: number): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url, serverPort)) return { action: 'allow' };
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url, serverPort)) return;
    event.preventDefault();
    void openExternalUrl(url);
  });
}

function configureSupportShortcuts(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (!input.control || input.type !== 'keyDown') return;
    if (input.shift && input.code === 'KeyI') {
      win.webContents.toggleDevTools();
      event.preventDefault();
      return;
    }
    if (!input.shift && input.code === 'KeyR') {
      win.reload();
      event.preventDefault();
    }
  });
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

async function saveMainWindowState(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    lastWindowState = captureWindowState(mainWindow);
  }
  if (!lastWindowState) return;
  try {
    await writeWindowStateSnapshot(lastWindowState);
  } catch (err) {
    console.warn('[electron] Failed to save window state:', err);
  }
}

function resolveWindowOptions(
  state: WindowState | null
): Pick<BrowserWindowConstructorOptions, 'x' | 'y' | 'width' | 'height'> {
  if (!state) {
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  }

  const width = clamp(Math.round(state.width), MIN_WINDOW_WIDTH, 2400);
  const height = clamp(Math.round(state.height), MIN_WINDOW_HEIGHT, 1600);
  const bounds = {
    x: Number.isFinite(state.x) ? Math.round(state.x as number) : undefined,
    y: Number.isFinite(state.y) ? Math.round(state.y as number) : undefined,
    width,
    height,
  };

  if (
    typeof bounds.x === 'number' &&
    typeof bounds.y === 'number' &&
    isWindowVisibleOnAnyDisplay({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    })
  ) {
    return bounds;
  }

  return { width, height };
}

function isWindowVisibleOnAnyDisplay(bounds: Rectangle): boolean {
  const center = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      center.x >= area.x &&
      center.x <= area.x + area.width &&
      center.y >= area.y &&
      center.y <= area.y + area.height
    );
  });
}

async function readServerPort(): Promise<number | null> {
  const state = await readOptionalJson<ServerPortState>(await getServerPortPath());
  if (!state || !Number.isInteger(state.port)) return null;
  return state.port > 0 && state.port <= 65535 ? state.port : null;
}

async function writeServerPort(port: number): Promise<void> {
  await safeWriteJson(await getServerPortPath(), { port });
}

async function getServerPortPath(): Promise<string> {
  const { CONFIG_DIR } = await import('../server/config.js');
  return path.join(CONFIG_DIR, 'server-port.json');
}

async function readWindowState(): Promise<WindowState | null> {
  const state = await readOptionalJson<WindowState>(getWindowStatePath());
  if (!state || !Number.isFinite(state.width) || !Number.isFinite(state.height)) {
    return null;
  }
  return state;
}

function captureWindowState(win: BrowserWindow): WindowState {
  const bounds = win.getNormalBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
  };
}

async function writeWindowStateSnapshot(state: WindowState): Promise<void> {
  await safeWriteJson(getWindowStatePath(), state);
}

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    return await readJsonFile<T>(filePath);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn(`[electron] Ignoring broken config file: ${filePath}`);
      return null;
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function getWindowStatePath(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function resolveIconPath(): string {
  const candidates = [
    path.resolve(app.getAppPath(), 'build', 'icon.ico'),
    path.resolve(process.cwd(), 'build', 'icon.ico'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function isInternalUrl(rawUrl: string, serverPort: number): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port === String(serverPort)
    );
  } catch {
    return false;
  }
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      await shell.openExternal(rawUrl);
    }
  } catch {
    // 不正なURLは無視
  }
}

function isPortUnavailable(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EADDRINUSE' || code === 'EACCES';
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function showStartupError(err: unknown): void {
  const message = isPortUnavailable(err)
    ? '前回使っていたポートを別のアプリが使用しています。Yumeweaving を起動できませんでした。'
    : err instanceof Error
      ? err.message
      : String(err);
  dialog.showErrorBox('Yumeweaving の起動に失敗しました', message);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
