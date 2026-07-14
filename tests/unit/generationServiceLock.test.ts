import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as generationService from '../../src/server/services/generationService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { withDataDirLock } from '../../src/server/services/dataDirLock';
import type { EpisodeRecord, GenerationRecord } from '../../src/server/types/index';

const openAiGenerateTextMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/server/adapters/openaiAdapter', () => ({
  OpenAIAdapter: class {
    providerName = 'openai';

    generateText = openAiGenerateTextMock;

    validateConnection = vi.fn();
  },
}));

vi.mock('../../src/server/adapters/geminiAdapter', () => ({
  GeminiAdapter: class {
    providerName = 'gemini';
    generateText = vi.fn();
    validateConnection = vi.fn();
  },
}));

vi.mock('../../src/server/adapters/deepseekAdapter', () => ({
  DeepSeekAdapter: class {
    providerName = 'deepseek';
    generateText = vi.fn();
    validateConnection = vi.fn();
  },
}));

vi.mock('../../src/server/services/credentialService', () => ({
  reloadCredentials: vi.fn(async () => undefined),
  getCredential: vi.fn(),
  loadCredentials: vi.fn(async () => ({})),
}));

const createdProjectIds: string[] = [];

beforeEach(() => {
  openAiGenerateTextMock.mockReset();
  openAiGenerateTextMock.mockResolvedValue({
    text: 'STREAM_FALLBACK_TEXT',
    finishReason: 'stop',
    retryable: false,
  });
});

afterEach(async () => {
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('generationService project write lock', () => {
  it('does not deadlock when streaming generation falls back to non-streaming generation', async () => {
    const project = await projectService.createProject({
      title: 'Lock Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
      streamingEnabled: true,
    });
    createdProjectIds.push(project.projectId);

    const chunks: string[] = [];
    const record = await withTimeout(
      generationService.generateSceneStream(
        project.projectId,
        { wish: '静かに始める', mode: 'continue' },
        (chunk) => chunks.push(chunk)
      ),
      1000
    );

    expect(record.responseText).toBe('STREAM_FALLBACK_TEXT');
    expect(chunks).toEqual(['STREAM_FALLBACK_TEXT']);
    expect(record.request.previousContextText).not.toContain('【出力形式】');
    expect(record.request.previousContextFilePath).toContain(`${record.generationId}.prompt.txt`);
    await expect(
      storage.readGenerationPromptSnapshot(project.projectId, record.generationId)
    ).resolves.toContain('【出力形式】');
  });

  it('does not hold the project write lock while background story state refresh waits on the model', async () => {
    const project = await projectService.createProject({
      title: 'Background Refresh Lock Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
    });
    createdProjectIds.push(project.projectId);

    const state = await storage.readState(project.projectId);
    if (!state) throw new Error('state missing');

    const episodeId = 'ep-lock-test';
    const sceneId = 'scene-lock-test';
    const generationId = 'gen-lock-test';
    const episode: EpisodeRecord = {
      episodeId,
      title: '第1章',
      order: 1,
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      scenes: [
        {
          sceneId,
          episodeId,
          order: 1,
          createdAt: '2026-07-04T12:00:00.000Z',
          updatedAt: '2026-07-04T12:00:00.000Z',
          acceptedGenerationId: null,
          draftGenerationIds: [generationId],
        },
      ],
    };
    const generation: GenerationRecord = {
      generationId,
      sceneId,
      episodeId,
      request: {
        wish: '',
        outputLength: project.outputLength,
        previousContextText: '',
      },
      responseText: '採用する本文',
      usedPresets: project.activePresetIds,
      usedModel: {
        provider: project.activeModelProvider,
        modelName: project.activeModelName,
      },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-04T12:00:00.000Z',
      parentGenerationId: null,
    };

    await storage.writeEpisodeRecord(project.projectId, episode);
    await storage.appendGenerationLog(project.projectId, generation);
    await storage.writeState(project.projectId, {
      ...state,
      currentEpisodeId: episodeId,
      currentSceneId: sceneId,
      selectedDraftGenerationId: generationId,
    });

    let resolveBackgroundRefresh!: () => void;
    openAiGenerateTextMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveBackgroundRefresh = () => resolve({
          text: '{}',
          finishReason: 'stop',
          retryable: false,
        });
      })
    );

    await generationService.acceptGeneration(project.projectId, generationId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      withTimeout(generationService.navigateScene(project.projectId, 'next'), 500)
    ).resolves.toMatchObject({
      project: expect.objectContaining({ projectId: project.projectId }),
    });

    resolveBackgroundRefresh();
    await withTimeout(withDataDirLock(async () => undefined), 1000);
  });

  it('holds the data directory write scope while background story state refresh waits on the model', async () => {
    const project = await projectService.createProject({
      title: 'Background Refresh Data Lock Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
    });
    createdProjectIds.push(project.projectId);

    const state = await storage.readState(project.projectId);
    if (!state) throw new Error('state missing');

    const episodeId = 'ep-data-lock-test';
    const sceneId = 'scene-data-lock-test';
    const generationId = 'gen-data-lock-test';
    const episode: EpisodeRecord = {
      episodeId,
      title: '第1章',
      order: 1,
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      scenes: [
        {
          sceneId,
          episodeId,
          order: 1,
          createdAt: '2026-07-04T12:00:00.000Z',
          updatedAt: '2026-07-04T12:00:00.000Z',
          acceptedGenerationId: null,
          draftGenerationIds: [generationId],
        },
      ],
    };
    const generation: GenerationRecord = {
      generationId,
      sceneId,
      episodeId,
      request: {
        wish: '',
        outputLength: project.outputLength,
        previousContextText: '',
      },
      responseText: '採用する本文',
      usedPresets: project.activePresetIds,
      usedModel: {
        provider: project.activeModelProvider,
        modelName: project.activeModelName,
      },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-04T12:00:00.000Z',
      parentGenerationId: null,
    };

    await storage.writeEpisodeRecord(project.projectId, episode);
    await storage.appendGenerationLog(project.projectId, generation);
    await storage.writeState(project.projectId, {
      ...state,
      currentEpisodeId: episodeId,
      currentSceneId: sceneId,
      selectedDraftGenerationId: generationId,
    });

    let resolveModel!: () => void;
    openAiGenerateTextMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveModel = () => resolve({
          text: '{}',
          finishReason: 'stop',
          retryable: false,
        });
      })
    );

    await generationService.acceptGeneration(project.projectId, generationId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    let lockEntered = false;
    const lockPromise = withDataDirLock(async () => {
      lockEntered = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lockEntered).toBe(false);

    resolveModel();
    await withTimeout(lockPromise, 1000);
    expect(lockEntered).toBe(true);
  });
});

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for generation')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
