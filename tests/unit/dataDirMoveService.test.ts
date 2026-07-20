import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../../src/server/config';
import {
  readAppSettings,
  writeAppSettings,
} from '../../src/server/services/appSettingsService';
import {
  resetDataDirRestartPendingForTests,
  withDataDirWrite,
} from '../../src/server/services/dataDirLock';
import {
  applyDataDirSwitch,
  applyDataDirMove,
  copyMissingFiles,
  previewDataDirSwitch,
  previewDataDirMove,
  verifyManifestForCleanup,
} from '../../src/server/services/dataDirMoveService';

const tempDirs: string[] = [];
const originalSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
const originalDataDirSource = process.env.CHAPTERFLOW_DATA_DIR_SOURCE;

afterEach(async () => {
  resetDataDirRestartPendingForTests();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  if (originalSettingsPath === undefined) {
    delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
  } else {
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalSettingsPath;
  }
  if (originalDataDirSource === undefined) {
    delete process.env.CHAPTERFLOW_DATA_DIR_SOURCE;
  } else {
    process.env.CHAPTERFLOW_DATA_DIR_SOURCE = originalDataDirSource;
  }
});

describe('dataDirMoveService preview', () => {
  it('rejects a child of the current data directory', async () => {
    const preview = await previewDataDirMove(path.join(DATA_DIR, 'nested-target'));

    expect(preview.invalidReason).toBe('現在の場所と親子関係にある場所は指定できません');
  });

  it('uses a ChapterFlow subfolder when the selected folder is not empty', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-preview-'));
    tempDirs.push(target);
    await fs.writeFile(path.join(target, 'existing.txt'), 'keep me');

    const preview = await previewDataDirMove(target);

    expect(preview.targetIsEmpty).toBe(false);
    expect(preview.resolvedPath).toBe(path.join(target, 'ChapterFlow'));
  });
});

describe('dataDirMoveService cleanup manifest', () => {
  it('copies files that exist only in the old directory before cleanup', async () => {
    const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-old-'));
    const newDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-new-'));
    tempDirs.push(oldDir, newDir);
    await fs.mkdir(path.join(oldDir, 'projects', 'proj-a'), { recursive: true });
    await fs.writeFile(path.join(oldDir, 'projects', 'proj-a', 'story-state.json'), '{"ok":true}');

    const diff = await verifyManifestForCleanup(oldDir, newDir);
    expect(diff.missingInNew.map((file) => file.relativePath)).toEqual([
      path.join('projects', 'proj-a', 'story-state.json'),
    ]);

    await copyMissingFiles(oldDir, newDir, diff.missingInNew);
    await expect(
      fs.readFile(path.join(newDir, 'projects', 'proj-a', 'story-state.json'), 'utf8')
    ).resolves.toBe('{"ok":true}');
    await expect(verifyManifestForCleanup(oldDir, newDir)).resolves.toEqual({ missingInNew: [] });
  });
});

describe('dataDirMoveService apply', () => {
  it('rejects immediately when another data write is active', async () => {
    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-busy-target-'));
    tempDirs.push(target);
    let releaseWrite!: () => void;
    const writePromise = withDataDirWrite(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      })
    );

    try {
      await expect(applyDataDirMove(target)).rejects.toMatchObject({
        status: 409,
        code: 'data_dir_busy',
        retryable: true,
      });
    } finally {
      releaseWrite?.();
      await writePromise;
    }
  });

  it('keeps a verified copy when settings write fails and reuses it on retry', async () => {
    const projectDir = path.join(DATA_DIR, 'projects', 'proj-data-dir-retry');
    tempDirs.push(projectDir);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'project.json'), '{"projectId":"proj-data-dir-retry"}');

    const target = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-apply-target-'));
    const badSettingsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-bad-settings-'));
    const goodSettingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-good-settings-'));
    tempDirs.push(target, badSettingsPath, goodSettingsDir);

    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = badSettingsPath;
    await expect(applyDataDirMove(target)).rejects.toMatchObject({
      code: 'settings_write_failed',
    });
    await expect(
      fs.readFile(path.join(target, 'projects', 'proj-data-dir-retry', 'project.json'), 'utf8')
    ).resolves.toBe('{"projectId":"proj-data-dir-retry"}');

    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = path.join(goodSettingsDir, 'app-settings.json');
    const result = await applyDataDirMove(target);
    const settings = await readAppSettings();

    expect(result.dataDir).toBe(target);
    expect(settings.dataDir).toBe(target);
    expect(settings.pendingCleanup).toBe(DATA_DIR);
  });
});

