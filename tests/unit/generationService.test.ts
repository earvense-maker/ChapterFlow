import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as generationService from '../../src/server/services/generationService';
import * as expressionService from '../../src/server/services/expressionService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { OpenRouterAdapter } from '../../src/server/adapters/openrouterAdapter';
import { ModelAdapterError } from '../../src/server/adapters/modelAdapter';
import type {
  AdapterGenerateStreamEvent,
  EpisodeRecord,
  GenerationRecord,
  Project,
  StoryState,
} from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<Project> {
  const project = await projectService.createProject({ title: 'Generation Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

async function writeAcceptedScene(projectId: string, text: string): Promise<void> {
  const episodeId = 'ep-1';
  const sceneId = 'scene-1';
  const generationId = 'gen-1';
  const episode: EpisodeRecord = {
    episodeId,
    title: '第1章',
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
        draftGenerationIds: [generationId],
      },
    ],
  };
  const generation: GenerationRecord = {
    generationId,
    sceneId,
    episodeId,
    request: { wish: '', outputLength: 1000, previousContextText: '' },
    responseText: text,
    usedPresets: {
      narration: 'third-close',
    },
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    referencedMemoryIds: [],
    status: 'accepted',
    createdAt: '2026-07-02T00:00:00Z',
    parentGenerationId: null,
  };
  await storage.writeEpisodeRecord(projectId, episode);
  await storage.appendGenerationLog(projectId, generation);
  const state = await storage.readState(projectId);
  if (state) {
    await storage.writeState(projectId, {
      ...state,
      currentEpisodeId: episodeId,
      currentSceneId: sceneId,
    });
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

describe('generationService generation', () => {
  it('records bannedExpressions in GenerationRecord', async () => {
    const project = await createTrackedProject();
    await expressionService.createExpression(project.projectId, { text: '避けたい表現' });

    const adapter = new GeminiAdapter();
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: '生成された本文',
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(adapter, 'validateConnection').mockResolvedValue({ ok: true });

    // generationService はモジュール読み込み時にアダプタマップを作るため、
    // 同じインスタンスのメソッドをスパイする
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(adapter.generateText);

    const record = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });

    expect(record.bannedExpressions).toContain('避けたい表現');
  });

  it('records the model actually selected by the OpenRouter free router', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      activeModelProvider: 'openrouter',
      activeModelName: 'openrouter/free',
    });
    vi.spyOn(OpenRouterAdapter.prototype, 'generateText').mockResolvedValue({
      text: 'OpenRouterで生成された本文',
      finishReason: 'stop',
      retryable: false,
      resolvedModelName: 'qwen/qwen3-free-test',
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });

    expect(record.usedModel).toEqual({
      provider: 'openrouter',
      modelName: 'qwen/qwen3-free-test',
    });
  });

  it('retries without penalties after an invalid argument error', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: 0.5, presencePenalty: 0.5 },
    });

    const calls: { frequencyPenalty?: number; presencePenalty?: number }[] = [];
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      calls.push({
        frequencyPenalty: request.frequencyPenalty,
        presencePenalty: request.presencePenalty,
      });
      if (calls.length === 1) {
        return {
          text: '',
          finishReason: 'error',
          errorCode: 'invalid_request_error',
          errorMessage: 'Gemini API error: 400',
          retryable: false,
        };
      }
      return { text: '再試行成功', finishReason: 'stop', retryable: false };
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });

    expect(calls.length).toBe(2);
    expect(calls[0].frequencyPenalty).toBe(0.5);
    expect(calls[1].frequencyPenalty).toBeUndefined();
    expect(record.responseText).toBe('再試行成功');
  });

  it('retries streaming generation without penalties after an invalid argument before first chunk', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: 0.4, presencePenalty: 0.4 },
    });

    const calls: { frequencyPenalty?: number; presencePenalty?: number }[] = [];
    let callCount = 0;
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(async function* (
      request
    ) {
      callCount++;
      calls.push({
        frequencyPenalty: request.frequencyPenalty,
        presencePenalty: request.presencePenalty,
      });
      if (callCount === 1) {
        throw new ModelAdapterError(
          'INVALID_ARGUMENT: unsupported field',
          'invalid_request_error',
          false
        );
      }
      const events: AdapterGenerateStreamEvent[] = [
        { type: 'chunk', text: '再試行' },
        { type: 'done', finishReason: 'stop' },
      ];
      for (const event of events) yield event;
    });

    const chunks: string[] = [];
    const record = await generationService.generateSceneStream(
      project.projectId,
      { wish: '続き', mode: 'continue' },
      (text) => chunks.push(text)
    );

    expect(callCount).toBe(2);
    expect(calls[0].frequencyPenalty).toBe(0.4);
    expect(calls[1].frequencyPenalty).toBeUndefined();
    expect(chunks).toContain('再試行');
    expect(record.responseText).toBe('再試行');
  });

  it('includes Gemini diagnostics in non-streaming content filter errors', async () => {
    const project = await createTrackedProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'content_filter',
      retryable: false,
      debugInfo:
        'finishReason=content_filter candidates=1 parts=none candidateSafety=HARASSMENT=HIGH(blocked)',
    });

    await expect(
      generationService.generateScene(project.projectId, {
        wish: '続き',
        mode: 'continue',
      })
    ).rejects.toMatchObject({
      code: 'content_filter',
      retryable: false,
      message: expect.stringContaining('candidateSafety=HARASSMENT=HIGH(blocked)'),
    });
  });

  it('includes Gemini diagnostics in streaming content filter errors', async () => {
    const project = await createTrackedProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(async function* () {
      yield {
        type: 'done',
        finishReason: 'content_filter',
        debugInfo:
          'finishReason=content_filter candidates=1 parts=none candidateSafety=HARASSMENT=HIGH(blocked)',
      };
    });

    await expect(
      generationService.generateSceneStream(
        project.projectId,
        { wish: '続き', mode: 'continue' },
        () => undefined
      )
    ).rejects.toMatchObject({
      code: 'content_filter',
      retryable: false,
      message: expect.stringContaining('candidateSafety=HARASSMENT=HIGH(blocked)'),
    });
  });

  it('does not pass penalties to context compression', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: 0.6, presencePenalty: 0.6 },
    });
    await writeAcceptedScene(project.projectId, 'これは圧縮対象の本文です。');

    let capturedRequest: { frequencyPenalty?: number; presencePenalty?: number } | undefined;
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      capturedRequest = {
        frequencyPenalty: request.frequencyPenalty,
        presencePenalty: request.presencePenalty,
      };
      return { text: '要約', finishReason: 'stop', retryable: false };
    });

    await generationService.compressProjectContext(project.projectId);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.frequencyPenalty).toBeUndefined();
    expect(capturedRequest!.presencePenalty).toBeUndefined();
  });
});

