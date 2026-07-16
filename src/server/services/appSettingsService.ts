import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readJsonFile, safeWriteJson } from '../utils/safeWrite.js';
import { readEnvWithLegacyFallback } from '../utils/env.js';
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
  const configuredPath = readEnvWithLegacyFallback(
    'CHAPTERFLOW_APP_SETTINGS_PATH',
    'YUMEWEAVING_APP_SETTINGS_PATH'
  );
  if (configuredPath) {
    return path.resolve(configuredPath);
  }
  const appData = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
  const chapterFlowPath = path.join(appData, 'ChapterFlow', 'app-settings.json');
  const legacyPath = path.join(appData, 'Yumeweaving', 'app-settings.json');
  return existsSync(chapterFlowPath) || !existsSync(legacyPath) ? chapterFlowPath : legacyPath;
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
