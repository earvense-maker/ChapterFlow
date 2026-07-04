import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      genre: 'modern-drama',
      style: 'quiet',
      pov: 'third-person-close',
      pacing: 'slow',
      density: 'dialogue-rich',
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
});
