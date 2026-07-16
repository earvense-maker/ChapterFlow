import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_DATA_DIR } from '../config.js';
import { readAppSettings, updateAppSettings } from './appSettingsService.js';
import { hasActiveDataDirWrites, withDataDirLock } from './dataDirLock.js';
import type { DataDirApplyResponse, DataDirInfo, DataDirPreview } from '../types/index.js';

interface FileEntry {
  relativePath: string;
  size: number;
}

export interface DataDirManifestDiff {
  missingInNew: FileEntry[];
}

export class DataDirMoveError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'DataDirMoveError';
  }
}

export async function getDataDirInfo(): Promise<DataDirInfo> {
  const settings = await readAppSettings();
  return {
    current: DATA_DIR,
    defaultPath: DEFAULT_DATA_DIR,
    isUsingDefault: samePath(DATA_DIR, DEFAULT_DATA_DIR),
    pendingCleanup: settings.pendingCleanup ?? null,
  };
}

export async function previewDataDirMove(targetPath: string): Promise<DataDirPreview> {
  const resolved = await resolveTargetPath(targetPath);
  const estimatedSize = await getDirectorySize(DATA_DIR);
  const invalidReason = await validateResolvedTarget(resolved.resolvedPath, estimatedSize);
  const hasFreeSpace = invalidReason === '同一ドライブでの空き容量不足' ? false : await hasEnoughFreeSpace(
    resolved.resolvedPath,
    estimatedSize
  );
  return {
    resolvedPath: resolved.resolvedPath,
    targetIsEmpty: resolved.targetIsEmpty,
    hasFreeSpace,
    estimatedSize,
    sameAsCurrentDir: samePath(resolved.resolvedPath, DATA_DIR),
    invalidReason: invalidReason ?? (!hasFreeSpace ? '同一ドライブでの空き容量不足' : undefined),
  };
}

export async function applyDataDirMove(targetPath: string): Promise<DataDirApplyResponse> {
  if (hasActiveDataDirWrites()) {
    throw new DataDirMoveError(
      '生成や保存の処理中のため、データ移動を開始できません。完了後にもう一度お試しください。',
      409,
      'data_dir_busy',
      true
    );
  }
  return withDataDirLock(async () => {
    const oldDataDir = DATA_DIR;
    const reusableTarget = await findReusableTarget(targetPath, oldDataDir);
    if (reusableTarget) {
      return persistDataDirMoveSettings(reusableTarget, oldDataDir);
    }

    const preview = await previewDataDirMove(targetPath);
    if (preview.invalidReason) {
      throw new DataDirMoveError(preview.invalidReason);
    }

    const newDataDir = preview.resolvedPath;
    try {
      const existingRetry = await canReuseExistingCopy(oldDataDir, newDataDir);
      if (!existingRetry) {
        try {
          await fs.mkdir(newDataDir, { recursive: true });
          await fs.cp(oldDataDir, newDataDir, {
            recursive: true,
            errorOnExist: false,
            force: true,
          });
          await verifyCopiedData(oldDataDir, newDataDir);
        } catch (err) {
          await rollbackNewDataDir(newDataDir, oldDataDir);
          if (err instanceof DataDirMoveError) throw err;
          throw new DataDirMoveError(err instanceof Error ? err.message : 'データ移動に失敗しました', 500);
        }
      }
      return await persistDataDirMoveSettings(newDataDir, oldDataDir);
    } catch (err) {
      if (err instanceof DataDirMoveError) throw err;
      throw new DataDirMoveError(err instanceof Error ? err.message : 'データ移動に失敗しました', 500);
    }
  });
}

async function findReusableTarget(targetPath: string, oldDataDir: string): Promise<string | null> {
  const normalized = stripSurroundingQuotes(targetPath).trim();
  if (!normalized) return null;
  const target = path.resolve(normalized);
  const candidates = [
    target,
    path.join(target, 'ChapterFlow'),
    path.join(target, 'Yumeweaving'),
  ];
  for (const candidate of candidates) {
    if (samePath(candidate, oldDataDir)) continue;
    if (isPathInside(candidate, oldDataDir) || isPathInside(oldDataDir, candidate)) continue;
    if (await canReuseExistingCopy(oldDataDir, candidate)) return candidate;
  }
  return null;
}

async function persistDataDirMoveSettings(
  newDataDir: string,
  oldDataDir: string
): Promise<DataDirApplyResponse> {
  try {
    await updateAppSettings((settings) => ({
      ...settings,
      dataDir: newDataDir,
      pendingCleanup: oldDataDir,
    }));
    return {
      ok: true,
      dataDir: newDataDir,
      pendingCleanup: oldDataDir,
      restartScheduled: true,
    };
  } catch {
    throw new DataDirMoveError(
      '新しい場所へのコピーは成功しましたが、設定の保存に失敗しました。もう一度お試しください。',
      500,
      'settings_write_failed',
      true
    );
  }
}

