import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as storage from '../../src/server/services/storageService';
import { getRecentContext } from '../../src/server/prompts/contextAssembler';
import type { EpisodeRecord, GenerationRecord } from '../../src/server/types/index';

const projectId = 'proj-context-test';
const episodeId = 'ep-test';

function generation(generationId: string, sceneId: string, responseText: string): GenerationRecord {
  return {
    generationId,
    sceneId,
    episodeId,
    request: {
      wish: '',
      outputLength: 3000,
      previousContextText: '',
    },
    responseText,
    usedPresets: {
      narration: 'third-close',
      emotionDisplay: 'restrained',
      sceneProgression: 'immersive',
    },
    usedModel: {
      provider: 'openai',
      modelName: 'gpt-4o-mini',
    },
    referencedMemoryIds: [],
    status: 'accepted',
    createdAt: '2026-07-02T00:00:00Z',
    parentGenerationId: null,
  };
}

describe('storage paths', () => {
  it('rejects path traversal in project and episode ids', () => {
    expect(() => storage.projectDir('../escape')).toThrow(/Invalid projectId/);
    expect(() => storage.episodeJsonPath(projectId, '../episode')).toThrow(/Invalid episodeId/);
    expect(() => storage.generationMdPath(projectId, '../generation')).toThrow(/Invalid generationId/);
    expect(() => storage.setupSessionJsonPath('../setup')).toThrow(/Invalid sessionId/);
  });
});

describe('generation markdown storage', () => {
  beforeEach(async () => {
    await storage.deleteProjectDir(projectId);
    await storage.createProjectDir(projectId);
  });

  afterEach(async () => {
    await storage.deleteProjectDir(projectId);
  });

  it('writes and reads draft markdown files', async () => {
    await storage.writeGenerationMarkdown(projectId, 'gen-md-test', '本文です');

    await expect(storage.readGenerationMarkdown(projectId, 'gen-md-test')).resolves.toBe('本文です');
  });

  it('writes and reads generation prompt snapshots separately from the log', async () => {
    await storage.writeGenerationPromptSnapshot(projectId, 'gen-prompt-test', 'PROMPT_TEXT');

    await expect(storage.readGenerationPromptSnapshot(projectId, 'gen-prompt-test')).resolves.toBe(
      'PROMPT_TEXT'
    );
    expect(storage.generationPromptPath(projectId, 'gen-prompt-test')).toContain(
      'gen-prompt-test.prompt.txt'
    );
  });

  it('reconstructs generation records from compact status log entries', async () => {
    await storage.appendGenerationLog(projectId, generation('gen-status-test', 'scene-status', '本文'));
    await storage.appendGenerationStatusLog(projectId, 'gen-status-test', 'accepted');

    await expect(storage.findGenerationRecord(projectId, 'gen-status-test')).resolves.toMatchObject({
      generationId: 'gen-status-test',
      responseText: '本文',
      status: 'accepted',
    });
  });

  it('uses the newest compact status when a generation has multiple status entries', async () => {
    await storage.appendGenerationLog(projectId, generation('gen-status-multi', 'scene-status', '本文'));
    await storage.appendGenerationStatusLog(projectId, 'gen-status-multi', 'accepted');
    await storage.appendGenerationStatusLog(projectId, 'gen-status-multi', 'rejected');

    await expect(storage.findGenerationRecord(projectId, 'gen-status-multi')).resolves.toMatchObject({
      generationId: 'gen-status-multi',
      status: 'rejected',
    });
  });

  it('merges the newest style profile metadata into an append-only generation record', async () => {
    await storage.appendGenerationLog(
      projectId,
      generation('gen-style-profile', 'scene-style', '本文')
    );
    const styleProfile = {
      schemaVersion: 1 as const,
      seed: 'fallback-seed',
      primaryAxis: 'auditory' as const,
      entryChannel: 'sound' as const,
      attenuatedPatterns: ['沈黙で閉じる'],
      intensity: 'subtle' as const,
    };
    await storage.appendGenerationStyleProfileLog(
      projectId,
      'gen-style-profile',
      styleProfile
    );

    await expect(storage.findGenerationRecord(projectId, 'gen-style-profile')).resolves.toMatchObject({
      generationId: 'gen-style-profile',
      styleProfile,
    });
  });

  it('ignores an invalid style-profile metadata entry instead of replacing a valid profile', async () => {
    const validProfile = {
      schemaVersion: 1 as const,
      seed: 'valid-seed',
      primaryAxis: 'somatic' as const,
      entryChannel: 'pressure' as const,
      attenuatedPatterns: [],
      intensity: 'subtle' as const,
    };
    await storage.appendGenerationLog(projectId, {
      ...generation('gen-invalid-style-profile', 'scene-style-invalid', '本文'),
      styleProfile: validProfile,
    });
    await storage.appendGenerationStyleProfileLog(
      projectId,
      'gen-invalid-style-profile',
      { schemaVersion: 99, seed: '', primaryAxis: 'unknown' } as never
    );

    await expect(
      storage.findGenerationRecord(projectId, 'gen-invalid-style-profile')
    ).resolves.toMatchObject({ styleProfile: validProfile });
  });

  it('resolves multiple generation records and their latest statuses in one lookup', async () => {
    await storage.appendGenerationLog(projectId, generation('gen-batch-one', 'scene-one', '本文1'));
    await storage.appendGenerationLog(projectId, generation('gen-batch-two', 'scene-two', '本文2'));
    await storage.appendGenerationStatusLog(projectId, 'gen-batch-two', 'superseded');

    const records = await storage.findGenerationRecords(projectId, [
      'gen-batch-one',
      'gen-batch-two',
      'missing',
    ]);

    expect(records.get('gen-batch-one')).toMatchObject({ status: 'accepted', responseText: '本文1' });
    expect(records.get('gen-batch-two')).toMatchObject({ status: 'superseded', responseText: '本文2' });
    expect(records.has('missing')).toBe(false);
  });
});

