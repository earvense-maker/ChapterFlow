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

describe('generationService post-generation maintenance guard', () => {
  async function createProjectWithMaintenancePhase(
    phase: import('../../src/server/types/index').RefineMaintenancePhase | undefined
  ): Promise<string> {
    const project = await projectService.createProject({
      title: 'Maintenance Guard Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
    });
    createdProjectIds.push(project.projectId);
    // This suite isolates the generation guard. Disable background scanning so
    // the generated draft cannot outlive the test and race project cleanup.
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
    });
    if (phase) {
      const state = await storage.readState(project.projectId);
      if (!state) throw new Error('state missing');
      await storage.writeState(project.projectId, {
        ...state,
        refineMaintenance: {
          runId: 'autorun-guard-test',
          generationId: 'gen-guard-test',
          phase,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          // NOTE: 60秒後まで有効な lease にする。ガードが期限切れとして failed に
          // 正規化しないよう、生きた blocking レコードを模す。
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          appliedPatchIds: [],
          pendingPatchIds: [],
          reviewPatchIds: [],
        },
      });
    }
    return project.projectId;
  }

  it.each(['scanning', 'applying', 'reverting'] as const)(
    'rejects generateScene with a 409-shaped error while phase is %s',
    async (phase) => {
      const projectId = await createProjectWithMaintenancePhase(phase);
      await expect(
        generationService.generateScene(projectId, { wish: '', mode: 'continue' })
      ).rejects.toMatchObject({ code: 'post_generation_maintenance_in_progress', status: 409 });
    }
  );

  it.each(['awaitingAcceptance', 'complete', 'needsReview', 'stale', 'failed', undefined] as const)(
    'does not block generateScene while phase is %s',
    async (phase) => {
      const projectId = await createProjectWithMaintenancePhase(phase);
      await expect(
        withTimeout(generationService.generateScene(projectId, { wish: '', mode: 'continue' }), 1000)
      ).resolves.toMatchObject({ status: 'draft' });
    }
  );

  it('rejects generateSceneStream the same way while phase is scanning', async () => {
    const projectId = await createProjectWithMaintenancePhase('scanning');
    const chunks: string[] = [];
    await expect(
      generationService.generateSceneStream(projectId, { wish: '', mode: 'continue' }, (chunk) =>
        chunks.push(chunk)
      )
    ).rejects.toMatchObject({ code: 'post_generation_maintenance_in_progress', status: 409 });
    expect(chunks).toEqual([]);
  });

  it('re-checks the maintenance slot after waiting for a concurrent generation lock', async () => {
    const project = await projectService.createProject({
      title: 'Concurrent Maintenance Reservation Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
    });
    createdProjectIds.push(project.projectId);
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'safe', scanPolicy: 'always' },
    });

    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let signalGenerationStarted!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      signalGenerationStarted = resolve;
    });
    let releaseScan!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let generationCalls = 0;
    openAiGenerateTextMock.mockImplementation(async (request) => {
      if (request.systemInstructions.includes('生成後設定レビュー担当')) {
        await scanGate;
        return { text: JSON.stringify({ proposals: [] }), finishReason: 'stop', retryable: false };
      }
      generationCalls += 1;
      if (generationCalls === 1) {
        signalGenerationStarted();
        await generationGate;
      }
      return { text: 'A generated draft.', finishReason: 'stop', retryable: false };
    });

    const first = generationService.generateScene(project.projectId, { wish: '', mode: 'continue' });
    await generationStarted;
    const second = generationService.generateScene(project.projectId, { wish: '', mode: 'continue' });
    const secondIsBlocked = expect(second).rejects.toMatchObject({
      code: 'post_generation_maintenance_in_progress',
      status: 409,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    releaseGeneration();
    await expect(first).resolves.toMatchObject({ status: 'draft' });
    await waitForCondition(async () => (await storage.readState(project.projectId))?.refineMaintenance?.phase === 'scanning');
    await secondIsBlocked;

    releaseScan();
    await waitForCondition(async () => (await storage.readState(project.projectId))?.refineMaintenance?.phase === 'complete');
  });

  it('lets non-streaming generateScene proceed after normalizing an expired blocking-phase lease to failed', async () => {
    // P1-1 の回帰テスト。generateScene が期限切れ lease を failed へ正規化してから
    // 通常生成に入ることを確認する。過去には generateSceneUnlocked 側で直接
    // phase を見るだけで正規化していなかったため、恒久的にブロックされ得た。
    const project = await projectService.createProject({
      title: 'Non-Stream Lease Recovery Test',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
    });
    createdProjectIds.push(project.projectId);
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
    });
    const state = await storage.readState(project.projectId);
    if (!state) throw new Error('state missing');
    await storage.writeState(project.projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-expired-nonstream',
        generationId: 'gen-expired-nonstream',
        phase: 'applying',
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await expect(
      withTimeout(generationService.generateScene(project.projectId, { wish: '', mode: 'continue' }), 1500)
    ).resolves.toMatchObject({ status: 'draft' });

    const afterState = await storage.readState(project.projectId);
    expect(afterState?.refineMaintenance?.phase).toBe('failed');
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

async function waitForCondition(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
