import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULT_DATA_DIR } from '../config.js';
import {
  readAppSettings,
  readAppSettingsStrict,
  updateAppSettingsStrict,
} from './appSettingsService.js';
import {
  hasActiveDataDirWrites,
  markDataDirRestartPending,
  withDataDirLock,
} from './dataDirLock.js';
import {
  acquireDataDirFileLock,
  DATA_DIR_LOCK_FILE_NAME,
  DataDirInUseError,
} from './dataDirFileLock.js';
import {
  canonicalizePath,
  findSymbolicLink,
  isCanonicalPathInside,
  sameCanonicalPath,
} from '../utils/pathSafety.js';
import type {
  DataDirApplyResponse,
  DataDirInfo,
  DataDirPreview,
  DataDirSwitchPreview,
  DataDirSwitchProjectSummary,
  DataDirSwitchResponse,
} from '../types/index.js';

interface FileEntry {
  relativePath: string;
  size: number;
  sha256: string;
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const SWITCH_PREVIEW_PROJECT_LIMIT = 10;

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
    previousDataDir: settings.previousDataDir ?? null,
  };
}

export async function previewDataDirMove(targetPath: string): Promise<DataDirPreview> {
  if (process.env.CHAPTERFLOW_DATA_DIR_SOURCE === 'external') {
    throw new DataDirMoveError(
      '環境変数で保存先が固定されているため、アプリから移動できません。',
      409,
      'data_dir_external'
    );
  }
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
    sameAsCurrentDir: await pathsAreSame(resolved.resolvedPath, DATA_DIR),
    invalidReason: invalidReason ?? (!hasFreeSpace ? '同一ドライブでの空き容量不足' : undefined),
  };
}

export async function applyDataDirMove(targetPath: string): Promise<DataDirApplyResponse> {
  if (process.env.CHAPTERFLOW_DATA_DIR_SOURCE === 'external') {
    throw new DataDirMoveError(
      '環境変数で保存先が固定されているため、アプリから移動できません。',
      409,
      'data_dir_external'
    );
  }
  if (hasActiveDataDirWrites()) {
    throw new DataDirMoveError(
      '生成や保存の処理中のため、データ移動を開始できません。完了後にもう一度お試しください。',
      409,
      'data_dir_busy',
      true
    );
  }
  return withDataDirLock(async () => {
    await readSettingsForDataDirChange();
    await rejectSymbolicLinks(DATA_DIR, '現在の保存先');
    const oldDataDir = DATA_DIR;
    const reusableTarget = await findReusableTarget(targetPath, oldDataDir);
    if (reusableTarget) {
      const releaseTargetLock = await acquireTargetLock(reusableTarget);
      try {
        if (!(await canReuseExistingCopy(oldDataDir, reusableTarget))) {
          throw new DataDirMoveError(
            '移動先の内容が確認後に変更されました。もう一度お試しください。',
            409,
            'data_dir_changed',
            true
          );
        }
        return await persistDataDirMoveSettings(reusableTarget, oldDataDir);
      } catch (err) {
        await releaseTargetLock();
        throw err;
      }
    }

    const preview = await previewDataDirMove(targetPath);
    if (preview.invalidReason) {
      throw new DataDirMoveError(preview.invalidReason);
    }

    const newDataDir = preview.resolvedPath;
    const releaseTargetLock = await acquireTargetLock(newDataDir);
    let keepTargetLock = false;
    try {
      const existingRetry = await canReuseExistingCopy(oldDataDir, newDataDir);
      if (!existingRetry) {
        try {
          await fs.mkdir(newDataDir, { recursive: true });
          await fs.cp(oldDataDir, newDataDir, {
            recursive: true,
            errorOnExist: false,
            force: true,
            filter: (source) => path.basename(source) !== DATA_DIR_LOCK_FILE_NAME,
          });
          await rejectSymbolicLinks(newDataDir, '新しい保存先');
          await verifyCopiedData(oldDataDir, newDataDir);
        } catch (err) {
          await rollbackNewDataDir(newDataDir, oldDataDir);
          if (err instanceof DataDirMoveError) throw err;
          throw new DataDirMoveError(err instanceof Error ? err.message : 'データ移動に失敗しました', 500);
        }
      }
      const result = await persistDataDirMoveSettings(newDataDir, oldDataDir);
      keepTargetLock = true;
      return result;
    } catch (err) {
      if (err instanceof DataDirMoveError) throw err;
      throw new DataDirMoveError(err instanceof Error ? err.message : 'データ移動に失敗しました', 500);
    } finally {
      if (!keepTargetLock) await releaseTargetLock();
    }
  });
}

