import path from 'node:path';
import { homedir } from 'node:os';
import { readJsonFile, safeWriteJson } from '../utils/safeWrite.js';
import { withDataDirWrite } from './dataDirLock.js';

export interface AppSettings {
  dataDir?: string;
  pendingCleanup?: string | null;
  setupModel?: {
    provider?: string;
    modelName?: string;
  };
}

export function getAppSettingsPath(): string {
  if (process.env.YUMEWEAVING_APP_SETTINGS_PATH) {
    return path.resolve(process.env.YUMEWEAVING_APP_SETTINGS_PATH);
  }
  const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Yumeweaving', 'app-settings.json');
}

export async function readAppSettings(): Promise<AppSettings> {
  try {
    const settings = await readJsonFile<AppSettings>(getAppSettingsPath());
    return normalizeAppSettings(settings);
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.warn('[app-settings] Ignoring broken app-settings.json', {
        path: getAppSettingsPath(),
      });
      return {};
    }
    throw err;
  }
}

export async function writeAppSettings(settings: AppSettings): Promise<void> {
  await safeWriteJson(getAppSettingsPath(), normalizeAppSettings(settings));
}

export async function updateAppSettings(
  update: (settings: AppSettings) => AppSettings | Promise<AppSettings>
): Promise<AppSettings> {
  return withDataDirWrite(async () => {
    const next = normalizeAppSettings(await update(await readAppSettings()));
    await safeWriteJson(getAppSettingsPath(), next);
    return next;
  });
}

function normalizeAppSettings(settings: AppSettings | null): AppSettings {
  if (!settings || typeof settings !== 'object') return {};
  const normalized: AppSettings = {};
  if (typeof settings.dataDir === 'string' && settings.dataDir.trim()) {
    normalized.dataDir = path.resolve(settings.dataDir);
  }
  if (settings.pendingCleanup === null) {
    normalized.pendingCleanup = null;
  } else if (typeof settings.pendingCleanup === 'string' && settings.pendingCleanup.trim()) {
    normalized.pendingCleanup = path.resolve(settings.pendingCleanup);
  }
  if (settings.setupModel && typeof settings.setupModel === 'object') {
    const setupModel: AppSettings['setupModel'] = {};
    if (typeof settings.setupModel.provider === 'string' && settings.setupModel.provider.trim()) {
      setupModel.provider = settings.setupModel.provider.trim();
    }
    if (typeof settings.setupModel.modelName === 'string' && settings.setupModel.modelName.trim()) {
      setupModel.modelName = settings.setupModel.modelName.trim();
    }
    if (setupModel.provider || setupModel.modelName) {
      normalized.setupModel = setupModel;
    }
  }
  return normalized;
}
