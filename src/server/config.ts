import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readEnvWithLegacyFallback } from './utils/env.js';
import {
  hasDirectoryEntries,
  resolvePreferredDirWithLegacy,
} from './utils/legacyDirResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_DATA_DIR = resolveDefaultDataDir();
const configuredDataDir = readEnvWithLegacyFallback(
  'CHAPTERFLOW_DATA_DIR',
  'YUMEWEAVING_DATA_DIR'
);
export const DATA_DIR = configuredDataDir
  ? path.resolve(PROJECT_ROOT, configuredDataDir)
  : DEFAULT_DATA_DIR;
export const PROJECTS_DIR = path.resolve(DATA_DIR, 'projects');
export const SETUP_SESSIONS_DIR = path.resolve(DATA_DIR, 'setup-sessions');
export const CONFIG_DIR = path.resolve(DATA_DIR, 'config');
export const SYSTEM_PROMPT_PRESETS_PATH = path.resolve(CONFIG_DIR, 'system-prompt-presets.json');
export const PRESETS_PATH = path.resolve(PROJECT_ROOT, 'presets', 'default-presets.json');
export const STYLE_SAMPLES_PATH = path.resolve(PROJECT_ROOT, 'presets', 'style-samples.json');

export function resolveDefaultDataDir(
  homeDir = homedir(),
  pathExists: (filePath: string) => boolean = existsSync,
  directoryHasEntries: (directoryPath: string) => boolean = hasDirectoryEntries
): string {
  const chapterFlowDir = path.resolve(homeDir, 'Documents', 'ChapterFlow');
  const legacyDir = path.resolve(homeDir, 'Documents', 'Yumeweaving');
  const containsProjects = (dataDir: string) =>
    directoryHasEntries(path.join(dataDir, 'projects'));
  const containsAppData = (dataDir: string) =>
    ['projects', 'config', 'setup-sessions'].some((name) =>
      directoryHasEntries(path.join(dataDir, name))
    );

  // NOTE: 利用ガイドの約束どおり「作品(projects)のある保存先」を最優先する。
  // config だけの新フォルダ（APIキー保存のみ等）が旧作品入りフォルダを隠さないよう、
  // projects → その他アプリデータ の順で判定する。
  return resolvePreferredDirWithLegacy(
    chapterFlowDir,
    legacyDir,
    [containsProjects, containsAppData],
    pathExists
  );
}
