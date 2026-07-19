import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineScanService from '../../src/server/services/refineScanService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type {
  Character,
  RefineScanResult,
  StoryState,
  StoryStateDiffRecord,
} from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Refine Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

describe('refineScanService', () => {
  it('returns null when no cached scan exists', async () => {
    const projectId = await createTrackedProject();
    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).toBeNull();
  });

  it('parses well-formed JSON and normalizes findings', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-1',
      name: '秋葉',
      role: 'protagonist',
      description: '27歳、蘭学者。',
    };
    await storage.writeCharacters(projectId, [character]);
    await storage.writeWorld(projectId, {
      foundation: '江戸後期の江戸を舞台にした物語。',
      initialSituation: '',
    });

    const responseJson = JSON.stringify({
      coreConcept: '江戸後期の蘭学者を軸にした静かなドラマ。',
      findings: [
        {
          kind: 'contradiction',
          target: {
            kind: 'character',
            characterId: 'char-1',
            characterName: '秋葉',
          },
          message: '宗教観と第2章の独白に矛盾があります。',
          detail: '独白では神仏を否定しているが、人物設定では信仰心があるとされる。',
        },
        {
          kind: 'undefined',
          target: { kind: 'world' },
          message: '舞台の季節が未設定です。',
        },
        {
          // 不正なペイロード: kind 不明 → 除外されるべき
          kind: 'unknown',
          target: { kind: 'world' },
          message: 'ignored',
        },
      ],
    });
    mockAdapterGenerateText({
      text: '```json\n' + responseJson + '\n```',
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.coreConcept).toContain('蘭学者');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].kind).toBe('contradiction');
    expect(result.findings[0].target).toMatchObject({
      kind: 'character',
      characterId: 'char-1',
    });
    expect(result.findings[1].kind).toBe('undefined');
    expect(result.lastError).toBeNull();

    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).not.toBeNull();
    expect(cached!.findings).toHaveLength(2);
  });

  it('falls back gracefully when the model returns non-JSON', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text: 'すみません、JSONを返し忘れました。',
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.findings).toEqual([]);
    expect(result.coreConcept).toBe('');
    expect(result.lastError).toContain('解釈できません');
    // NOTE: 診断に応答の一部を載せる
    expect(result.lastError).toContain('JSONを返し忘れ');

    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).not.toBeNull();
    expect(cached!.lastError).toContain('解釈できません');
  });

  it('surfaces empty response with a targeted hint', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({ text: '', finishReason: 'stop' });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toContain('空の応答');
  });

  it('accepts raw JSON without a code fence', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text: JSON.stringify({
        coreConcept: 'テスト作品',
        findings: [],
      }),
      finishReason: 'stop',
    });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toBeNull();
    expect(result.coreConcept).toBe('テスト作品');
  });

  it('extracts JSON when the response has preamble text before a code fence', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text:
        '以下が結果です:\n\n```json\n' +
        JSON.stringify({ coreConcept: '骨のある物語', findings: [] }) +
        '\n```\n\n以上です。',
      finishReason: 'stop',
    });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toBeNull();
    expect(result.coreConcept).toBe('骨のある物語');
  });

  it('passes responseMimeType=application/json to the adapter', async () => {
    const projectId = await createTrackedProject();
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"coreConcept":"","findings":[]}',
      finishReason: 'stop',
      retryable: false,
    });
    await refineScanService.scanProjectSettings(projectId);
    expect(spy.mock.calls[0][0].responseMimeType).toBe('application/json');
    expect(spy.mock.calls[0][0].systemInstructions).toContain('initialState は開始時点の状態');
  });

  it('rewrites unknown character ids into "other" targets', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, []);

    mockAdapterGenerateText({
      text: JSON.stringify({
        coreConcept: '',
        findings: [
          {
            kind: 'contradiction',
            target: {
              kind: 'character',
              characterId: 'char-does-not-exist',
              characterName: '望月',
            },
            message: 'テスト',
          },
        ],
      }),
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].target).toEqual({ kind: 'other', label: '人物: 望月' });
  });

  it('stores a review cursor only after a successful scan and preserves it on parse failure', async () => {
    const projectId = await createTrackedProject();
    const storyState = makeStoryState('2026-07-16T00:00:00.000Z');
    const diff = makeDiff('diff-1', '2026-07-16T00:00:00.000Z', storyState.updatedAt);
    await storage.writeStoryState(projectId, storyState);
    await storage.writeStoryStateDiffs(projectId, [diff]);

    mockAdapterGenerateText({
      text: JSON.stringify({ coreConcept: '成功', findings: [] }),
      finishReason: 'stop',
    });
    const successful = await refineScanService.scanProjectSettings(projectId);

    expect(successful.reviewedStoryStateDiffId).toBe('diff-1');
    expect(successful.reviewedStoryStateUpdatedAt).toBe(storyState.updatedAt);
    expect(successful.reviewedStaticInputHash).toMatch(/^[a-f0-9]{64}$/);

    mockAdapterGenerateText({ text: 'not json', finishReason: 'stop' });
    const failed = await refineScanService.scanProjectSettings(projectId);

    expect(failed.lastError).not.toBeNull();
    expect(failed.reviewedStoryStateDiffId).toBe(successful.reviewedStoryStateDiffId);
    expect(failed.reviewedStoryStateUpdatedAt).toBe(successful.reviewedStoryStateUpdatedAt);
    expect(failed.reviewedStaticInputHash).toBe(successful.reviewedStaticInputHash);
  });

  it('treats trait content and registration order as part of the static input hash', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-1',
      name: 'ユイ',
      role: 'protagonist',
      description: '旅人',
      traits: [
        { label: 'こだわり', text: '約束を守る' },
        { label: '動機', text: '故郷へ帰る' },
      ],
    };
    await storage.writeCharacters(projectId, [character]);
    mockAdapterGenerateText({
      text: JSON.stringify({ coreConcept: '旅人の帰郷譚', findings: [] }),
      finishReason: 'stop',
    });
    await refineScanService.scanProjectSettings(projectId);

    const before = await refineScanService.getRefineReviewStatus(projectId);
    expect(before.reasons).not.toContain('settings_changed');

    await storage.writeCharacters(projectId, [
      { ...character, traits: [character.traits![1], character.traits![0]] },
    ]);
    const after = await refineScanService.getRefineReviewStatus(projectId);
    expect(after.reasons).toContain('settings_changed');
  });

  it('derives nudge status from progress, legacy cache, truncated history, settings changes, and manual state edits', () => {
    const reviewedAt = '2026-07-01T00:00:00.000Z';
    const reviewedScan = makeScan({
      reviewedStoryStateDiffId: 'diff-0',
      reviewedStoryStateUpdatedAt: reviewedAt,
      reviewedStaticInputHash: 'same',
    });
    const reviewedState = makeStoryState(reviewedAt);
    const nineNewDiffs = Array.from({ length: 9 }, (_, index) =>
      makeDiff(
        `diff-${9 - index}`,
        `2026-07-${String(10 - index).padStart(2, '0')}T00:00:00.000Z`,
        reviewedAt
      )
    );

    const belowThreshold = refineScanService.calculateRefineReviewStatus({
      cachedScan: reviewedScan,
      storyState: reviewedState,
      diffs: [...nineNewDiffs, makeDiff('diff-0', reviewedAt, reviewedAt)],
      staticInputHash: 'same',
    });
    expect(belowThreshold.needsReview).toBe(false);
    expect(belowThreshold.backlogCountLowerBound).toBe(9);

    const atThreshold = refineScanService.calculateRefineReviewStatus({
      cachedScan: reviewedScan,
      storyState: reviewedState,
      diffs: [
        makeDiff('diff-10', '2026-07-20T00:00:00.000Z', reviewedAt, true),
        ...nineNewDiffs,
        makeDiff('diff-0', reviewedAt, reviewedAt),
      ],
      staticInputHash: 'same',
    });
    expect(atThreshold.reasons).toContain('story_progressed');
    expect(atThreshold.backlogCountLowerBound).toBe(10);

    const truncated = refineScanService.calculateRefineReviewStatus({
      cachedScan: reviewedScan,
      storyState: makeStoryState('2026-07-20T00:00:00.000Z'),
      diffs: [
        makeDiff(
          'diff-new',
          '2026-07-20T00:00:00.000Z',
          '2026-07-20T00:00:00.000Z',
          false,
          '2026-07-19T00:00:00.000Z'
        ),
      ],
      staticInputHash: 'same',
    });
    expect(truncated.reasons).toContain('history_truncated');
    expect(truncated.reasons).not.toContain('story_state_edited');
    expect(truncated.backlogCountLowerBound).toBe(refineScanService.REFINE_NUDGE_DIFF_COUNT);

    const changedSettings = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: reviewedState,
      diffs: [],
      staticInputHash: 'changed',
    });
    expect(changedSettings.reasons).toContain('settings_changed');

    const manualEdit = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: makeStoryState('2026-07-02T00:00:00.000Z'),
      diffs: [],
      staticInputHash: 'same',
    });
    expect(manualEdit.reasons).toContain('story_state_edited');

    const manualEditThenAutomaticUpdate = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: makeStoryState('2026-07-03T00:00:00.000Z'),
      diffs: [
        makeDiff(
          'diff-after-manual-edit',
          '2026-07-03T00:00:00.000Z',
          '2026-07-03T00:00:00.000Z',
          false,
          '2026-07-02T00:00:00.000Z'
        ),
      ],
      staticInputHash: 'same',
    });
    expect(manualEditThenAutomaticUpdate.reasons).toContain('story_state_edited');

    const automaticUpdateFromReviewedState = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: makeStoryState('2026-07-02T00:00:00.000Z'),
      diffs: [
        makeDiff(
          'diff-after-review',
          '2026-07-02T00:00:00.000Z',
          '2026-07-02T00:00:00.000Z',
          false,
          reviewedAt
        ),
      ],
      staticInputHash: 'same',
    });
    expect(automaticUpdateFromReviewedState.reasons).not.toContain('story_state_edited');

    const manualEditAfterAutomaticUpdates = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: makeStoryState('2026-07-05T00:00:00.000Z'),
      diffs: [
        makeDiff(
          'auto-2',
          '2026-07-04T00:00:00.000Z',
          '2026-07-04T00:00:00.000Z',
          false,
          '2026-07-03T00:00:00.000Z'
        ),
        makeDiff(
          'auto-1',
          '2026-07-03T00:00:00.000Z',
          '2026-07-03T00:00:00.000Z',
          false,
          reviewedAt
        ),
      ],
      staticInputHash: 'same',
    });
    expect(manualEditAfterAutomaticUpdates.reasons).toContain('story_state_edited');

    const inconsistentAutomaticDiffs = refineScanService.calculateRefineReviewStatus({
      cachedScan: { ...reviewedScan, reviewedStoryStateDiffId: null },
      storyState: makeStoryState('2026-07-04T00:00:00.000Z'),
      diffs: [
        makeDiff(
          'cycle-2',
          '2026-07-04T00:00:00.000Z',
          '2026-07-04T00:00:00.000Z',
          false,
          '2026-07-03T00:00:00.000Z'
        ),
        makeDiff(
          'cycle-1',
          '2026-07-03T00:00:00.000Z',
          '2026-07-03T00:00:00.000Z',
          false,
          '2026-07-04T00:00:00.000Z'
        ),
      ],
      staticInputHash: 'same',
    });
    expect(inconsistentAutomaticDiffs.reasons).toContain('story_state_edited');

    const legacy = refineScanService.calculateRefineReviewStatus({
      cachedScan: makeScan(),
      storyState: reviewedState,
      diffs: Array.from({ length: 10 }, (_, index) =>
        makeDiff(`legacy-${index}`, `2026-07-${String(20 - index).padStart(2, '0')}T00:00:00.000Z`, reviewedAt)
      ),
      staticInputHash: 'anything',
    });
    expect(legacy.reasons).toContain('story_progressed');
  });
});

