import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import * as storage from './storageService.js';
import { withDataDirWrite } from './dataDirLock.js';
import { ensureDir } from '../utils/safeWrite.js';

const SHORTCUTS_DIR_NAME = '作品一覧';
const MAX_SHORTCUT_BASENAME_LENGTH = 120;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

interface ShortcutItem {
  projectId: string;
  baseName: string;
  lnkPath: string;
  targetPath: string;
}

type ShortcutTargets = Map<string, string | null>;

interface ShortcutWriteCacheEntry {
  baseName: string;
  lnkPath: string;
  targetPath: string;
}

const shortcutWriteCache = new Map<string, ShortcutWriteCacheEntry>();

export function shortcutsDir(): string {
  return path.join(DATA_DIR, SHORTCUTS_DIR_NAME);
}

export async function ensureShortcutsDir(): Promise<void> {
  await ensureDir(shortcutsDir());
}

export function sanitizeShortcutBaseName(title: string | undefined, projectId: string): string {
  const fallback = `無題-${projectId.slice(0, 8) || 'project'}`;
  const normalized = (title ?? '')
    .replace(/[\x00-\x1F\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const safeName = normalized.replace(/_/g, '').trim() ? normalized : fallback;
  const reservedSafeName = WINDOWS_RESERVED_NAMES.test(safeName) ? `_${safeName}` : safeName;
  return Array.from(reservedSafeName).slice(0, MAX_SHORTCUT_BASENAME_LENGTH).join('');
}

export async function resolveShortcutTargetPath(projectId: string): Promise<string | null> {
  const state = await storage.readState(projectId);
  const episodeIds = new Set<string>();
  if (state?.currentEpisodeId) episodeIds.add(state.currentEpisodeId);
  for (const episodeId of await storage.listEpisodeIds(projectId)) {
    episodeIds.add(episodeId);
  }

  for (const episodeId of episodeIds) {
    const targetPath = storage.episodeMdPath(projectId, episodeId);
    try {
      const stat = await fs.stat(targetPath);
      if (stat.isFile()) return targetPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return null;
}

export async function writeShortcut(projectId: string, title: string): Promise<void> {
  const targetPath = await resolveShortcutTargetPath(projectId);
  if (!targetPath) {
    shortcutWriteCache.delete(projectId);
    return;
  }

  const baseName = sanitizeShortcutBaseName(title, projectId);
  const cached = shortcutWriteCache.get(projectId);
  if (
    cached?.baseName === baseName &&
    samePath(cached.targetPath, targetPath) &&
    await fileExists(cached.lnkPath)
  ) {
    return;
  }

  await withDataDirWrite(async () => {
    await fs.mkdir(shortcutsDir(), { recursive: true });
    const existingTargets = await readExistingShortcutTargets();
    const item = buildShortcutItem(projectId, baseName, targetPath, existingTargets);
    await writeShortcutItems([item]);
    shortcutWriteCache.set(projectId, { baseName, lnkPath: item.lnkPath, targetPath });
  });
}

export async function regenerateAllShortcuts(): Promise<void> {
  await withDataDirWrite(async () => {
    const dir = shortcutsDir();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    const existingTargets: ShortcutTargets = new Map();
    const items: ShortcutItem[] = [];
    for (const projectId of (await storage.listProjectIds()).sort()) {
      const project = await storage.readProject(projectId);
      if (!project) continue;
      const targetPath = await resolveShortcutTargetPath(projectId);
      if (!targetPath) continue;
      const baseName = sanitizeShortcutBaseName(project.title, projectId);
      items.push(buildShortcutItem(projectId, baseName, targetPath, existingTargets));
    }
    await writeShortcutItems(items);
    shortcutWriteCache.clear();
    for (const item of items) {
      shortcutWriteCache.set(item.projectId, {
        baseName: item.baseName,
        lnkPath: item.lnkPath,
        targetPath: item.targetPath,
      });
    }
  });
}

function buildShortcutItem(
  projectId: string,
  baseName: string,
  targetPath: string,
  existingTargets: ShortcutTargets
): ShortcutItem {
  const lnkPath = chooseShortcutPath(baseName, targetPath, existingTargets);
  return { projectId, baseName, lnkPath, targetPath };
}

export function chooseShortcutPath(
  baseName: string,
  targetPath: string,
  existingTargets: ShortcutTargets
): string {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? '' : ` (${index})`;
    const candidate = path.join(shortcutsDir(), `${baseName}${suffix}.lnk`);
    const key = pathKey(candidate);
    const existingTarget = existingTargets.get(key);
    if (!existingTargets.has(key) || (existingTarget && samePath(existingTarget, targetPath))) {
      existingTargets.set(key, targetPath);
      return candidate;
    }
  }
}

async function readExistingShortcutTargets(): Promise<ShortcutTargets> {
  const dir = shortcutsDir();
  const targets: ShortcutTargets = new Map();
  let lnkPaths: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    lnkPaths = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.lnk'))
      .map((entry) => path.join(dir, entry.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  for (const lnkPath of lnkPaths) {
    targets.set(pathKey(lnkPath), null);
  }
  if (process.platform !== 'win32' || lnkPaths.length === 0) return targets;

  try {
    const stdout = await runPowerShellJson(READ_SHORTCUT_TARGETS_SCRIPT, lnkPaths);
    const rows = normalizePowerShellRows<{
      lnkPath?: string;
      targetPath?: string;
    }>(stdout);
    for (const row of rows) {
      if (row.lnkPath && row.targetPath) {
        targets.set(pathKey(row.lnkPath), row.targetPath);
      }
    }
  } catch (err) {
    console.warn('Shortcut target inspection failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return targets;
}

async function writeShortcutItems(items: ShortcutItem[]): Promise<void> {
  if (items.length === 0) return;
  if (process.platform !== 'win32') return;
  await runPowerShellJson(WRITE_SHORTCUTS_SCRIPT, items);
}

function normalizePowerShellRows<T>(json: string): T[] {
  if (!json.trim()) return [];
  const parsed = JSON.parse(json) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function pathKey(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function runPowerShellJson(script: string, payload: unknown): Promise<string> {
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const executable = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedScript],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        return;
      }
      const trimmed = stdout.trim();
      resolve(trimmed ? Buffer.from(trimmed, 'base64').toString('utf8') : '');
    });
    child.stdin.end(encodedPayload);
  });
}

const READ_SHORTCUT_TARGETS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd().Trim()
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
$paths = @($json | ConvertFrom-Json)
$ws = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($path in $paths) {
  try {
    $shortcut = $ws.CreateShortcut([string]$path)
    $rows += [pscustomobject]@{
      lnkPath = [string]$path
      targetPath = [string]$shortcut.TargetPath
    }
  } catch {
  }
}
$outJson = @($rows) | ConvertTo-Json -Compress -Depth 3
[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($outJson)))
`;

const WRITE_SHORTCUTS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$payload = [Console]::In.ReadToEnd().Trim()
$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
$items = @($json | ConvertFrom-Json)
$ws = New-Object -ComObject WScript.Shell
foreach ($item in $items) {
  $parent = Split-Path -Parent ([string]$item.lnkPath)
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $shortcut = $ws.CreateShortcut([string]$item.lnkPath)
  $shortcut.TargetPath = [string]$item.targetPath
  $shortcut.WorkingDirectory = Split-Path -Parent ([string]$item.targetPath)
  $shortcut.Description = "Yumeweaving project: $($item.projectId)"
  $shortcut.Save()
}
$outJson = '[]'
[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($outJson)))
`;
