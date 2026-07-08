import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import * as projectService from '../../src/server/services/projectService';
import {
  chooseShortcutPath,
  resolveShortcutTargetPath,
  sanitizeShortcutBaseName,
  shortcutsDir,
} from '../../src/server/services/shortcutService';
import * as storage from '../../src/server/services/storageService';
import type { EpisodeRecord } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

afterEach(async () => {
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('shortcutService', () => {
  it('sanitizes titles for Windows shortcut file names', () => {
    expect(sanitizeShortcutBaseName(' シリーズ:A/1 ', 'project123')).toBe('シリーズ_A_1');
    expect(sanitizeShortcutBaseName(' <>| ', 'project123')).toBe('無題-project1');
    expect(sanitizeShortcutBaseName('CON', 'project123')).toBe('_CON');
  });

  it('resolves the first existing episode markdown path', async () => {
    const project = await projectService.createProject({ title: 'Shortcut Target' });
    createdProjectIds.push(project.projectId);

    await expect(resolveShortcutTargetPath(project.projectId)).resolves.toBeNull();

    const episode: EpisodeRecord = {
      episodeId: 'ep-shortcut',
      title: '第1章',
      order: 1,
      createdAt: '2026-07-08T00:00:00Z',
      updatedAt: '2026-07-08T00:00:00Z',
      scenes: [],
    };
    await storage.writeEpisodeRecord(project.projectId, episode);
    await storage.writeEpisodeText(project.projectId, episode.episodeId, '本文');

    await expect(resolveShortcutTargetPath(project.projectId)).resolves.toBe(
      storage.episodeMdPath(project.projectId, episode.episodeId)
    );
  });

  it('treats unreadable existing shortcuts as occupied slots', () => {
    const existingTargets = new Map<string, string | null>();
    const basePath = path.join(shortcutsDir(), '同名.lnk');
    existingTargets.set(path.resolve(basePath).toLowerCase(), null);

    const selected = chooseShortcutPath('同名', 'C:\\data\\projects\\b\\episodes\\ep.md', existingTargets);

    expect(path.basename(selected)).toBe('同名 (2).lnk');
  });

  it('reuses an existing shortcut slot when it already points to the same target', () => {
    const targetPath = 'C:\\data\\projects\\a\\episodes\\ep.md';
    const existingTargets = new Map<string, string | null>();
    const basePath = path.join(shortcutsDir(), '同名.lnk');
    existingTargets.set(path.resolve(basePath).toLowerCase(), targetPath);

    const selected = chooseShortcutPath('同名', targetPath, existingTargets);

    expect(path.basename(selected)).toBe('同名.lnk');
  });
});
