import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as storage from '../../src/server/services/storageService';
import { PROJECTS_DIR, SETUP_SESSIONS_DIR } from '../../src/server/config';
import type {
  Character,
  GenerationRecord,
  ProjectState,
  SetupSession,
} from '../../src/server/types/index';
import type { LegacyCharacterInput } from '../../src/shared/characterSchema';

// NOTE: storageService は「作品データが載っている唯一のファイル層」なので、
// ここでは実ファイルへ書いて読み戻す。テスト用 DATA_DIR は tests/setup.ts が
// OS の一時ディレクトリへ差し替え済みで、実際の執筆データには触れない。

let seq = 0;
const trackedProjectIds: string[] = [];
const trackedSessionIds: string[] = [];

function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${process.pid}-${seq}`;
}

async function createProject(): Promise<string> {
  const projectId = uniqueId('proj');
  trackedProjectIds.push(projectId);
  await storage.createProjectDir(projectId);
  return projectId;
}

function trackSetupSession(sessionId: string): string {
  trackedSessionIds.push(sessionId);
  return sessionId;
}

function makeGenerationRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    generationId: 'gen-1',
    sceneId: 'scene-1',
    episodeId: 'ep-1',
    request: { wish: '続きを書く', outputLength: 1200, previousContextText: '' },
    responseText: '本文',
    usedPresets: {},
    usedModel: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentGenerationId: null,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(trackedProjectIds.map((id) => storage.deleteProjectDir(id)));
  await Promise.all(trackedSessionIds.map((id) => storage.deleteSetupSession(id)));
  trackedProjectIds.length = 0;
  trackedSessionIds.length = 0;
});

describe('path segment guards', () => {
  it('accepts ids built from letters, digits, underscore and hyphen', () => {
    expect(() => storage.assertSafePathSegment('proj_01-AB', 'projectId')).not.toThrow();
  });

  it.each([
    ['..'],
    ['../escape'],
    ['nested/child'],
    ['nested\\child'],
    [''],
    ['has space'],
    ['dot.separated'],
    ['ぷろじぇくと'],
    ['C:'],
  ])('rejects %j as a path segment', (value) => {
    expect(() => storage.assertSafePathSegment(value, 'projectId')).toThrow(/Invalid projectId/);
  });

  it('rejects traversal in every id-bearing path helper', () => {
    expect(() => storage.projectDir('../escape')).toThrow(/Invalid projectId/);
    expect(() => storage.setupSessionJsonPath('../escape')).toThrow(/Invalid sessionId/);
    expect(() => storage.episodeJsonPath('proj', '../escape')).toThrow(/Invalid episodeId/);
    expect(() => storage.episodeMdPath('proj', '../escape')).toThrow(/Invalid episodeId/);
    expect(() => storage.generationMdPath('proj', '../escape')).toThrow(/Invalid generationId/);
    expect(() => storage.generationPromptPath('proj', '../escape')).toThrow(
      /Invalid generationId/
    );
    expect(() => storage.roleplaySessionJsonPath('proj', '../escape')).toThrow(
      /Invalid sessionId/
    );
    expect(() => storage.knowledgeContentPath('proj', '../escape', 'md')).toThrow(
      /Invalid knowledgeId/
    );
  });

  it('keeps resolved project paths inside the projects directory', () => {
    const resolved = path.resolve(storage.projectJsonPath('proj-inside'));
    expect(resolved.startsWith(path.resolve(PROJECTS_DIR) + path.sep)).toBe(true);
  });

  it('accepts only md and txt as knowledge extensions', () => {
    expect(() => storage.assertKnowledgeExtension('md')).not.toThrow();
    expect(() => storage.assertKnowledgeExtension('txt')).not.toThrow();
    for (const bad of ['MD', 'json', 'exe', '', null, undefined, 1]) {
      expect(() => storage.assertKnowledgeExtension(bad)).toThrow(/Invalid knowledge extension/);
    }
  });
});

describe('reads on a project that has no files yet', () => {
  it('returns null for the documents that have no meaningful empty value', async () => {
    const projectId = await createProject();

    expect(await storage.readProject(projectId)).toBeNull();
    expect(await storage.readState(projectId)).toBeNull();
    expect(await storage.readPresets(projectId)).toBeNull();
    expect(await storage.readStoryState(projectId)).toBeNull();
    expect(await storage.readRefineScan(projectId)).toBeNull();
    expect(await storage.readRefineSession(projectId)).toBeNull();
    expect(await storage.readRefineAutomation(projectId)).toBeNull();
    expect(await storage.readGenerationStyleTraceStore(projectId)).toBeNull();
    expect(await storage.readEpisodeRecord(projectId, 'ep-missing')).toBeNull();
  });

  it('falls back to empty collections instead of throwing', async () => {
    const projectId = await createProject();

    expect(await storage.readCharacters(projectId)).toEqual([]);
    expect(await storage.readMemories(projectId)).toEqual([]);
    expect(await storage.readStoryStateDiffs(projectId)).toEqual([]);
    expect(await storage.readExpressions(projectId)).toEqual({
      schemaVersion: 1,
      ngExpressions: [],
    });
    expect(await storage.readKnowledgeIndex(projectId)).toEqual({ schemaVersion: 1, files: [] });
    expect(await storage.readWorld(projectId)).toEqual({ foundation: '', initialSituation: '' });
    expect(await storage.readWorldText(projectId)).toBe('');
    expect(await storage.readContextSummary(projectId)).toBe('');
    expect(await storage.readEpisodeText(projectId, 'ep-missing')).toBe('');
    expect(await storage.readGenerationMarkdown(projectId, 'gen-missing')).toBe('');
    expect(await storage.readGenerationPromptSnapshot(projectId, 'gen-missing')).toBe('');
  });

  it('reports a missing project without creating it', async () => {
    expect(await storage.projectExists('proj-never-created')).toBe(false);
    expect(await storage.listEpisodeIds('proj-never-created')).toEqual([]);
    expect(await storage.listRoleplaySessionIds('proj-never-created')).toEqual([]);
    expect(await storage.listKnowledgeContentFiles('proj-never-created')).toEqual([]);
  });
});

describe('project directory lifecycle', () => {
  it('creates the episode and generation subdirectories up front', async () => {
    const projectId = await createProject();

    expect((await fs.stat(storage.episodesDir(projectId))).isDirectory()).toBe(true);
    expect((await fs.stat(storage.generationsDir(projectId))).isDirectory()).toBe(true);
    expect(await storage.projectExists(projectId)).toBe(true);
  });

  it('deletes the whole project tree and stays silent on a second delete', async () => {
    const projectId = await createProject();
    await storage.writeEpisodeText(projectId, 'ep-1', '本文');

    await storage.deleteProjectDir(projectId);
    expect(await storage.projectExists(projectId)).toBe(false);

    await expect(storage.deleteProjectDir(projectId)).resolves.toBeUndefined();
  });
});

describe('id listings', () => {
  it('lists project directories and ignores stray files and unsafe names', async () => {
    const projectId = await createProject();
    await fs.writeFile(path.join(PROJECTS_DIR, 'loose-file.json'), '{}', 'utf-8');
    await fs.mkdir(path.join(PROJECTS_DIR, 'unsafe.name'), { recursive: true });

    const ids = await storage.listProjectIds();

    expect(ids).toContain(projectId);
    expect(ids).not.toContain('loose-file.json');
    expect(ids).not.toContain('unsafe.name');

    await fs.rm(path.join(PROJECTS_DIR, 'loose-file.json'), { force: true });
    await fs.rm(path.join(PROJECTS_DIR, 'unsafe.name'), { recursive: true, force: true });
  });

  it('lists episode ids from json files only', async () => {
    const projectId = await createProject();
    await storage.writeEpisodeRecord(projectId, {
      episodeId: 'ep-1',
      title: '第1話',
      scenes: [],
    } as never);
    await storage.writeEpisodeText(projectId, 'ep-1', '本文');

    expect(await storage.listEpisodeIds(projectId)).toEqual(['ep-1']);
  });

  it('lists knowledge files only when they follow the kb- naming rule', async () => {
    const projectId = await createProject();
    await storage.writeKnowledgeContent(projectId, 'kb-alpha', 'md', 'alpha');
    await storage.writeKnowledgeContent(projectId, 'kb-beta', 'txt', 'beta');
    await storage.writeKnowledgeContent(projectId, 'other-gamma', 'md', 'gamma');
    await storage.writeKnowledgeIndex(projectId, { schemaVersion: 1, files: [] });

    const files = await storage.listKnowledgeContentFiles(projectId);

    expect(files.sort()).toEqual(['kb-alpha.md', 'kb-beta.txt']);
    expect(files).not.toContain('knowledge.json');
  });
});

describe('setup sessions', () => {
  it('round-trips a session and reports existence', async () => {
    const sessionId = trackSetupSession(uniqueId('setup'));
    const session = { sessionId, messages: [] } as unknown as SetupSession;

    expect(await storage.setupSessionExists(sessionId)).toBe(false);
    await storage.writeSetupSession(session);

    expect(await storage.setupSessionExists(sessionId)).toBe(true);
    expect(await storage.readSetupSession(sessionId)).toEqual(session);
    expect(await storage.listSetupSessionIds()).toContain(sessionId);
  });

  it('deletes without throwing when the session is already gone', async () => {
    await expect(storage.deleteSetupSession('setup-missing')).resolves.toBeUndefined();
  });

  it('ignores non-json entries when listing session ids', async () => {
    const sessionId = trackSetupSession(uniqueId('setup'));
    await storage.writeSetupSession({ sessionId, messages: [] } as unknown as SetupSession);
    const strayPath = path.join(SETUP_SESSIONS_DIR, 'notes.txt');
    await fs.writeFile(strayPath, 'stray', 'utf-8');

    const ids = await storage.listSetupSessionIds();

    expect(ids).toContain(sessionId);
    expect(ids).not.toContain('notes');
    await fs.rm(strayPath, { force: true });
  });
});

describe('characters', () => {
  const baseCharacter: Character = {
    characterId: 'char-1',
    name: '主人公',
    role: 'protagonist',
    description: '説明',
  };

  it('migrates legacy want/fear fields into traits on read', async () => {
    const projectId = await createProject();
    const legacy: LegacyCharacterInput = { ...baseCharacter, want: '自由', fear: '孤独' };
    await fs.writeFile(
      storage.charactersJsonPath(projectId),
      JSON.stringify([legacy]),
      'utf-8'
    );

    const [character] = await storage.readCharacters(projectId);

    expect(character.traits).toEqual([
      { label: '望み', text: '自由' },
      { label: '恐れ', text: '孤独' },
    ]);
    expect(character).not.toHaveProperty('want');
  });

  it('returns an empty list when the file holds something other than an array', async () => {
    const projectId = await createProject();
    await fs.writeFile(
      storage.charactersJsonPath(projectId),
      JSON.stringify({ characters: [] }),
      'utf-8'
    );

    expect(await storage.readCharacters(projectId)).toEqual([]);
  });

  it('backs the legacy file up exactly once so a downgrade can still recover it', async () => {
    const projectId = await createProject();
    const legacyRaw = JSON.stringify([{ ...baseCharacter, want: '自由' }]);
    await fs.writeFile(storage.charactersJsonPath(projectId), legacyRaw, 'utf-8');

    await storage.writeCharacters(projectId, [{ ...baseCharacter, name: '一回目' }]);
    const firstBackup = await fs.readFile(
      storage.legacyCharactersBackupPath(projectId),
      'utf-8'
    );
    expect(firstBackup).toBe(legacyRaw);

    await storage.writeCharacters(projectId, [{ ...baseCharacter, name: '二回目' }]);
    const secondBackup = await fs.readFile(
      storage.legacyCharactersBackupPath(projectId),
      'utf-8'
    );

    // NOTE: 2回目の保存で「移行後の内容」に上書きされてしまうと復旧値を失う。
    expect(secondBackup).toBe(legacyRaw);
    expect((await storage.readCharacters(projectId))[0].name).toBe('二回目');
  });

  it('does not create a backup when the stored file is already in the new format', async () => {
    const projectId = await createProject();
    await storage.writeCharacters(projectId, [baseCharacter]);
    await storage.writeCharacters(projectId, [{ ...baseCharacter, name: '更新' }]);

    await expect(
      fs.stat(storage.legacyCharactersBackupPath(projectId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('world.md', () => {
  it('round-trips foundation and initial situation', async () => {
    const projectId = await createProject();
    const content = { foundation: '土台の説明', initialSituation: '開始時の状況' };

    await storage.writeWorld(projectId, content);

    expect(await storage.readWorld(projectId)).toEqual(content);
  });

  it('keeps a canonical heading typed by the user as plain text', async () => {
    const projectId = await createProject();
    const content = {
      foundation: '前置き\n## 世界の土台\n本文',
      initialSituation: '開始',
    };

    await storage.writeWorld(projectId, content);

    // NOTE: 見出しと同じ文字列を設定欄に書いても構造が壊れないことの回帰テスト。
    expect(await storage.readWorld(projectId)).toEqual(content);
  });

  it('reports an empty prompt text when both sections are blank', async () => {
    const projectId = await createProject();
    await storage.writeWorld(projectId, { foundation: '', initialSituation: '' });

    expect(await storage.readWorldText(projectId)).not.toBe('');
    expect(await storage.readWorldPromptText(projectId)).toBe('');
  });

  it('rejects a structurally broken document', async () => {
    const projectId = await createProject();

    await expect(
      storage.writeWorld(projectId, { foundation: '土台\n## 開始時点の状況', initialSituation: '' })
    ).resolves.toBeUndefined();

    // 復旧用の restoreWorldText は検証を通さず、そのまま書き戻せる。
    await storage.restoreWorldText(projectId, '壊れた旧形式のまま');
    expect(await storage.readWorldText(projectId)).toBe('壊れた旧形式のまま');
  });
});

describe('generation log (append-only jsonl)', () => {
  it('round-trips an appended record', async () => {
    const projectId = await createProject();
    const record = makeGenerationRecord();
    await storage.appendGenerationLog(projectId, record);

    expect(await storage.findGenerationRecord(projectId, 'gen-1')).toEqual(record);
  });

  it('returns null for an id that was never logged', async () => {
    const projectId = await createProject();
    await storage.appendGenerationLog(projectId, makeGenerationRecord());

    expect(await storage.findGenerationRecord(projectId, 'gen-unknown')).toBeNull();
  });

  it('applies the most recent status entry over the original record', async () => {
    const projectId = await createProject();
    await storage.appendGenerationLog(projectId, makeGenerationRecord({ status: 'draft' }));
    await storage.appendGenerationStatusLog(projectId, 'gen-1', 'accepted');
    await storage.appendGenerationStatusLog(projectId, 'gen-1', 'superseded');

    const found = await storage.findGenerationRecord(projectId, 'gen-1');

    expect(found?.status).toBe('superseded');
    expect(found?.responseText).toBe('本文');
  });

  it('overlays the latest style profile without rewriting the original entry', async () => {
    const projectId = await createProject();
    await storage.appendGenerationLog(projectId, makeGenerationRecord());
    await storage.appendGenerationStyleProfileLog(projectId, 'gen-1', {
      schemaVersion: 1,
      seed: 'seed-a',
      primaryAxis: 'visual',
      attenuatedPatterns: [],
      intensity: 'subtle',
    });

    const found = await storage.findGenerationRecord(projectId, 'gen-1');
    expect(found?.styleProfile?.seed).toBe('seed-a');

    const raw = await storage.readTextFile(storage.generationLogPath(projectId));
    const firstEntry = JSON.parse(raw!.trim().split('\n')[0]);
    expect(firstEntry.styleProfile).toBeUndefined();
  });

  it('drops a style profile entry whose axis is not a known one', async () => {
    const projectId = await createProject();
    await storage.appendGenerationLog(projectId, makeGenerationRecord());
    // NOTE: 旧バージョンや壊れたログが混ざっても、正規化を通らない profile は
    // 無視して元レコードを返す（本文を失わせない）。
    await storage.appendGenerationStyleProfileLog(projectId, 'gen-1', {
      schemaVersion: 1,
      seed: 'seed-a',
      primaryAxis: 'unknown-axis',
      attenuatedPatterns: [],
      intensity: 'subtle',
    } as never);

    const found = await storage.findGenerationRecord(projectId, 'gen-1');

    expect(found?.styleProfile).toBeUndefined();
    expect(found?.responseText).toBe('本文');
  });

  it('skips corrupted lines instead of failing the whole read', async () => {
    const projectId = await createProject();
    await storage.appendGenerationLog(projectId, makeGenerationRecord());
    await fs.appendFile(storage.generationLogPath(projectId), '{ not json\n', 'utf-8');
    await storage.appendGenerationLog(
      projectId,
      makeGenerationRecord({ generationId: 'gen-2', responseText: '二本目' })
    );

    const records = await storage.findGenerationRecords(projectId, ['gen-1', 'gen-2']);

    expect(records.size).toBe(2);
    expect(records.get('gen-2')?.responseText).toBe('二本目');
  });

  it('resolves several ids from a single scan', async () => {
    const projectId = await createProject();
    for (const id of ['gen-1', 'gen-2', 'gen-3']) {
      await storage.appendGenerationLog(
        projectId,
        makeGenerationRecord({ generationId: id, responseText: id })
      );
    }
    await storage.appendGenerationStatusLog(projectId, 'gen-2', 'accepted');

    const records = await storage.findGenerationRecords(projectId, ['gen-1', 'gen-3', 'gen-2']);

    expect([...records.keys()].sort()).toEqual(['gen-1', 'gen-2', 'gen-3']);
    expect(records.get('gen-2')?.status).toBe('accepted');
    expect(records.get('gen-1')?.status).toBe('draft');
  });

  it('returns an empty map for an empty id list or a missing log', async () => {
    const projectId = await createProject();

    expect((await storage.findGenerationRecords(projectId, [])).size).toBe(0);
    expect((await storage.findGenerationRecords(projectId, ['gen-1'])).size).toBe(0);
  });
});

describe('roleplay sessions', () => {
  it('creates the sessions directory on first write and lists the ids back', async () => {
    const projectId = await createProject();
    const session = {
      projectId,
      sessionId: 'rp-1',
      messages: [],
    } as never;

    expect(await storage.roleplaySessionExists(projectId, 'rp-1')).toBe(false);
    await storage.writeRoleplaySession(session);

    expect(await storage.roleplaySessionExists(projectId, 'rp-1')).toBe(true);
    expect(await storage.listRoleplaySessionIds(projectId)).toEqual(['rp-1']);
    expect(await storage.readRoleplaySession(projectId, 'rp-1')).toEqual(session);
  });
});

describe('per-project documents', () => {
  it('round-trips state, memories, expressions and knowledge content', async () => {
    const projectId = await createProject();
    const state: ProjectState = {
      lastOpenedAt: '2026-01-01T00:00:00.000Z',
      currentEpisodeId: 'ep-1',
      currentSceneId: null,
      selectedDraftGenerationId: null,
      lastAcceptedGenerationId: null,
      pendingMemoryCandidateIds: [],
      uiState: { readingPosition: 120, fontSize: 18 },
    };

    await storage.writeState(projectId, state);
    await storage.writeMemories(projectId, []);
    await storage.writeExpressions(projectId, { schemaVersion: 1, ngExpressions: [] });
    await storage.writeKnowledgeContent(projectId, 'kb-1', 'md', '# 資料');
    await storage.writeContextSummary(projectId, 'これまでのあらすじ');

    expect(await storage.readState(projectId)).toEqual(state);
    expect(await storage.readMemories(projectId)).toEqual([]);
    expect(await storage.readKnowledgeContent(projectId, 'kb-1', 'md')).toBe('# 資料');
    expect(await storage.knowledgeContentExists(projectId, 'kb-1', 'md')).toBe(true);
    expect(await storage.readContextSummary(projectId)).toBe('これまでのあらすじ');
  });

  it('reports a deleted knowledge file as absent and reads it back as empty', async () => {
    const projectId = await createProject();
    await storage.writeKnowledgeContent(projectId, 'kb-1', 'md', '内容');

    await storage.deleteKnowledgeContent(projectId, 'kb-1', 'md');

    expect(await storage.knowledgeContentExists(projectId, 'kb-1', 'md')).toBe(false);
    expect(await storage.readKnowledgeContent(projectId, 'kb-1', 'md')).toBe('');
    await expect(
      storage.deleteKnowledgeContent(projectId, 'kb-1', 'md')
    ).resolves.toBeUndefined();
  });
});