export async function previewDataDirSwitch(targetPath: string): Promise<DataDirSwitchPreview> {
  const normalized = stripSurroundingQuotes(targetPath).trim();
  if (!normalized) {
    throw new DataDirMoveError('切り替え先フォルダを入力してください');
  }

  const selectedPath = path.resolve(normalized);
  const emptyPreview = (invalidReason: string): DataDirSwitchPreview => ({
    resolvedPath: selectedPath,
    projectCount: 0,
    projects: [],
    unreadableProjectIds: [],
    hasCredentials: false,
    invalidReason,
  });

  if (process.env.CHAPTERFLOW_DATA_DIR_SOURCE === 'external') {
    return emptyPreview('環境変数で保存先が固定されているため、アプリから切り替えられません');
  }

  const targetStat = await statOrNull(selectedPath);
  if (!targetStat) return emptyPreview('指定したフォルダが見つかりません');
  if (!targetStat.isDirectory()) return emptyPreview('切り替え先はフォルダを指定してください');

  const resolvedPath = await fs.realpath(selectedPath);
  const currentPath = await fs.realpath(DATA_DIR).catch(() => path.resolve(DATA_DIR));
  const previewForResolvedPath = (invalidReason: string): DataDirSwitchPreview => ({
    ...emptyPreview(invalidReason),
    resolvedPath,
  });

  if (samePath(resolvedPath, currentPath)) {
    return previewForResolvedPath('現在の保存先と同じです');
  }
  if (isPathInside(resolvedPath, currentPath) || isPathInside(currentPath, resolvedPath)) {
    return previewForResolvedPath('現在の保存先と親子関係にある場所は指定できません');
  }

  try {
    await fs.access(resolvedPath, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return previewForResolvedPath('選択したフォルダを読み書きできません');
  }

  const linkedPath = await findSymbolicLink(resolvedPath);
  if (linkedPath) {
    return previewForResolvedPath(
      `リンクを含む保存先は安全のため使用できません: ${path.relative(resolvedPath, linkedPath)}`
    );
  }

  const projectsPath = path.join(resolvedPath, 'projects');
  const projectsStat = await statOrNull(projectsPath);
  if (!projectsStat?.isDirectory()) {
    return previewForResolvedPath('ChapterFlow の projects フォルダが見つかりません');
  }

  const entries = (await fs.readdir(projectsPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && SAFE_PATH_SEGMENT.test(entry.name));
  if (entries.length === 0) {
    return previewForResolvedPath('切り替え先に作品が見つかりません');
  }

  const projects: DataDirSwitchProjectSummary[] = [];
  const unreadableProjectIds: string[] = [];
  for (const entry of entries) {
    try {
      const project = JSON.parse(
        await fs.readFile(path.join(projectsPath, entry.name, 'project.json'), 'utf8')
      ) as Record<string, unknown>;
      const state = JSON.parse(
        await fs.readFile(path.join(projectsPath, entry.name, 'state.json'), 'utf8')
      ) as Record<string, unknown>;
      if (
        project.projectId !== entry.name ||
        typeof project.title !== 'string' ||
        !project.title.trim() ||
        typeof project.updatedAt !== 'string' ||
        !project.updatedAt.trim() ||
        !Number.isFinite(Date.parse(project.updatedAt)) ||
        typeof state.lastOpenedAt !== 'string' ||
        !state.lastOpenedAt.trim() ||
        !Number.isFinite(Date.parse(state.lastOpenedAt))
      ) {
        throw new Error('invalid project metadata');
      }
      projects.push({
        projectId: entry.name,
        title: project.title.trim(),
        updatedAt: project.updatedAt,
      });
    } catch {
      unreadableProjectIds.push(entry.name);
    }
  }
  if (projects.length === 0) {
    return {
      ...previewForResolvedPath('読み込める作品が見つかりません'),
      unreadableProjectIds,
    };
  }
  projects.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return {
    resolvedPath,
    projectCount: projects.length,
    projects: projects.slice(0, SWITCH_PREVIEW_PROJECT_LIMIT),
    unreadableProjectIds,
    hasCredentials: Boolean(
      (await statOrNull(path.join(resolvedPath, 'config', 'credentials.json')))?.isFile()
    ),
  };
}

export async function applyDataDirSwitch(targetPath: string): Promise<DataDirSwitchResponse> {
  if (hasActiveDataDirWrites()) {
    throw new DataDirMoveError(
      '生成や保存の処理中のため、保存先を切り替えられません。完了後にもう一度お試しください。',
      409,
      'data_dir_busy',
      true
    );
  }
  if (process.env.CHAPTERFLOW_DATA_DIR_SOURCE === 'external') {
    throw new DataDirMoveError(
      '環境変数で保存先が固定されているため、アプリから切り替えられません',
      409,
      'data_dir_external'
    );
  }

  return withDataDirLock(async () => {
    let currentSettings;
    try {
      currentSettings = await readAppSettingsStrict();
    } catch {
      throw new DataDirMoveError(
        '現在の保存先設定を読み込めませんでした。設定ファイルを確認してから再試行してください。',
        500,
        'settings_read_failed',
        true
      );
    }
    if (currentSettings.pendingCleanup) {
      throw new DataDirMoveError(
        '以前の移動で残った旧データの整理が完了していません。アプリを再起動してからお試しください。',
        409,
        'pending_cleanup'
      );
    }

    const preview = await previewDataDirSwitch(targetPath);
    if (preview.invalidReason) {
      throw new DataDirMoveError(preview.invalidReason);
    }

    const releaseTargetLock = await acquireTargetLock(preview.resolvedPath);
    let keepTargetLock = false;
    try {
      const lockedPreview = await previewDataDirSwitch(preview.resolvedPath);
      if (lockedPreview.invalidReason) {
        throw new DataDirMoveError(lockedPreview.invalidReason, 409, 'data_dir_changed', true);
      }
      await updateAppSettingsStrict((settings) => {
        if (settings.pendingCleanup) {
          throw new DataDirMoveError(
            '以前の移動で残った旧データの整理が完了していません。アプリを再起動してからお試しください。',
            409,
            'pending_cleanup'
          );
        }
        return {
          ...settings,
          dataDir: lockedPreview.resolvedPath,
          previousDataDir: DATA_DIR,
        };
      });
      // NOTE: 設定保存後から再起動まで旧 DATA_DIR への新規書き込みを通すと、
      // 切り替え先に反映されず「保存が消えた」ように見えるため、終了まで拒否する。
      markDataDirRestartPending();
      keepTargetLock = true;
    } catch (err) {
      if (err instanceof DataDirMoveError) throw err;
      throw new DataDirMoveError(
        '切り替え先の設定を保存できませんでした。現在の保存先は変更されていません。',
        500,
        'settings_write_failed',
        true
      );
    } finally {
      if (!keepTargetLock) await releaseTargetLock();
    }

    return {
      ok: true,
      dataDir: preview.resolvedPath,
      previousDataDir: DATA_DIR,
      restartScheduled: true,
    };
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
    const canonicalCandidate = await canonicalizePath(candidate);
    const canonicalOld = await canonicalizePath(oldDataDir);
    if (sameCanonicalPath(canonicalCandidate, canonicalOld)) continue;
    if (
      isCanonicalPathInside(canonicalCandidate, canonicalOld) ||
      isCanonicalPathInside(canonicalOld, canonicalCandidate)
    ) continue;
    if (await canReuseExistingCopy(oldDataDir, candidate)) return candidate;
  }
  return null;
}

async function persistDataDirMoveSettings(
  newDataDir: string,
  oldDataDir: string
): Promise<DataDirApplyResponse> {
  try {
    await updateAppSettingsStrict((settings) => ({
      ...settings,
      dataDir: newDataDir,
      pendingCleanup: oldDataDir,
    }));
    markDataDirRestartPending();
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
  const canonicalResolved = await canonicalizePath(resolvedPath);
  const canonicalCurrent = await canonicalizePath(DATA_DIR);
  if (sameCanonicalPath(canonicalResolved, canonicalCurrent)) return '現在の場所と同じです';
  if (
    isCanonicalPathInside(canonicalResolved, canonicalCurrent) ||
    isCanonicalPathInside(canonicalCurrent, canonicalResolved)
  ) {
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
    if (!stat?.isFile() || stat.size !== file.size || await hashFile(copiedPath) !== file.sha256) {
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
  const canonicalNew = await canonicalizePath(newDataDir);
  const canonicalOld = await canonicalizePath(oldDataDir);
  if (
    sameCanonicalPath(canonicalNew, canonicalOld) ||
    isCanonicalPathInside(canonicalOld, canonicalNew)
  ) return;
  await fs.rm(newDataDir, { recursive: true, force: true }).catch(() => undefined);
}

async function listFiles(root: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === DATA_DIR_LOCK_FILE_NAME) continue;
      const fullPath = path.join(dir, entry.name);
      const linkStat = await fs.lstat(fullPath);
      if (linkStat.isSymbolicLink()) {
        throw new DataDirMoveError(
          `リンクを含む保存先は安全のため使用できません: ${path.relative(root, fullPath)}`,
          400,
          'data_dir_link_unsupported'
        );
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        files.push({
          relativePath: path.relative(root, fullPath),
          size: stat.size,
          sha256: await hashFile(fullPath),
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
    return entries.every((entry) => entry === DATA_DIR_LOCK_FILE_NAME);
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

async function pathsAreSame(a: string, b: string): Promise<boolean> {
  return sameCanonicalPath(await canonicalizePath(a), await canonicalizePath(b));
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function rejectSymbolicLinks(root: string, label: string): Promise<void> {
  const linkedPath = await findSymbolicLink(root);
  if (!linkedPath) return;
  throw new DataDirMoveError(
    `${label}にリンクが含まれているため、安全に処理できません: ${path.relative(root, linkedPath)}`,
    400,
    'data_dir_link_unsupported'
  );
}

async function readSettingsForDataDirChange(): Promise<void> {
  try {
    const settings = await readAppSettingsStrict();
    if (settings.pendingCleanup) {
      throw new DataDirMoveError(
        '以前の移動で残った旧データの整理が完了していません。アプリを再起動してからお試しください。',
        409,
        'pending_cleanup'
      );
    }
  } catch (err) {
    if (err instanceof DataDirMoveError) throw err;
    throw new DataDirMoveError(
      '現在の保存先設定を読み込めませんでした。設定ファイルを確認してから再試行してください。',
      500,
      'settings_read_failed',
      true
    );
  }
}

async function acquireTargetLock(dataDir: string): Promise<() => Promise<void>> {
  if (process.env.NODE_ENV === 'test') return async () => undefined;
  try {
    return await acquireDataDirFileLock(dataDir);
  } catch (err) {
    if (err instanceof DataDirInUseError) {
      throw new DataDirMoveError(err.message, 409, 'data_dir_in_use', true);
    }
    throw err;
  }
}
