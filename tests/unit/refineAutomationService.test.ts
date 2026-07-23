import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineAutomationService from '../../src/server/services/refineAutomationService';
import * as refineChatService from '../../src/server/services/refineChatService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import type {
  Character,
  GenerationRecord,
  RefineAutomationRun,
  RefineAutomationStore,
} from '../../src/server/types/index';

// NOTE: 自動レビューは patch の根拠を「保存済みaccepted generation」からサーバー側で
// 解決する。テスト用に、指定 responseText を持つ accepted generation を書き込む。
async function seedAcceptedGeneration(projectId: string, generationId: string, responseText: string) {
  const record: GenerationRecord = {
    generationId,
    sceneId: `scene-${generationId}`,
    episodeId: `ep-${generationId}`,
    request: { wish: '', outputLength: 0, previousContextText: '' },
    responseText,
    usedPresets: {} as never,
    usedModel: { provider: 'gemini', modelName: 'test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-22T00:00:00.000Z',
    parentGenerationId: null,
  };
  await storage.appendGenerationLog(projectId, record);
  await storage.appendGenerationStatusLog(projectId, generationId, 'accepted');
}

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Refine Automation Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

function stubRun(overrides: Partial<RefineAutomationRun> = {}): RefineAutomationRun {
  return {
    schemaVersion: 1,
    runId: `autorun-${Math.random().toString(36).slice(2)}`,
    generationId: 'gen-stub',
    status: 'complete',
    mode: 'safe',
    usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
    createdAt: '2026-07-22T00:00:00.000Z',
    completedAt: '2026-07-22T00:00:00.000Z',
    sourceStaticHash: 'hash',
    sourceAcceptedGenerationCount: 0,
    patchIds: [],
    appliedPatchIds: [],
    pendingPatchIds: [],
    reviewPatchIds: [],
    highRiskAppliedPatchIds: [],
    beforeSnapshot: { worldText: 'world', characters: [] },
    resultStaticHash: 'hash',
    ...overrides,
  };
}

describe('refineAutomationService.runRefineAutomationPipeline', () => {
  it('auto-applies a safe character-update proposal in safe mode and records the run', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-akiba',
      name: '秋葉',
      role: 'protagonist',
      description: '27歳、蘭学者',
    };
    await storage.writeCharacters(projectId, [character]);
    await seedAcceptedGeneration(projectId, 'gen-src-safe', '秋葉は丁寧な武家言葉で話す。これは本文からの引用。');

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-test-1',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '口調を補完',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-akiba',
              fields: { speechStyle: '丁寧な武家言葉' },
            },
          ],
          evidenceScope: 'accepted',
          evidenceQuote: '秋葉は丁寧な武家言葉で話す。',
          evidenceSourceGenerationId: 'gen-src-safe',
        },
      ],
    });

    expect(run.status).toBe('complete');
    expect(run.appliedPatchIds).toHaveLength(1);
    expect(run.pendingPatchIds).toHaveLength(0);

    const [updated] = await storage.readCharacters(projectId);
    expect(updated.speechStyle).toBe('丁寧な武家言葉');

    const session = await refineChatService.getOrCreateRefineSession(projectId);
    expect(session.patches).toHaveLength(1);
    expect(session.patches[0].origin).toBe('auto-scan');
    expect(session.patches[0].riskLevel).toBe('safe');
    expect(session.messages.some((m) => m.automationRunId === run.runId)).toBe(true);
  });

  it('keeps a review-risk proposal pending in safe mode', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '静かな漁村。', initialSituation: '' });

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-test-2',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '世界設定を書き換え',
          operations: [{ kind: 'world-replace', op: { anchor: '静かな漁村。', replacement: '賑やかな港町。' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '賑やかな港町だ。',
          evidenceSourceGenerationId: 'gen-src-review',
        },
      ],
    });

    expect(run.status).toBe('needsReview');
    expect(run.appliedPatchIds).toHaveLength(0);
    expect(run.pendingPatchIds).toHaveLength(1);
    expect(run.reviewPatchIds).toHaveLength(1);

    const worldText = await storage.readWorldText(projectId);
    expect(worldText).toContain('静かな漁村。');
  });

  it('never auto-applies a patch whose evidence is draft-only, even in all mode', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-b',
      name: 'B',
      role: 'protagonist',
      description: 'desc',
    };
    await storage.writeCharacters(projectId, [character]);

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-test-3',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 0,
      proposals: [
        {
          summary: '下書きの内容から口調を補完',
          operations: [
            { kind: 'character-update', characterId: 'char-b', fields: { speechStyle: '早口' } },
          ],
          evidenceScope: 'draft',
          evidenceQuote: '早口で話す。',
          evidenceSourceGenerationId: 'gen-draft-only',
        },
      ],
    });

    expect(run.appliedPatchIds).toHaveLength(0);
    expect(run.pendingPatchIds).toHaveLength(1);
    const [unchanged] = await storage.readCharacters(projectId);
    expect(unchanged.speechStyle).toBeUndefined();
  });

  it('rejects a second run for the same generationId unless the prior run failed', async () => {
    const projectId = await createTrackedProject();
    await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-dup',
      mode: 'suggest',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 0,
      proposals: [],
    });

    await expect(
      refineAutomationService.runRefineAutomationPipeline(projectId, {
        generationId: 'gen-dup',
        mode: 'suggest',
        usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
        acceptedGenerationCount: 0,
        proposals: [],
      })
    ).rejects.toMatchObject({ code: 'automation_already_run' });
  });
});

