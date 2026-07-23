import * as generationService from '../../src/server/services/generationService';
import * as projectService from '../../src/server/services/projectService';
import * as refineAutomationService from '../../src/server/services/refineAutomationService';
import * as postGenerationMaintenanceService from '../../src/server/services/postGenerationMaintenanceService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type { Character, RefineAutomationRun } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject() {
  const project = await projectService.createProject({ title: 'Post-generation maintenance test' });
  createdProjectIds.push(project.projectId);
  await projectService.updateProject(project.projectId, {
    refineAutomation: { mode: 'safe', scanPolicy: 'always' },
  });
  return project;
}

async function waitForCondition(condition: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('post-generation maintenance', () => {
  it('reserves scanning with the draft, then revalidates and applies draft evidence only after acceptance', async () => {
    const project = await createTrackedProject();
    const character: Character = {
      characterId: 'char-yui',
      name: 'ユイ',
      role: 'protagonist',
      description: '旅人',
    };
    await storage.writeCharacters(project.projectId, [character]);

    const generate = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      if (request.systemInstructions.includes('生成後設定レビュー担当')) {
        const sourceRef = request.userPrompt.match(/\[sourceRef: (draft:[^\]]+)\]/)?.[1];
        return {
          text: JSON.stringify({
            proposals: [
              {
                summary: 'ユイの口調を補完',
                evidenceScope: 'draft',
                evidence: [{ sourceRef, quote: 'ユイは丁寧な古風の口調で話した。' }],
                operations: [
                  {
                    kind: 'character-update',
                    characterId: 'char-yui',
                    fields: { speechStyle: '丁寧な古風の口調' },
                  },
                ],
              },
            ],
          }),
          finishReason: 'stop' as const,
          retryable: false,
        };
      }
      if (request.systemInstructions.includes('物語状態')) {
        return { text: '{}', finishReason: 'stop' as const, retryable: false };
      }
      return {
        text: 'ユイは丁寧な古風の口調で話した。',
        finishReason: 'stop' as const,
        retryable: false,
      };
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: '旅の出発',
      mode: 'continue',
    });

    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.refineMaintenance?.phase === 'awaitingAcceptance';
    });
    expect((await storage.readCharacters(project.projectId))[0].speechStyle).toBeUndefined();

    await generationService.acceptGeneration(project.projectId, record.generationId);
    await waitForCondition(async () => (await storage.readCharacters(project.projectId))[0].speechStyle === '丁寧な古風の口調');
    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.refineMaintenance?.phase === 'complete';
    });
    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.storyStateRefresh?.status !== 'pending';
    });

    const [run] = await refineAutomationService.listAutomationRuns(project.projectId);
    expect(run.generationId).toBe(record.generationId);
    expect(run.appliedPatchIds).toHaveLength(1);
  });

  it('keeps multi-source evidence containing the current draft pending before acceptance in all mode', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'all', scanPolicy: 'always' },
    });
    const character: Character = {
      characterId: 'char-multi-draft',
      name: 'Yui',
      role: 'protagonist',
      description: 'A calm protagonist.',
    };
    await storage.writeCharacters(project.projectId, [character]);

    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      if (request.userPrompt.includes('[sourceRef: draft:')) {
        const draftSourceRef = request.userPrompt.match(/\[sourceRef: (draft:[^\]]+)\]/)?.[1];
        if (!draftSourceRef) throw new Error('draft source ref missing from scan prompt');
        return {
          text: JSON.stringify({
            proposals: [
              {
                summary: 'Record Yui\'s speaking style.',
                evidenceScope: 'mixed',
                evidence: [
                  { sourceRef: 'static:characters', quote: 'name: Yui' },
                  { sourceRef: draftSourceRef, quote: 'Yui speaks in a calm voice.' },
                ],
                operations: [
                  {
                    kind: 'character-update',
                    characterId: character.characterId,
                    fields: { speechStyle: 'calm' },
                  },
                ],
              },
            ],
          }),
          finishReason: 'stop' as const,
          retryable: false,
        };
      }
      return {
        text: 'Yui speaks in a calm voice.',
        finishReason: 'stop' as const,
        retryable: false,
      };
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: 'Continue the scene.',
      mode: 'continue',
    });
    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.refineMaintenance?.phase === 'awaitingAcceptance';
    });

    expect((await storage.readCharacters(project.projectId))[0].speechStyle).toBeUndefined();
    const sessionBeforeAcceptance = await storage.readRefineSession(project.projectId);
    expect(sessionBeforeAcceptance?.patches.at(-1)).toMatchObject({
      evidenceScope: 'mixed',
      sourceGenerationId: record.generationId,
      status: 'pending',
    });

    await generationService.acceptGeneration(project.projectId, record.generationId);
    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.refineMaintenance?.phase === 'needsReview';
    });
    expect((await storage.readCharacters(project.projectId))[0].speechStyle).toBeUndefined();
  });

  it('uses resultStaticHash to avoid scheduling a second when-needed scan for its own applied change', async () => {
    const project = await createTrackedProject();
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'safe', scanPolicy: 'when-needed' },
    });
    const character: Character = {
      characterId: 'char-ao',
      name: 'アオ',
      role: 'protagonist',
      description: '旅人',
    };
    await storage.writeCharacters(project.projectId, [character]);

    const storyState = await storage.readStoryState(project.projectId);
    const scanRun = await refineAutomationService.runRefineAutomationPipeline(project.projectId, {
      generationId: 'gen-existing',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'test' },
      acceptedGenerationCount: 0,
      scannedStoryStateUpdatedAt: storyState?.updatedAt ?? null,
      evidenceSources: [
        {
          sourceRef: 'static:characters',
          scope: 'static',
          text: JSON.stringify([character]),
        },
      ],
      proposals: [
        {
          summary: 'Add a missing speaking-style note.',
          evidenceScope: 'static',
          evidenceSourceRef: 'static:characters',
          evidenceQuote: character.name,
          operations: [
            {
              kind: 'character-update',
              characterId: character.characterId,
              fields: { speechStyle: 'calm' },
            },
          ],
        },
      ],
    });
    expect(scanRun.status).toBe('complete');
    expect(scanRun.appliedPatchIds).toHaveLength(1);

    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '次の本文',
      finishReason: 'stop',
      retryable: false,
    });
    const record = await generationService.generateScene(project.projectId, { wish: '続き', mode: 'continue' });
    const state = await storage.readState(project.projectId);
    expect(record.status).toBe('draft');
    expect(state?.refineMaintenance?.phase).not.toBe('scanning');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stales an in-flight scan as soon as its draft is rejected', async () => {
    const project = await createTrackedProject();
    let releaseScan!: () => void;
    let markScanFinished!: () => void;
    const scanGate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanFinished = new Promise<void>((resolve) => {
      markScanFinished = resolve;
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      if (request.systemInstructions.includes('生成後設定レビュー担当')) {
        await scanGate;
        markScanFinished();
        return {
          text: JSON.stringify({ proposals: [] }),
          finishReason: 'stop' as const,
          retryable: false,
        };
      }
      return {
        text: 'A draft that will be rejected.',
        finishReason: 'stop' as const,
        retryable: false,
      };
    });

    const record = await generationService.generateScene(project.projectId, { wish: 'continue', mode: 'continue' });
    await waitForCondition(async () => (await storage.readState(project.projectId))?.refineMaintenance?.phase === 'scanning');

    await generationService.rejectGeneration(project.projectId, record.generationId);
    expect((await storage.readState(project.projectId))?.refineMaintenance?.phase).toBe('stale');

    releaseScan();
    await scanFinished;
    await waitForCondition(async () => {
      const state = await storage.readState(project.projectId);
      return state?.refineMaintenance?.phase === 'stale';
    });
    expect(await refineAutomationService.listAutomationRuns(project.projectId)).toEqual([]);
  });

  it('rejects a patch-bearing retry while another maintenance slot is active', async () => {
    const project = await createTrackedProject();
    const state = await storage.readState(project.projectId);
    if (!state) throw new Error('state missing');
    const failedRun: RefineAutomationRun = {
      schemaVersion: 1,
      runId: 'autorun-failed-patch',
      generationId: 'gen-failed-patch',
      status: 'failed',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'test' },
      createdAt: '2026-07-23T00:00:00.000Z',
      completedAt: '2026-07-23T00:01:00.000Z',
      sourceStaticHash: 'hash',
      sourceAcceptedGenerationCount: 0,
      patchIds: ['patch-failed'],
      appliedPatchIds: [],
      pendingPatchIds: ['patch-failed'],
      reviewPatchIds: [],
      highRiskAppliedPatchIds: [],
      beforeSnapshot: { worldText: '', characters: [] },
      resultStaticHash: 'hash',
    };
    await storage.writeRefineAutomation(project.projectId, { schemaVersion: 1, runs: [failedRun] });
    await storage.writeState(project.projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-active',
        generationId: 'gen-active',
        phase: 'scanning',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await expect(
      postGenerationMaintenanceService.retryFailedPostGenerationMaintenance(project.projectId)
    ).rejects.toMatchObject({ code: 'post_generation_maintenance_in_progress', status: 409 });
    expect((await refineAutomationService.readAutomationStore(project.projectId)).runs[0].runId).toBe(
      'autorun-failed-patch'
    );
  });
});
