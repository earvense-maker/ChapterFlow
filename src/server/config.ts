import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const DEFAULT_DATA_DIR = path.resolve(homedir(), 'Documents', 'Yumeweaving');
export const DATA_DIR = process.env.YUMEWEAVING_DATA_DIR
  ? path.resolve(PROJECT_ROOT, process.env.YUMEWEAVING_DATA_DIR)
  : DEFAULT_DATA_DIR;
export const PROJECTS_DIR = path.resolve(DATA_DIR, 'projects');
export const SETUP_SESSIONS_DIR = path.resolve(DATA_DIR, 'setup-sessions');
export const CONFIG_DIR = path.resolve(DATA_DIR, 'config');
export const PRESETS_PATH = path.resolve(PROJECT_ROOT, 'presets', 'default-presets.json');