describe('refineAutomationService revert', () => {
  it('reverts the latest run and restores the previous character state', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-c',
      name: 'C',
      role: 'protagonist',
      description: 'desc',
    };
    await storage.writeCharacters(projectId, [character]);
    await seedAcceptedGeneration(projectId, 'gen-src-revert', '早口で話す。参照本文。');

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-revert',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '口調を補完',
          operations: [
            { kind: 'character-update', characterId: 'char-c', fields: { speechStyle: '早口' } },
          ],
          evidenceScope: 'accepted',
          evidenceQuote: '早口で話す。',
          evidenceSourceGenerationId: 'gen-src-revert',
        },
      ],
    });
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBe('早口');

    const reverted = await refineAutomationService.revertLatestAutomationRun(projectId, run.runId);
    expect(reverted.characters[0].speechStyle).toBeUndefined();
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBeUndefined();

    const runs = await refineAutomationService.listAutomationRuns(projectId);
    expect(runs[0].acknowledgement).toBe('reverted');
    expect(runs[0].beforeSnapshot).toBeUndefined();
  });

  it('refuses to revert a run with no applied patches', async () => {
    const projectId = await createTrackedProject();
    const run1 = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-suggest-only',
      mode: 'suggest',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 0,
      proposals: [],
    });

    await expect(refineAutomationService.revertLatestAutomationRun(projectId, run1.runId)).rejects.toMatchObject({
      code: 'automation_run_not_revertible',
    });
  });

  it('can revert the latest APPLIED run even when a later suggest-only run exists', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-late', name: 'L', role: 'protagonist', description: 'd' },
    ]);
    await seedAcceptedGeneration(projectId, 'gen-src-latest', '早口で話す。参照。');

    const appliedRun = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-applied',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '口調',
          operations: [{ kind: 'character-update', characterId: 'char-late', fields: { speechStyle: '早口' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '早口で話す。',
          evidenceSourceGenerationId: 'gen-src-latest',
        },
      ],
    });
    // NOTE: 適用後に提案のみのrunを重ねる。この suggest-only run が store の先頭に来る。
    await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-suggest-later',
      mode: 'suggest',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [],
    });

    // NOTE: 修正前の実装だと store.runs[0]!==appliedRun.runId で not_latest 拒否だった。
    // 修正後は「実適用最新 run」を対象にできる。
    const reverted = await refineAutomationService.revertLatestAutomationRun(projectId, appliedRun.runId);
    expect(reverted.characters[0].speechStyle).toBeUndefined();
  });
});