describe('character storage migration', () => {
  beforeEach(async () => {
    await storage.deleteProjectDir(projectId);
    await storage.createProjectDir(projectId);
  });

  afterEach(async () => {
    await storage.deleteProjectDir(projectId);
  });

  it('normalizes legacy fields on read and creates a one-time backup before write', async () => {
    const legacy = [
      {
        characterId: 'char-a',
        name: 'アリス',
        role: 'protagonist',
        description: '主人公',
        want: '自由になりたい',
        fear: '忘れられること',
      },
    ];
    const raw = JSON.stringify(legacy, null, 2);
    await fs.writeFile(storage.charactersJsonPath(projectId), raw, 'utf-8');

    const characters = await storage.readCharacters(projectId);
    expect(characters[0].traits).toEqual([
      { label: '望み', text: '自由になりたい' },
      { label: '恐れ', text: '忘れられること' },
    ]);
    await expect(fs.readFile(storage.charactersJsonPath(projectId), 'utf-8')).resolves.toBe(raw);

    await storage.writeCharacters(projectId, characters);
    await expect(
      fs.readFile(storage.legacyCharactersBackupPath(projectId), 'utf-8')
    ).resolves.toBe(raw);
    const migrated = JSON.parse(
      await fs.readFile(storage.charactersJsonPath(projectId), 'utf-8')
    ) as Array<Record<string, unknown>>;
    expect(migrated[0]).not.toHaveProperty('want');
    expect(migrated[0]).not.toHaveProperty('fear');

    await storage.writeCharacters(projectId, [
      { ...characters[0], traits: [{ label: 'こだわり', text: '紅茶' }] },
    ]);
    await expect(
      fs.readFile(storage.legacyCharactersBackupPath(projectId), 'utf-8')
    ).resolves.toBe(raw);
  });

  it('does not create a legacy backup for a project already using traits', async () => {
    await storage.writeCharacters(projectId, [
      {
        characterId: 'char-a',
        name: 'アリス',
        role: 'protagonist',
        description: '主人公',
        traits: [{ label: 'こだわり', text: '紅茶は熱いうちに飲む' }],
      },
    ]);

    await expect(
      fs.stat(storage.legacyCharactersBackupPath(projectId))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('getRecentContext', () => {
  beforeEach(async () => {
    await storage.deleteProjectDir(projectId);
    await storage.createProjectDir(projectId);
  });

  afterEach(async () => {
    await storage.deleteProjectDir(projectId);
  });

  it('does not include accepted scenes after the current scene', async () => {
    const episode: EpisodeRecord = {
      episodeId,
      title: 'Episode 1',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      scenes: [
        {
          sceneId: 'scene-one',
          episodeId,
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-one',
          draftGenerationIds: [],
        },
        {
          sceneId: 'scene-two',
          episodeId,
          order: 2,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-two',
          draftGenerationIds: [],
        },
        {
          sceneId: 'scene-three',
          episodeId,
          order: 3,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-three',
          draftGenerationIds: [],
        },
      ],
    };

    await storage.writeEpisodeRecord(projectId, episode);
    await storage.appendGenerationLog(projectId, generation('gen-one', 'scene-one', 'SCENE_ONE'));
    await storage.appendGenerationLog(projectId, generation('gen-two', 'scene-two', 'SCENE_TWO'));
    await storage.appendGenerationLog(projectId, generation('gen-three', 'scene-three', 'SCENE_THREE_FUTURE'));

    const context = await getRecentContext(projectId, episodeId, 'scene-two', { maxChars: 200 });

    expect(context).toContain('SCENE_ONE');
    expect(context).toContain('SCENE_TWO');
    expect(context).not.toContain('SCENE_THREE_FUTURE');
  });

  it('keeps the latest accepted scene when context is truncated', async () => {
    const episode: EpisodeRecord = {
      episodeId,
      title: '第1章',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      scenes: [
        {
          sceneId: 'scene-old',
          episodeId,
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-old',
          draftGenerationIds: [],
        },
        {
          sceneId: 'scene-middle',
          episodeId,
          order: 2,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-middle',
          draftGenerationIds: [],
        },
        {
          sceneId: 'scene-latest',
          episodeId,
          order: 3,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-latest',
          draftGenerationIds: [],
        },
      ],
    };

    await storage.writeEpisodeRecord(projectId, episode);
    await storage.appendGenerationLog(projectId, generation('gen-old', 'scene-old', '古い場面'.repeat(80)));
    await storage.appendGenerationLog(projectId, generation('gen-middle', 'scene-middle', '中間場面'.repeat(80)));
    await storage.appendGenerationLog(projectId, generation('gen-latest', 'scene-latest', '最新場面を読む'));

    const context = await getRecentContext(projectId, episodeId, 'scene-latest', { maxChars: 20 });

    expect(context).toContain('最新場面を読む');
    expect(context).not.toContain('古い場面');
  });

  it('drops a partial leading paragraph after truncating recent context', async () => {
    const sceneId = 'scene-boundary';
    const generationId = 'gen-boundary';
    const episode: EpisodeRecord = {
      episodeId,
      title: '境界テスト',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      scenes: [
        {
          sceneId,
          episodeId,
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: generationId,
          draftGenerationIds: [],
        },
      ],
    };
    const responseText = `${'前'.repeat(100)}途中の文。\n段落の先頭から続く本文。`;

    await storage.writeEpisodeRecord(projectId, episode);
    await storage.appendGenerationLog(projectId, generation(generationId, sceneId, responseText));

    const context = await getRecentContext(projectId, episodeId, sceneId, { maxChars: 40 });

    expect(context).toBe('段落の先頭から続く本文。');
  });
});
