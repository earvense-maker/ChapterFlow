import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as generationService from '../../src/server/services/generationService';
import * as expressionService from '../../src/server/services/expressionService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { OpenRouterAdapter } from '../../src/server/adapters/openrouterAdapter';
import { ModelAdapterError } from '../../src/server/adapters/modelAdapter';
import { withDataDirLock } from '../../src/server/services/dataDirLock';
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
  // This suite exercises pre-existing generation and story-state behavior.
  // Post-generation automation has dedicated lifecycle coverage below.
  return projectService.updateProject(project.projectId, {
    refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
  });
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

async function writePendingRefreshScenario(
  project: Project,
  mode: 'next-scene' | 'replacement'
): Promise<{ firstGenerationId: string; secondGenerationId: string }> {
  const episodeId = 'ep-pending-refresh';
  const firstGenerationId = 'gen-pending-a';
  const secondGenerationId = 'gen-pending-b';
  const firstSceneId = 'scene-pending-a';
  const secondSceneId = mode === 'replacement' ? firstSceneId : 'scene-pending-b';
  const scenes: EpisodeRecord['scenes'] =
    mode === 'replacement'
      ? [
          {
            sceneId: firstSceneId,
            episodeId,
            order: 1,
            createdAt: '2026-07-02T00:00:00Z',
            updatedAt: '2026-07-02T00:00:00Z',
            acceptedGenerationId: firstGenerationId,
            draftGenerationIds: [firstGenerationId, secondGenerationId],
          },
        ]
      : [
          {
            sceneId: firstSceneId,
            episodeId,
            order: 1,
            createdAt: '2026-07-02T00:00:00Z',
            updatedAt: '2026-07-02T00:00:00Z',
            acceptedGenerationId: firstGenerationId,
            draftGenerationIds: [firstGenerationId],
          },
          {
            sceneId: secondSceneId,
            episodeId,
            order: 2,
            createdAt: '2026-07-02T00:01:00Z',
            updatedAt: '2026-07-02T00:01:00Z',
            acceptedGenerationId: null,
            draftGenerationIds: [secondGenerationId],
          },
        ];
  const episode: EpisodeRecord = {
    episodeId,
    title: 'Pending refresh',
    order: 1,
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    scenes,
  };
  const generations: GenerationRecord[] = [
    {
      generationId: firstGenerationId,
      sceneId: firstSceneId,
      episodeId,
      request: { wish: 'first', outputLength: 1000, previousContextText: '' },
      responseText: 'first accepted text',
      usedPresets: project.activePresetIds,
      usedModel: { provider: 'gemini', modelName: 'gemini-test' },
      referencedMemoryIds: [],
      status: 'accepted',
      createdAt: '2026-07-02T00:00:00Z',
      parentGenerationId: null,
    },
    {
      generationId: secondGenerationId,
      sceneId: secondSceneId,
      episodeId,
      request: { wish: 'second', outputLength: 1000, previousContextText: '' },
      responseText: 'second accepted text',
      usedPresets: project.activePresetIds,
      usedModel: { provider: 'gemini', modelName: 'gemini-test' },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-02T00:01:00Z',
      parentGenerationId: mode === 'replacement' ? firstGenerationId : null,
    },
  ];

  await storage.writeEpisodeRecord(project.projectId, episode);
  for (const generation of generations) {
    await storage.appendGenerationLog(project.projectId, generation);
  }
  await storage.writeStoryState(project.projectId, {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    processedGenerationIds: [],
    updatedAt: '2026-07-02T00:00:00Z',
  } as StoryState);
  const state = await storage.readState(project.projectId);
  if (!state) throw new Error('state missing');
  await storage.writeState(project.projectId, {
    ...state,
    currentEpisodeId: episodeId,
    currentSceneId: secondSceneId,
    selectedDraftGenerationId: secondGenerationId,
    lastAcceptedGenerationId: firstGenerationId,
    storyStateRefresh: {
      status: 'pending',
      generationId: firstGenerationId,
      updatedAt: '2026-07-02T00:00:00Z',
    },
  });

  return { firstGenerationId, secondGenerationId };
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
    expect(record.finishReason).toBe('stop');
  });

  it('keeps a length-limited response as a draft and records why it ended', async () => {
    const project = await createTrackedProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '上限まで生成された本文',
      finishReason: 'length',
      retryable: false,
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });

    expect(record.responseText).toBe('上限まで生成された本文');
    expect(record.status).toBe('draft');
    expect(record.finishReason).toBe('length');
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

  it('keeps the read-only backlog query from initializing legacy processed ids', async () => {
    const project = await createTrackedProject();
    await writeAcceptedScene(project.projectId, '未抽出の本文');
    await storage.writeStoryState(project.projectId, {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      updatedAt: '2026-07-02T00:00:00Z',
    } as StoryState);
    const state = await storage.readState(project.projectId);
    await storage.writeState(project.projectId, {
      ...state!,
      storyStateRefresh: {
        status: 'pending',
        generationId: 'gen-1',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    });

    await expect(generationService.readStoryStateBacklog(project.projectId)).resolves.toEqual([
      expect.objectContaining({ generationId: 'gen-1' }),
    ]);
    await expect(storage.readStoryState(project.projectId)).resolves.not.toMatchObject({
      processedGenerationIds: expect.anything(),
    });
  });

  it('seeds legacy processed ids before an acceptance-triggered refresh applies', async () => {
    const project = await createTrackedProject();
    const episodeId = 'ep-legacy-refresh';
    const oldGenerationId = 'gen-legacy-old';
    const newGenerationId = 'gen-legacy-new';
    await storage.writeEpisodeRecord(project.projectId, {
      episodeId,
      title: 'Legacy refresh',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:01:00Z',
      scenes: [
        {
          sceneId: 'scene-legacy-old',
          episodeId,
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: oldGenerationId,
          draftGenerationIds: [oldGenerationId],
        },
        {
          sceneId: 'scene-legacy-new',
          episodeId,
          order: 2,
          createdAt: '2026-07-02T00:01:00Z',
          updatedAt: '2026-07-02T00:01:00Z',
          acceptedGenerationId: null,
          draftGenerationIds: [newGenerationId],
        },
      ],
    });
    const generations: GenerationRecord[] = [
      {
        generationId: oldGenerationId,
        sceneId: 'scene-legacy-old',
        episodeId,
        request: { wish: 'old', outputLength: 1000, previousContextText: '' },
        responseText: 'legacy accepted text',
        usedPresets: project.activePresetIds,
        usedModel: { provider: 'gemini', modelName: 'gemini-test' },
        referencedMemoryIds: [],
        status: 'accepted',
        createdAt: '2026-07-02T00:00:00Z',
        parentGenerationId: null,
      },
      {
        generationId: newGenerationId,
        sceneId: 'scene-legacy-new',
        episodeId,
        request: { wish: 'new', outputLength: 1000, previousContextText: '' },
        responseText: 'new draft text',
        usedPresets: project.activePresetIds,
        usedModel: { provider: 'gemini', modelName: 'gemini-test' },
        referencedMemoryIds: [],
        status: 'draft',
        createdAt: '2026-07-02T00:01:00Z',
        parentGenerationId: null,
      },
    ];
    for (const generation of generations) {
      await storage.appendGenerationLog(project.projectId, generation);
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
    if (!state) throw new Error('state missing');
    await storage.writeState(project.projectId, {
      ...state,
      currentEpisodeId: episodeId,
      currentSceneId: 'scene-legacy-new',
      selectedDraftGenerationId: newGenerationId,
      lastAcceptedGenerationId: oldGenerationId,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{}',
      finishReason: 'stop',
      retryable: false,
    });

    await generationService.acceptGeneration(project.projectId, newGenerationId);
    await withDataDirLock(async () => undefined);

    await expect(storage.readStoryState(project.projectId)).resolves.toMatchObject({
      processedGenerationIds: [oldGenerationId, newGenerationId],
    });
    await expect(generationService.readStoryStateBacklog(project.projectId)).resolves.toEqual([]);
  });

  it('coalesces simultaneous manual story-state refreshes into one extraction job', async () => {
    const project = await createTrackedProject();
    await writeAcceptedScene(project.projectId, '再抽出対象の本文');
    const state = await storage.readState(project.projectId);
    await storage.writeState(project.projectId, {
      ...state!,
      storyStateRefresh: {
        status: 'pending',
        generationId: 'gen-1',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    });

    const adapterResult = deferred<{ text: string; finishReason: 'stop'; retryable: false }>();
    const adapterSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockReturnValue(adapterResult.promise);
    const first = generationService.refreshStoryState(project.projectId);
    await waitForCondition(() => adapterSpy.mock.calls.length === 1);
    const second = generationService.refreshStoryState(project.projectId);

    adapterResult.resolve({ text: '{}', finishReason: 'stop', retryable: false });
    await Promise.all([first, second]);

    expect(adapterSpy).toHaveBeenCalledTimes(1);
    await expect(storage.readState(project.projectId)).resolves.toMatchObject({
      storyStateRefresh: { status: 'fresh', generationId: 'gen-1' },
    });
  });

  it('processes accepted scenes queued while an active refresh succeeds', async () => {
    const project = await createTrackedProject();
    const { secondGenerationId } = await writePendingRefreshScenario(project, 'next-scene');
    const firstResult = deferred<{ text: string; finishReason: 'stop'; retryable: false }>();
    const secondResult = deferred<{ text: string; finishReason: 'stop'; retryable: false }>();
    const adapterSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateText')
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);

    const refresh = generationService.refreshStoryState(project.projectId);
    await waitForCondition(() => adapterSpy.mock.calls.length === 1);
    await generationService.acceptGeneration(project.projectId, secondGenerationId);

    firstResult.resolve({ text: '{}', finishReason: 'stop', retryable: false });
    await waitForCondition(() => adapterSpy.mock.calls.length === 2);
    secondResult.resolve({ text: '{}', finishReason: 'stop', retryable: false });
    await refresh;

    expect(adapterSpy).toHaveBeenCalledTimes(2);
    await expect(storage.readState(project.projectId)).resolves.toMatchObject({
      storyStateRefresh: { status: 'fresh', generationId: secondGenerationId },
    });
    await expect(storage.readStoryState(project.projectId)).resolves.toMatchObject({
      processedGenerationIds: ['gen-pending-a', secondGenerationId],
    });
  });

  it('marks the queued owner stale when an earlier active refresh fails', async () => {
    const project = await createTrackedProject();
    const { firstGenerationId, secondGenerationId } = await writePendingRefreshScenario(
      project,
      'next-scene'
    );
    const firstResult = deferred<{
      text: string;
      finishReason: 'error';
      retryable: false;
      errorMessage: string;
    }>();
    const adapterSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateText')
      .mockReturnValue(firstResult.promise);

    const refresh = generationService.refreshStoryState(project.projectId);
    await waitForCondition(() => adapterSpy.mock.calls.length === 1);
    await generationService.acceptGeneration(project.projectId, secondGenerationId);

    firstResult.resolve({
      text: '',
      finishReason: 'error',
      retryable: false,
      errorMessage: 'extraction failed',
    });
    await refresh;

    expect(adapterSpy).toHaveBeenCalledTimes(1);
    await expect(storage.readState(project.projectId)).resolves.toMatchObject({
      storyStateRefresh: {
        status: 'stale',
        generationId: secondGenerationId,
      },
    });
    await expect(generationService.readStoryStateBacklog(project.projectId)).resolves.toEqual([
      expect.objectContaining({ generationId: firstGenerationId }),
      expect.objectContaining({ generationId: secondGenerationId }),
    ]);
  });

  it('skips a superseded scene when its active extraction finishes', async () => {
    const project = await createTrackedProject();
    const { firstGenerationId, secondGenerationId } = await writePendingRefreshScenario(
      project,
      'replacement'
    );
    const firstResult = deferred<{ text: string; finishReason: 'stop'; retryable: false }>();
    const secondResult = deferred<{ text: string; finishReason: 'stop'; retryable: false }>();
    const adapterSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateText')
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);

    const refresh = generationService.refreshStoryState(project.projectId);
    await waitForCondition(() => adapterSpy.mock.calls.length === 1);
    await generationService.acceptGeneration(project.projectId, secondGenerationId);

    firstResult.resolve({ text: '{}', finishReason: 'stop', retryable: false });
    await waitForCondition(() => adapterSpy.mock.calls.length === 2);
    secondResult.resolve({ text: '{}', finishReason: 'stop', retryable: false });
    await refresh;

    await expect(storage.readStoryState(project.projectId)).resolves.toMatchObject({
      processedGenerationIds: [secondGenerationId],
    });
    await expect(generationService.findGeneration(project.projectId, firstGenerationId)).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it('accepts the selected draft, supersedes alternatives, and rebuilds the episode text', async () => {
    const project = await createTrackedProject();
    let callCount = 0;
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async () => {
      callCount += 1;
      return {
        // 3回目は採用後の非同期ストーリー状態更新用。空の差分JSONなら外部APIに出ない。
        text: callCount === 1 ? '最初の案' : callCount === 2 ? '採用する案' : '{}',
        finishReason: 'stop',
        retryable: false,
      };
    });

    const first = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });
    const second = await generationService.generateScene(project.projectId, {
      wish: '別案',
      mode: 'variate',
    });

    await expect(generationService.acceptGeneration(project.projectId, first.generationId)).rejects.toMatchObject({
      code: 'generation_not_selected',
      status: 409,
    });

    const accepted = await generationService.acceptGeneration(project.projectId);

    expect(accepted).toMatchObject({ generationId: second.generationId, status: 'accepted' });
    await expect(generationService.findGeneration(project.projectId, first.generationId)).resolves.toMatchObject({
      status: 'superseded',
    });
    await expect(generationService.findGeneration(project.projectId, second.generationId)).resolves.toMatchObject({
      status: 'accepted',
    });

    const episode = await storage.readEpisodeRecord(project.projectId, second.episodeId);
    const state = await storage.readState(project.projectId);
    expect(episode?.scenes[0]).toMatchObject({
      acceptedGenerationId: second.generationId,
      draftGenerationIds: [first.generationId, second.generationId],
    });
    expect(await storage.readEpisodeText(project.projectId, second.episodeId)).toBe('採用する案');
    expect(state).toMatchObject({
      selectedDraftGenerationId: second.generationId,
      lastAcceptedGenerationId: second.generationId,
      storyStateRefresh: { status: 'pending', generationId: second.generationId },
    });

    // acceptGeneration は本文の保存を待たせず、物語状態の更新をバックグラウンドで行う。
    // テストの後片付けで作品ディレクトリを消す前に、その処理がモデル呼び出しへ到達するのを待つ。
    await waitForCondition(() => callCount >= 3);
    await withDataDirLock(async () => undefined);
  });

  it('rejects the selected draft and selects the previous remaining draft', async () => {
    const project = await createTrackedProject();
    let callCount = 0;
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async () => {
      callCount += 1;
      return {
        text: callCount === 1 ? '残す案' : '却下する案',
        finishReason: 'stop',
        retryable: false,
      };
    });

    const first = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });
    const second = await generationService.generateScene(project.projectId, {
      wish: '別案',
      mode: 'variate',
    });

    const rejected = await generationService.rejectGeneration(project.projectId);

    expect(rejected).toMatchObject({ generationId: second.generationId, status: 'rejected' });
    await expect(generationService.findGeneration(project.projectId, first.generationId)).resolves.toMatchObject({
      status: 'draft',
    });
    await expect(generationService.findGeneration(project.projectId, second.generationId)).resolves.toMatchObject({
      status: 'rejected',
    });

    const episode = await storage.readEpisodeRecord(project.projectId, second.episodeId);
    const state = await storage.readState(project.projectId);
    expect(episode?.scenes[0]).toMatchObject({
      acceptedGenerationId: null,
      draftGenerationIds: [first.generationId],
    });
    expect(state?.selectedDraftGenerationId).toBe(first.generationId);
  });
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

  it.each(['scanning', 'awaitingAcceptance'] as const)(
    'keeps a %s maintenance run while the reader navigates to another scene',
    async (phase) => {
      const project = await createTrackedProject();
      const episodeId = 'ep-scene-navigation-maintenance';
      const sourceSceneId = 'scene-source';
      const otherSceneId = 'scene-other';
      const sourceGenerationId = 'gen-source-maintenance';
      const otherGenerationId = 'gen-other-maintenance';
      await storage.writeEpisodeRecord(project.projectId, {
        episodeId,
        title: '場面移動',
        order: 1,
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
        scenes: [
          {
            sceneId: sourceSceneId,
            episodeId,
            order: 1,
            createdAt: '2026-07-02T00:00:00Z',
            updatedAt: '2026-07-02T00:00:00Z',
            acceptedGenerationId: null,
            draftGenerationIds: [sourceGenerationId],
          },
          {
            sceneId: otherSceneId,
            episodeId,
            order: 2,
            createdAt: '2026-07-02T00:00:00Z',
            updatedAt: '2026-07-02T00:00:00Z',
            acceptedGenerationId: null,
            draftGenerationIds: [otherGenerationId],
          },
        ],
      });
      for (const [generationId, sceneId] of [
        [sourceGenerationId, sourceSceneId],
        [otherGenerationId, otherSceneId],
      ]) {
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
        currentSceneId: sourceSceneId,
        selectedDraftGenerationId: sourceGenerationId,
        refineMaintenance: {
          runId: `autorun-${phase}-scene-navigation`,
          generationId: sourceGenerationId,
          phase,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          appliedPatchIds: [],
          pendingPatchIds: [],
          reviewPatchIds: [],
        },
      });

      await generationService.navigateScene(project.projectId, 'next');
      await expect(storage.readState(project.projectId)).resolves.toMatchObject({
        currentSceneId: otherSceneId,
        selectedDraftGenerationId: otherGenerationId,
        refineMaintenance: {
          runId: `autorun-${phase}-scene-navigation`,
          generationId: sourceGenerationId,
          phase,
        },
      });
    }
  );

  it('does not stale a scanning run when only the selected draft changes', async () => {
    const project = await createTrackedProject();
    const episodeId = 'ep-draft-scan-navigation';
    const sceneId = 'scene-draft-scan-navigation';
    const sourceGenerationId = 'gen-draft-scan-source';
    const otherGenerationId = 'gen-draft-scan-other';
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
          draftGenerationIds: [sourceGenerationId, otherGenerationId],
        },
      ],
    });
    for (const generationId of [sourceGenerationId, otherGenerationId]) {
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
      selectedDraftGenerationId: sourceGenerationId,
      refineMaintenance: {
        runId: 'autorun-draft-scan-navigation',
        generationId: sourceGenerationId,
        phase: 'scanning',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await generationService.navigateDraft(project.projectId, 'next');
    await expect(storage.readState(project.projectId)).resolves.toMatchObject({
      selectedDraftGenerationId: otherGenerationId,
      refineMaintenance: { runId: 'autorun-draft-scan-navigation', phase: 'scanning' },
    });
  });
});

async function waitForCondition(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for background story-state refresh');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