describe('refineAutomationService.acknowledgeAutomationRun', () => {
  it('flips a pending acknowledgement to acknowledged and re-enables autoApply on the next run', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-ack2', name: 'X', role: 'protagonist', description: 'd' },
    ]);
    await seedAcceptedGeneration(projectId, 'gen-src-ack', '根拠。');
    await seedAcceptedGeneration(projectId, 'gen-src-ack-next', '根拠2。');

    const first = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-first-ack',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '名前変更',
          operations: [{ kind: 'character-update', characterId: 'char-ack2', fields: { name: 'Y' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '根拠',
          evidenceSourceGenerationId: 'gen-src-ack',
        },
      ],
    });
    expect(first.acknowledgement).toBe('pending');

    await refineAutomationService.acknowledgeAutomationRun(projectId, first.runId);
    const acknowledged = await refineAutomationService.getLatestAutomationRun(projectId);
    expect(acknowledged?.acknowledgement).toBe('acknowledged');

    // 続く高リスク run は再び自動適用が許可される。
    const next = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-second-ack',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 2,
      proposals: [
        {
          summary: '説明変更',
          operations: [{ kind: 'character-update', characterId: 'char-ack2', fields: { description: '新' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '根拠2',
          evidenceSourceGenerationId: 'gen-src-ack-next',
        },
      ],
    });
    expect(next.appliedPatchIds).toHaveLength(1);
  });
});

describe('refineAutomationService — evidence generation status validation', () => {
  it('does not treat a draft-status generation as a valid accepted source', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-drfake',
      name: 'DF',
      role: 'protagonist',
      description: 'd',
    };
    await storage.writeCharacters(projectId, [character]);
    // draft のままの generation を「accepted 由来」と偽って渡す。
    await storage.appendGenerationLog(projectId, {
      generationId: 'gen-still-draft-fake',
      sceneId: 'sc',
      episodeId: 'ep',
      request: { wish: '', outputLength: 0, previousContextText: '' },
      responseText: '静かに話す。この本文は draft のはず。',
      usedPresets: {} as never,
      usedModel: { provider: 'gemini', modelName: 'test' },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-22T00:00:00.000Z',
      parentGenerationId: null,
    });

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-fakescope',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 0,
      proposals: [
        {
          summary: '静かに補完',
          operations: [{ kind: 'character-update', characterId: 'char-drfake', fields: { speechStyle: '静かに' } }],
          // accepted と主張するが、実際の source generation は draft のまま。
          evidenceScope: 'accepted',
          evidenceQuote: '静かに話す。',
          evidenceSourceGenerationId: 'gen-still-draft-fake',
        },
      ],
    });
    // 根拠 status が accepted でないため source text 解決を拒否 → review へ格下げ
    // → safe 自動適用されず pending。
    expect(run.appliedPatchIds).toHaveLength(0);
    expect(run.pendingPatchIds).toHaveLength(1);
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBeUndefined();
  });
});

describe('refineAutomationService — scannedStaticHash re-check', () => {
  it('rejects apply when static settings changed between scan and apply', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-scan', name: 'S', role: 'protagonist', description: 'd' },
    ]);

    await expect(
      refineAutomationService.runRefineAutomationPipeline(projectId, {
        generationId: 'gen-scan-stale',
        mode: 'suggest',
        usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
        acceptedGenerationCount: 0,
        proposals: [],
        scannedStaticHash: 'hash-that-does-not-match-current-state',
      })
    ).rejects.toMatchObject({ code: 'automation_scan_stale' });
  });

  it('proceeds when scannedStaticHash matches the current static hash', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-scan2', name: 'S2', role: 'protagonist', description: 'd' },
    ]);
    // 一度何もしない run を走らせ、その resultStaticHash を取り出して次の scannedStaticHash に流用する。
    const seed = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-scan-seed',
      mode: 'suggest',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 0,
      proposals: [],
    });
    expect(seed.resultStaticHash).toBeDefined();

    await expect(
      refineAutomationService.runRefineAutomationPipeline(projectId, {
        generationId: 'gen-scan-ok',
        mode: 'suggest',
        usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
        acceptedGenerationCount: 0,
        proposals: [],
        scannedStaticHash: seed.resultStaticHash,
      })
    ).resolves.toBeDefined();
  });
});