describe('dataDirMoveService switch preview', () => {
  it('summarizes a valid existing ChapterFlow data directory', async () => {
    const target = await createSwitchTarget('chapterflow-switch-preview-', [
      { projectId: 'project-a', title: '春の夢', updatedAt: '2026-07-20T01:00:00.000Z' },
      { projectId: 'project-b', title: '夏の夢', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    await fs.mkdir(path.join(target, 'config'), { recursive: true });
    await fs.writeFile(path.join(target, 'config', 'credentials.json'), '{}');

    const preview = await previewDataDirSwitch(target);

    expect(preview).toMatchObject({
      resolvedPath: await fs.realpath(target),
      projectCount: 2,
      hasCredentials: true,
    });
    expect(preview.projects.map((project) => project.title)).toEqual(['夏の夢', '春の夢']);
    expect(preview.invalidReason).toBeUndefined();
  });

  it('rejects folders that do not contain readable projects', async () => {
    const emptyTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-switch-empty-'));
    tempDirs.push(emptyTarget);

    await expect(previewDataDirSwitch(emptyTarget)).resolves.toMatchObject({
      projectCount: 0,
      invalidReason: 'ChapterFlow の projects フォルダが見つかりません',
    });

    const corruptTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-switch-corrupt-'));
    tempDirs.push(corruptTarget);
    await fs.mkdir(path.join(corruptTarget, 'projects', 'project-broken'), { recursive: true });
    await fs.writeFile(
      path.join(corruptTarget, 'projects', 'project-broken', 'project.json'),
      '{"projectId":"project-broken","title":'
    );

    await expect(previewDataDirSwitch(corruptTarget)).resolves.toMatchObject({
      invalidReason: '読み込める作品が見つかりません',
      unreadableProjectIds: ['project-broken'],
    });
  });

  it('keeps readable projects available and warns about unreadable ones', async () => {
    const target = await createSwitchTarget('chapterflow-switch-mixed-', [
      { projectId: 'project-good', title: '読める作品', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    await fs.mkdir(path.join(target, 'projects', 'project-broken'), { recursive: true });
    await fs.writeFile(
      path.join(target, 'projects', 'project-broken', 'project.json'),
      '{"projectId":"project-broken"}'
    );

    await expect(previewDataDirSwitch(target)).resolves.toMatchObject({
      projectCount: 1,
      unreadableProjectIds: ['project-broken'],
      projects: [{ projectId: 'project-good', title: '読める作品' }],
    });
  });
});

describe('dataDirMoveService switch apply', () => {
  it('rejects immediately when another data write is active', async () => {
    const target = await createSwitchTarget('chapterflow-switch-busy-', [
      { projectId: 'project-switch', title: '切り替え先', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    let releaseWrite!: () => void;
    const writePromise = withDataDirWrite(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      })
    );

    try {
      await expect(applyDataDirSwitch(target)).rejects.toMatchObject({
        status: 409,
        code: 'data_dir_busy',
        retryable: true,
      });
    } finally {
      releaseWrite?.();
      await writePromise;
    }
  });

  it('updates only the configured path and keeps both data directories intact', async () => {
    const target = await createSwitchTarget('chapterflow-switch-apply-', [
      { projectId: 'project-switch', title: '切り替え先', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-switch-settings-'));
    const currentSentinel = path.join(DATA_DIR, 'switch-do-not-copy.txt');
    tempDirs.push(settingsDir, currentSentinel);
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = path.join(settingsDir, 'app-settings.json');
    delete process.env.CHAPTERFLOW_DATA_DIR_SOURCE;
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(currentSentinel, 'current only');
    await writeAppSettings({ pendingCleanup: null });

    const result = await applyDataDirSwitch(target);
    const settings = await readAppSettings();

    expect(result).toMatchObject({
      dataDir: await fs.realpath(target),
      previousDataDir: DATA_DIR,
      restartScheduled: true,
    });
    expect(settings).toMatchObject({
      dataDir: await fs.realpath(target),
      previousDataDir: DATA_DIR,
      pendingCleanup: null,
    });
    await expect(fs.readFile(currentSentinel, 'utf8')).resolves.toBe('current only');
    await expect(fs.stat(path.join(target, 'switch-do-not-copy.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(withDataDirWrite(async () => undefined)).rejects.toThrow(
      '保存先の切り替え後、再起動を待っているため書き込みできません。'
    );
  });

  it('blocks switching while cleanup from a move is pending', async () => {
    const target = await createSwitchTarget('chapterflow-switch-pending-', [
      { projectId: 'project-switch', title: '切り替え先', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    const settingsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-switch-settings-'));
    tempDirs.push(settingsDir);
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = path.join(settingsDir, 'app-settings.json');
    delete process.env.CHAPTERFLOW_DATA_DIR_SOURCE;
    await writeAppSettings({ pendingCleanup: path.join(settingsDir, 'old-data') });

    await expect(applyDataDirSwitch(target)).rejects.toMatchObject({
      status: 409,
      code: 'pending_cleanup',
    });
  });

  it('keeps the current data writable when the app settings cannot be read', async () => {
    const target = await createSwitchTarget('chapterflow-switch-settings-failure-', [
      { projectId: 'project-switch', title: '切り替え先', updatedAt: '2026-07-20T02:00:00.000Z' },
    ]);
    const badSettingsPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'chapterflow-switch-bad-settings-')
    );
    tempDirs.push(badSettingsPath);
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = badSettingsPath;
    delete process.env.CHAPTERFLOW_DATA_DIR_SOURCE;

    await expect(applyDataDirSwitch(target)).rejects.toMatchObject({
      status: 500,
      code: 'settings_read_failed',
      retryable: true,
    });
    await expect(withDataDirWrite(async () => 'still writable')).resolves.toBe('still writable');
  });
});

async function createSwitchTarget(
  prefix: string,
  projects: Array<{ projectId: string; title: string; updatedAt: string }>
): Promise<string> {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(target);
  for (const project of projects) {
    const projectDir = path.join(target, 'projects', project.projectId);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, 'project.json'),
      JSON.stringify({
        schemaVersion: 1,
        ...project,
      })
    );
    await fs.writeFile(
      path.join(projectDir, 'state.json'),
      JSON.stringify({ lastOpenedAt: project.updatedAt })
    );
  }
  return target;
}