async function canReuseExistingCopy(oldDataDir: string, newDataDir: string): Promise<boolean> {
  const stat = await statOrNull(newDataDir);
  if (!stat?.isDirectory()) return false;
  const diff = await verifyManifestForCleanup(oldDataDir, newDataDir);
  if (diff.missingInNew.length > 0) return false;
  const oldSize = await getDirectorySize(oldDataDir);
  return oldSize > 0 || await isDirectoryEmpty(newDataDir);
}

async function resolveTargetPath(targetPath: string): Promise<{
  resolvedPath: string;
  targetIsEmpty: boolean;
}> {
  const normalized = stripSurroundingQuotes(targetPath).trim();
  if (!normalized) {
    throw new DataDirMoveError('移動先フォルダを入力してください');
  }
  const target = path.resolve(normalized);
  const targetStat = await statOrNull(target);
  if (targetStat && !targetStat.isDirectory()) {
    throw new DataDirMoveError('移動先はフォルダを指定してください');
  }
  const targetIsEmpty = targetStat ? await isDirectoryEmpty(target) : true;
  return {
    resolvedPath: targetIsEmpty ? target : path.join(target, 'ChapterFlow'),
    targetIsEmpty,
  };
}

async function validateResolvedTarget(
  resolvedPath: string,
  estimatedSize: number
): Promise<string | undefined> {
  if (samePath(resolvedPath, DATA_DIR)) return '現在の場所と同じです';
  if (isPathInside(resolvedPath, DATA_DIR) || isPathInside(DATA_DIR, resolvedPath)) {
    return '現在の場所と親子関係にある場所は指定できません';
  }

  const stat = await statOrNull(resolvedPath);
  if (stat && !stat.isDirectory()) return '移動先はフォルダを指定してください';
  if (stat && !(await isDirectoryEmpty(resolvedPath))) {
    return '移動先の ChapterFlow フォルダが空ではありません';
  }
  if (!(await canWriteToTarget(resolvedPath))) return '書き込み不可';
  if (!(await hasEnoughFreeSpace(resolvedPath, estimatedSize))) {
    return '同一ドライブでの空き容量不足';
  }
  return undefined;
}

async function verifyCopiedData(oldDataDir: string, newDataDir: string): Promise<void> {
  const diff = await verifyManifestForCleanup(oldDataDir, newDataDir);
  if (diff.missingInNew.length > 0) {
    throw new DataDirMoveError(`コピー検証に失敗しました: ${diff.missingInNew[0].relativePath}`, 500);
  }
}

export async function verifyManifestForCleanup(
  oldDataDir: string,
  newDataDir: string
): Promise<DataDirManifestDiff> {
  const missingInNew: FileEntry[] = [];
  const files = await listFiles(oldDataDir).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  for (const file of files) {
    const copiedPath = path.join(newDataDir, file.relativePath);
    const stat = await statOrNull(copiedPath);
    if (!stat?.isFile() || stat.size !== file.size) {
      missingInNew.push(file);
    }
  }
  return { missingInNew };
}

export async function copyMissingFiles(
  oldDataDir: string,
  newDataDir: string,
  files: FileEntry[]
): Promise<void> {
  for (const file of files) {
    const sourcePath = path.join(oldDataDir, file.relativePath);
    const targetPath = path.join(newDataDir, file.relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(sourcePath, targetPath);
  }
}

async function rollbackNewDataDir(newDataDir: string, oldDataDir: string): Promise<void> {
  if (samePath(newDataDir, oldDataDir) || isPathInside(oldDataDir, newDataDir)) return;
  await fs.rm(newDataDir, { recursive: true, force: true }).catch(() => undefined);
}

async function listFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        files.push({
          relativePath: path.relative(root, fullPath),
          size: stat.size,
        });
      }
    }
  }
  await walk(root);
  return files;
}

async function getDirectorySize(root: string): Promise<number> {
  const files = await listFiles(root).catch(() => []);
  return files.reduce((total, file) => total + file.size, 0);
}

async function isDirectoryEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir);
    return entries.length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

async function canWriteToTarget(targetPath: string): Promise<boolean> {
  const existing = await nearestExistingDir(targetPath);
  try {
    await fs.access(existing, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasEnoughFreeSpace(targetPath: string, estimatedSize: number): Promise<boolean> {
  const existing = await nearestExistingDir(targetPath);
  const statfs = fs.statfs;
  if (typeof statfs !== 'function') return true;
  try {
    const stats = await statfs(existing);
    return BigInt(stats.bavail) * BigInt(stats.bsize) > BigInt(estimatedSize);
  } catch {
    return true;
  }
}

async function nearestExistingDir(filePath: string): Promise<string> {
  let current = path.resolve(filePath);
  while (true) {
    const stat = await statOrNull(current);
    if (stat?.isDirectory()) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function statOrNull(filePath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function stripSurroundingQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}