describe('refineAutomationService — revert also updates session.patches', () => {
  it('marks the applied auto-scan patches as stale after a successful revert', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-revert-sync', name: 'R', role: 'protagonist', description: 'd' },
    ]);
    await seedAcceptedGeneration(projectId, 'gen-src-revert-sync', '早口で話す。参照。');

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-revert-sync',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '口調',
          operations: [{ kind: 'character-update', characterId: 'char-revert-sync', fields: { speechStyle: '早口' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '早口で話す。',
          evidenceSourceGenerationId: 'gen-src-revert-sync',
        },
      ],
    });
    const beforeSession = await refineChatService.getOrCreateRefineSession(projectId);
    expect(beforeSession.patches.find((p) => p.automationRunId === run.runId)?.status).toBe('applied');

    await refineAutomationService.revertLatestAutomationRun(projectId, run.runId);

    const afterSession = await refineChatService.getOrCreateRefineSession(projectId);
    const afterPatch = afterSession.patches.find((p) => p.automationRunId === run.runId);
    expect(afterPatch?.status).toBe('stale');
    expect(afterPatch?.applyError).toContain('取り消し');
  });
});

describe('refineAutomationService retry re-classifies with current state', () => {
  it('demotes a formerly-safe patch to review when the field has been manually filled between failure and retry', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-reretry', name: 'R', role: 'protagonist', description: 'd' },
    ]);
    await seedAcceptedGeneration(projectId, 'gen-src-retry', '静かに話す。参照本文。');

    // fail-run を疑似的に構築する。retry で参照する session.patches の evidenceQuote が
    // 実本文に含まれていないと、そもそも safe 判定に届かないため、
    // 「fail した proposal」を retry から再構成する経路を検証する。
    // まず正常な safe run を1回走らせて session に patch を残す。
    await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-retry-src',
      mode: 'safe',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '口調補完',
          operations: [{ kind: 'character-update', characterId: 'char-reretry', fields: { speechStyle: '静かに' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '静かに話す。',
          evidenceSourceGenerationId: 'gen-src-retry',
        },
      ],
    });
    // この時点で speechStyle は '静かに'。「その後手動で別の値へ書き換えた」状態を作る。
    await storage.writeCharacters(projectId, [
      { characterId: 'char-reretry', name: 'R', role: 'protagonist', description: 'd', speechStyle: '早口' },
    ]);
    // 直近 run を failed に書き換えて retry のターゲットにする。
    const store = await refineAutomationService.readAutomationStore(projectId);
    const failedFirst: RefineAutomationRun = { ...store.runs[0], status: 'failed', appliedPatchIds: [] };
    await storage.writeRefineAutomation(projectId, { ...store, runs: [failedFirst] });

    const retried = await refineAutomationService.retryFailedAutomationRun(projectId);
    // 再分類の結果、既存 non-empty 値の上書きになるため review へ格下げされ、
    // pending として保留される（safe 自動適用ではない）。
    expect(retried.appliedPatchIds).toHaveLength(0);
    expect(retried.pendingPatchIds.length).toBeGreaterThan(0);
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBe('早口');
  });
});