function makeStoryState(updatedAt: string): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    updatedAt,
  };
}

function makeDiff(
  diffId: string,
  appliedAt: string,
  resultUpdatedAt: string,
  reverted = false,
  previousUpdatedAt?: string
): StoryStateDiffRecord {
  return {
    diffId,
    generationId: `gen-${diffId}`,
    sceneId: `scene-${diffId}`,
    appliedAt,
    ...(previousUpdatedAt ? { previousUpdatedAt } : {}),
    summary: {
      addedEvents: [],
      updatedEvents: [],
      addedThreads: [],
      resolvedThreads: [],
      updatedCharacters: [],
      clockChanged: false,
    },
    resultUpdatedAt,
    reverted,
  };
}

function makeScan(overrides: Partial<RefineScanResult> = {}): RefineScanResult {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-01T00:00:00.000Z',
    usedModel: { provider: 'gemini', modelName: 'test' },
    coreConcept: '',
    findings: [],
    lastError: null,
    ...overrides,
  };
}

function mockAdapterGenerateText(result: {
  text: string;
  finishReason: 'stop' | 'error' | 'timeout' | 'length' | 'content_filter';
}) {
  // NOTE: デフォルトプロバイダーは gemini なので Gemini adapter だけ差し替える。
  vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
    text: result.text,
    finishReason: result.finishReason,
    retryable: false,
  });
}