describe('generationService state operations', () => {
  it('does not mark the pending accepted generation as processed during legacy story-state initialization', async () => {
    const project = await createTrackedProject();
    const episode: EpisodeRecord = {
      episodeId: 'ep-backlog',
      title: 'Episode',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      scenes: [
        {
          sceneId: 'scene-old',
          episodeId: 'ep-backlog',
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-old',
          draftGenerationIds: ['gen-old'],
        },
        {
          sceneId: 'scene-new',
          episodeId: 'ep-backlog',
          order: 2,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-new',
          draftGenerationIds: ['gen-new'],
        },
      ],
    };
    await storage.writeEpisodeRecord(project.projectId, episode);

    for (const generationId of ['gen-old', 'gen-new']) {
      await storage.appendGenerationLog(project.projectId, {
        generationId,
        sceneId: generationId === 'gen-old' ? 'scene-old' : 'scene-new',
        episodeId: 'ep-backlog',
        request: { wish: '', outputLength: 1000, previousContextText: '' },
        responseText: `${generationId} text`,
        usedPresets: project.activePresetIds,
        usedModel: { provider: 'gemini', modelName: 'gemini-test' },
        referencedMemoryIds: [],
        status: 'accepted',
        createdAt: '2026-07-02T00:00:00Z',
        parentGenerationId: null,
      });
    }

    await storage.writeStoryState(project.projectId, {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      updatedAt: '2026-07-02T00:00:00Z',
    } as StoryState);
    const state = await storage.readState(project.projectId);
    expect(state).not.toBeNull();
    await storage.writeState(project.projectId, {
      ...state!,
      storyStateRefresh: {
        status: 'pending',
        generationId: 'gen-new',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    });

    const backlog = await generationService.calculateStoryStateBacklog(project.projectId);

    expect(backlog.map((item) => item.generationId)).toEqual(['gen-new']);
    await expect(storage.readStoryState(project.projectId)).resolves.toMatchObject({
      processedGenerationIds: ['gen-old'],
    });
  });

  it.todo('acceptGeneration marks a draft as accepted');
  it.todo('rejectGeneration marks a draft as rejected');
  it('navigates backward and forward between drafts', async () => {
    const project = await createTrackedProject();
    const episodeId = 'ep-drafts';
    const sceneId = 'scene-drafts';
    const draftIds = ['gen-a', 'gen-b', 'gen-c'];
    await storage.writeEpisodeRecord(project.projectId, {
      episodeId,
      title: '案移動',
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
          acceptedGenerationId: null,
          draftGenerationIds: draftIds,
        },
      ],
    });
    for (const generationId of draftIds) {
      await storage.appendGenerationLog(project.projectId, {
        generationId,
        episodeId,
        sceneId,
        request: { wish: '', outputLength: 1000, previousContextText: '' },
        responseText: generationId,
        usedPresets: project.activePresetIds,
        usedModel: { provider: 'gemini', modelName: 'gemini-test' },
        referencedMemoryIds: [],
        status: 'draft',
        createdAt: '2026-07-02T00:00:00Z',
        parentGenerationId: null,
      });
    }
    const state = await storage.readState(project.projectId);
    await storage.writeState(project.projectId, {
      ...state!,
      currentEpisodeId: episodeId,
      currentSceneId: sceneId,
      selectedDraftGenerationId: 'gen-b',
    });

    await expect(generationService.navigateDraft(project.projectId, 'previous')).resolves.toMatchObject({
      generationId: 'gen-a',
    });
    await expect(generationService.navigateDraft(project.projectId, 'next')).resolves.toMatchObject({
      generationId: 'gen-b',
    });
    await expect(generationService.navigateDraft(project.projectId, 'next')).resolves.toMatchObject({
      generationId: 'gen-c',
    });
    await expect(generationService.navigateDraft(project.projectId, 'next')).resolves.toBeNull();
  });
});