describe('refineAutomationService.assertGenerationNotBlockedByMaintenance', () => {
  it('blocks generation while a maintenance phase is scanning/applying/reverting (lease still valid)', async () => {
    const projectId = await createTrackedProject();
    const state = await storage.readState(projectId);
    if (!state) throw new Error('state missing');
    await storage.writeState(projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-x',
        generationId: 'gen-x',
        phase: 'scanning',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await expect(refineAutomationService.assertGenerationNotBlockedByMaintenance(projectId)).rejects.toMatchObject({
      code: 'post_generation_maintenance_in_progress',
    });
  });

  it('normalizes an expired blocking-phase lease to failed and lets generation proceed', async () => {
    const projectId = await createTrackedProject();
    const state = await storage.readState(projectId);
    if (!state) throw new Error('state missing');
    await storage.writeState(projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-expired',
        generationId: 'gen-expired',
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
      refineAutomationService.assertGenerationNotBlockedByMaintenance(projectId)
    ).resolves.toBeUndefined();
    const afterState = await storage.readState(projectId);
    expect(afterState?.refineMaintenance?.phase).toBe('failed');
  });

  it('normalizes an expired lease when maintenance status is read', async () => {
    const projectId = await createTrackedProject();
    const state = await storage.readState(projectId);
    if (!state) throw new Error('state missing');
    await storage.writeState(projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-expired-status',
        generationId: 'gen-expired-status',
        phase: 'reverting',
        startedAt: new Date(Date.now() - 300_000).toISOString(),
        updatedAt: new Date(Date.now() - 300_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await expect(refineAutomationService.getMaintenanceStatus(projectId)).resolves.toMatchObject({
      phase: 'failed',
    });
    expect((await storage.readState(projectId))?.refineMaintenance?.phase).toBe('failed');
  });

  it('does not block generation for non-blocking phases', async () => {
    const projectId = await createTrackedProject();
    const state = await storage.readState(projectId);
    if (!state) throw new Error('state missing');
    await storage.writeState(projectId, {
      ...state,
      refineMaintenance: {
        runId: 'autorun-y',
        generationId: 'gen-y',
        phase: 'needsReview',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        leaseExpiresAt: new Date().toISOString(),
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
      },
    });

    await expect(refineAutomationService.assertGenerationNotBlockedByMaintenance(projectId)).resolves.toBeUndefined();
  });
});

describe('refineAutomationService.normalizeRefineAutomationStore — pruning', () => {
  it('trims stored runs to the newest 50', () => {
    const runs = Array.from({ length: 55 }, (_, i) =>
      stubRun({ runId: `autorun-${i}`, createdAt: `2026-07-22T00:${String(i).padStart(2, '0')}:00.000Z` })
    );
    const normalized = refineAutomationService.normalizeRefineAutomationStore({ schemaVersion: 1, runs });
    expect(normalized.runs).toHaveLength(50);
    // NOTE: newest-first の配列前提なので、先頭50件（index 0-49）がそのまま残る。
    expect(normalized.runs[0].runId).toBe('autorun-0');
    expect(normalized.runs[49].runId).toBe('autorun-49');
  });

  it('keeps beforeSnapshot only on the newest 5 APPLIED runs, preserving the run rows beyond that', () => {
    // NOTE: 修正後は snapshot budget を「appliedPatchIds>0」の run だけがカウントする。
    // 全 run に applied を持たせて budget 消費を再現する。
    const runs = Array.from({ length: 8 }, (_, i) =>
      stubRun({ runId: `autorun-${i}`, appliedPatchIds: [`patch-${i}`] })
    );
    const normalized = refineAutomationService.normalizeRefineAutomationStore({ schemaVersion: 1, runs });
    expect(normalized.runs).toHaveLength(8);
    for (let i = 0; i < 5; i += 1) {
      expect(normalized.runs[i].beforeSnapshot).toBeDefined();
    }
    for (let i = 5; i < 8; i += 1) {
      expect(normalized.runs[i].beforeSnapshot).toBeUndefined();
      expect(normalized.runs[i].runId).toBe(`autorun-${i}`);
    }
  });

  it('does not let suggest-only runs push out the beforeSnapshot of older applied runs', () => {
    // P1-4 の回帰テスト。stubRun default は appliedPatchIds=[] なので suggest-only。
    // 先頭 5 件が suggest-only、その次に applied run を1件置く。
    // 修正前: index-based の判定で applied run のsnapshotが index=5 のため pruned。
    // 修正後: applied run だけが snapshot budget を消費するので保持される。
    const runs = [
      ...Array.from({ length: 5 }, (_, i) => stubRun({ runId: `sug-${i}` })),
      stubRun({ runId: 'applied-later', appliedPatchIds: ['patch-a'] }),
    ];
    const normalized = refineAutomationService.normalizeRefineAutomationStore({ schemaVersion: 1, runs });
    const appliedRun = normalized.runs.find((r) => r.runId === 'applied-later');
    expect(appliedRun?.beforeSnapshot).toBeDefined();
    // suggest-only 側は budget を使わない = snapshot は落とされる（役に立たないため）。
    for (const r of normalized.runs.filter((run) => run.runId.startsWith('sug-'))) {
      expect(r.beforeSnapshot).toBeUndefined();
    }
  });

  it('normalizes corrupt/missing input to an empty store', () => {
    expect(refineAutomationService.normalizeRefineAutomationStore(null)).toEqual({ schemaVersion: 1, runs: [] });
    expect(refineAutomationService.normalizeRefineAutomationStore(undefined)).toEqual({
      schemaVersion: 1,
      runs: [],
    });
    expect(refineAutomationService.normalizeRefineAutomationStore('broken')).toEqual({
      schemaVersion: 1,
      runs: [],
    });
  });

  it('drops implausible run entries but keeps well-formed ones', () => {
    const store: unknown = {
      schemaVersion: 1,
      runs: [stubRun({ runId: 'autorun-ok' }), { not: 'a run' }, null],
    };
    const normalized = refineAutomationService.normalizeRefineAutomationStore(store);
    expect(normalized.runs).toHaveLength(1);
    expect(normalized.runs[0].runId).toBe('autorun-ok');
  });

  it('drops partial run rows instead of crashing while pruning snapshots', () => {
    const normalized = refineAutomationService.normalizeRefineAutomationStore({
      schemaVersion: 1,
      runs: [
        {
          schemaVersion: 1,
          runId: 'autorun-partial',
          generationId: 'gen-partial',
          status: 'complete',
        },
        stubRun({ runId: 'autorun-valid' }),
      ],
    });

    expect(normalized.runs.map((run) => run.runId)).toEqual(['autorun-valid']);
  });
});

describe('refineAutomationService — persisted world hash', () => {
  it('can revert after writeWorld normalizes whitespace in an auto-applied replacement', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '静かな漁村。', initialSituation: '' });
    await seedAcceptedGeneration(projectId, 'gen-src-world-normalize', '賑やかな港町になった。');

    const run = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-world-normalize',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '港町へ更新',
          operations: [
            {
              kind: 'world-replace',
              op: { anchor: '静かな漁村。', replacement: '賑やかな港町。\n\n' },
            },
          ],
          evidenceScope: 'accepted',
          evidenceQuote: '賑やかな港町',
          evidenceSourceGenerationId: 'gen-src-world-normalize',
        },
      ],
    });

    expect(run.appliedPatchIds).toHaveLength(1);
    await expect(
      refineAutomationService.revertLatestAutomationRun(projectId, run.runId)
    ).resolves.toBeDefined();
    expect((await storage.readWorld(projectId)).foundation).toBe('静かな漁村。');
  });
});

