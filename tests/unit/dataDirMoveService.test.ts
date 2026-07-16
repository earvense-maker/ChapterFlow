import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../../src/server/config';
import { readAppSettings } from '../../src/server/services/appSettingsService';
import { withDataDirWrite } from '../../src/server/services/dataDirLock';
import {
  applyDataDirMove,
  copyMissingFiles,
  previewDataDirMove,
  verifyManifestForCleanup,
} from '../../src/server/services/dataDirMoveService';

const tempDirs: string[] = [];
const originalSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
  if (originalSettingsPath === undefined) {
    delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
  } else {
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalSettingsPath;
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