describe('refineAutomationService — all-mode acknowledgement blocks further auto-apply', () => {
  it('does not auto-apply a review-risk proposal while any prior run is pending acknowledgement', async () => {
    const projectId = await createTrackedProject();
    const character: Character = { characterId: 'char-ack', name: 'X', role: 'protagonist', description: 'd' };
    await storage.writeCharacters(projectId, [character]);
    await seedAcceptedGeneration(projectId, 'gen-src-ack-1', '本文中の根拠。');
    await seedAcceptedGeneration(projectId, 'gen-src-ack-2', '本文中の根拠2。');
    await seedAcceptedGeneration(projectId, 'gen-src-ack-3', '本文中の根拠3。');

    const firstRun = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-ack-1',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [
        {
          summary: '名前を変更（要確認操作）',
          operations: [{ kind: 'character-update', characterId: 'char-ack', fields: { name: 'Y' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '根拠',
          evidenceSourceGenerationId: 'gen-src-ack-1',
        },
      ],
    });
    expect(firstRun.acknowledgement).toBe('pending');
    expect(firstRun.appliedPatchIds).toHaveLength(1);
    expect((await storage.readCharacters(projectId))[0].name).toBe('Y');

    // NOTE: 高リスク未確認 run と後続 run の間に、提案のみの run を挟む。
    // 修正前の実装（最新runだけを見る）だと、この提案 run 以降は autoApplyAllowed が
    // true に戻ってしまい、後続の高リスク提案が自動適用されるバグがあった。
    await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-suggest-mid',
      mode: 'suggest',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 1,
      proposals: [],
    });

    const secondRun = await refineAutomationService.runRefineAutomationPipeline(projectId, {
      generationId: 'gen-ack-2',
      mode: 'all',
      usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
      acceptedGenerationCount: 2,
      proposals: [
        {
          summary: '説明を変更（要確認操作）',
          operations: [{ kind: 'character-update', characterId: 'char-ack', fields: { description: '新説明' } }],
          evidenceScope: 'accepted',
          evidenceQuote: '根拠2',
          evidenceSourceGenerationId: 'gen-src-ack-2',
        },
      ],
    });
    // NOTE: 走査・提案作成は許可されるが、確認待ちの間はパッチを保留する。
    expect(secondRun.appliedPatchIds).toHaveLength(0);
    expect(secondRun.pendingPatchIds).toHaveLength(1);
    expect((await storage.readCharacters(projectId))[0].description).toBe('d');
  });
});

describe('refineAutomationService — rollback failure sets a hard-stop flag', () => {
  it('flags confirmationRequired when the compensating rollback write also fails', async () => {
    const projectId = await createTrackedProject();
    const character: Character = { characterId: 'char-fail', name: 'Z', role: 'protagonist', description: 'd' };
    await storage.writeCharacters(projectId, [character]);
    await seedAcceptedGeneration(projectId, 'gen-src-fail', '本文中の根拠。');

    vi.spyOn(storage, 'writeCharacters').mockRejectedValue(new Error('disk full'));

    await expect(
      refineAutomationService.runRefineAutomationPipeline(projectId, {
        generationId: 'gen-rollback-fail',
        mode: 'safe',
        usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
        acceptedGenerationCount: 0,
        proposals: [
          {
            summary: '口調を補完',
            operations: [{ kind: 'character-update', characterId: 'char-fail', fields: { speechStyle: '丁寧' } }],
            evidenceScope: 'accepted',
            evidenceQuote: '根拠',
            evidenceSourceGenerationId: 'gen-src-fail',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'automation_apply_failed' });

    vi.restoreAllMocks();
    const store = await refineAutomationService.readAutomationStore(projectId);
    expect(store.confirmationRequired).toBeDefined();
    expect(store.runs[0].status).toBe('failed');

    // NOTE: confirmationRequired が立っている間、明示確認なしの新規runは拒否される。
    await expect(
      refineAutomationService.runRefineAutomationPipeline(projectId, {
        generationId: 'gen-after-hardstop',
        mode: 'safe',
        usedModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
        acceptedGenerationCount: 0,
        proposals: [],
      })
    ).rejects.toMatchObject({ code: 'automation_confirmation_required' });
  });

  it('clears confirmationRequired when an explicitConfirmation retry succeeds', async () => {
    const projectId = await createTrackedProject();
    // NOTE: 事前に confirmationRequired と failed run を含む store を書き込む。
    await storage.writeRefineAutomation(projectId, {
      schemaVersion: 1,
      runs: [
        stubRun({ runId: 'autorun-hardstop', generationId: 'gen-hardstop', status: 'failed', appliedPatchIds: [] }),
      ],
      confirmationRequired: { reason: 'automation_rollback_failed', sinceRunId: 'autorun-hardstop', setAt: nowIso() },
    });

    // NOTE: retry は explicitConfirmation=true で走る。empty proposals でも成功扱いになる。
    await refineAutomationService.retryFailedAutomationRun(projectId);
    const store = await refineAutomationService.readAutomationStore(projectId);
    expect(store.confirmationRequired).toBeUndefined();
  });
});

// NOTE: nowIso のインライン参照回避用。既存 stubRun の createdAt は固定文字列だが、
// setAt はテスト固有なので localhelper を持たせる。
function nowIso(): string {
  return new Date().toISOString();
}
