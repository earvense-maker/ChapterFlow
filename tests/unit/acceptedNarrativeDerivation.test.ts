import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDerivation,
  deriveCanonPatch,
  deriveCanonPatchForException,
  deriveConflicts,
  deriveStoryStatePatch,
  normalizeObservations,
  parseObservations,
  readDerivations,
} from '../../src/server/services/acceptedNarrativeDerivationService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import type {
  AcceptedNarrativeDerivation,
  GenerationRecord,
} from '../../src/server/types/index';

const generation: GenerationRecord = {
  generationId: 'gen-1',
  sceneId: 'scene-1',
  episodeId: 'ep-1',
  request: { wish: '', outputLength: 1000, previousContextText: '' },
  responseText: '本文',
  usedPresets: { narration: 'third-close' },
  usedModel: { provider: 'gemini', modelName: 'gemini-test' },
  referencedMemoryIds: [],
  status: 'accepted',
  createdAt: '2026-07-02T00:00:00Z',
  parentGenerationId: null,
};

const createdProjectIds: string[] = [];

afterEach(async () => {
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Derivation Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

describe('parseObservations（設計書 6.3）', () => {
  it('JSON配列を正規化して読む', () => {
    const parsed = parseObservations(
      JSON.stringify([
        {
          kind: 'canon',
          operation: 'add',
          text: '護衛の過去は傭兵だった',
          scope: 'character',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          subjectCharacterIds: ['char-1'],
          evidenceExcerpt: '護衛は告白した。',
        },
      ])
    );
    expect(parsed).toHaveLength(1);
    expect(parsed![0].scope).toBe('character');
    expect(parsed![0].epistemicStatus).toBe('fact');
  });

  it('fenced JSONも読む', () => {
    const parsed = parseObservations('```json\n[]\n```');
    expect(parsed).toEqual([]);
  });

  it("'{}'（変更なし）は空の観測として扱う", () => {
    expect(parseObservations('{}')).toEqual([]);
  });

  it('不正なJSONはnull', () => {
    expect(parseObservations('not json')).toBeNull();
  });

  it('未知enumや空textを落とす', () => {
    const parsed = normalizeObservations([
      { kind: 'canon', operation: 'add', text: '', epistemicStatus: 'fact', disclosure: 'revealed', evidenceExcerpt: '' },
      { kind: 'unknown-kind', operation: 'add', text: '不正', epistemicStatus: 'fact', disclosure: 'revealed', evidenceExcerpt: '' },
      { kind: 'event', operation: 'add', text: '有効な観測', epistemicStatus: 'fact', disclosure: 'revealed', evidenceExcerpt: '抜粋' },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it('台詞の主張はclaimになる（fact昇格しない）', () => {
    const parsed = parseObservations(
      JSON.stringify([
        {
          kind: 'canon',
          operation: 'add',
          text: '私は王の娘だ',
          scope: 'character',
          epistemicStatus: 'claim',
          disclosure: 'revealed',
          evidenceExcerpt: '「私は王の娘だ」',
        },
      ])
    );
    expect(parsed![0].epistemicStatus).toBe('claim');
  });
});

describe('deriveStoryStatePatch（設計書 6.3「LLMの独立patchを受け取らない」）', () => {
  it('situation / character-state / event / threadからStoryState patchを派生する', () => {
    const observations = normalizeObservations([
      { kind: 'situation', operation: 'add', text: '雨の夜、港に逃げる', epistemicStatus: 'fact', disclosure: 'revealed', evidenceExcerpt: '' },
      {
        kind: 'character-state',
        operation: 'update',
        targetId: 'char-1',
        text: '信頼を揺るがされる',
        subjectCharacterIds: ['char-1'],
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
        knowledge: ['護衛が左利きだと知った'],
      },
      {
        kind: 'event',
        operation: 'add',
        text: '護衛が裏切り容疑をかけられる',
        characters: ['護衛'],
        knownBy: ['char-1'],
        actorCharacterId: 'char-1',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
      },
      {
        kind: 'thread',
        operation: 'add',
        text: '王の正体は誰か',
        relatedCharacterIds: ['char-1'],
        epistemicStatus: 'unknown',
        disclosure: 'foreshadowed',
        evidenceExcerpt: '',
      },
      {
        kind: 'thread',
        operation: 'resolve',
        targetId: 'thread-old',
        text: '古い伏線の解決',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
      },
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛の過去は傭兵だった',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
      },
    ]);
    const patch = deriveStoryStatePatch(observations, generation, [
      { characterId: 'char-1', name: 'アキ' } as never,
    ]);
    expect(patch.currentSituation).toEqual(['雨の夜、港に逃げる']);
    expect(patch.characterStates).toEqual([
      {
        characterId: 'char-1',
        name: 'アキ',
        currentState: '信頼を揺るがされる',
        knowledge: ['護衛が左利きだと知った'],
      },
    ]);
    expect(patch.importantEvents).toEqual([
      {
        eventId: '',
        sceneId: 'scene-1',
        summary: '護衛が裏切り容疑をかけられる',
        importance: 'high',
        status: 'active',
        characters: ['護衛'],
        knownBy: ['char-1'],
        actor: 'char-1',
      },
    ]);
    expect(patch.openThreads).toEqual([
      {
        threadId: '',
        summary: '王の正体は誰か',
        relatedCharacters: ['char-1'],
        importance: 'medium',
        status: 'active',
      },
      {
        threadId: 'thread-old',
        summary: '古い伏線の解決',
        importance: 'medium',
        status: 'resolved',
      },
    ]);
  });

  it('canon観測はStoryState patchに現れない', () => {
    const observations = normalizeObservations([
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛の過去は傭兵だった',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
      },
    ]);
    const patch = deriveStoryStatePatch(observations, generation, []);
    expect(Object.keys(patch)).toEqual([]);
  });
});

describe('deriveCanonPatch / deriveConflicts', () => {
  it('canon観測からupsert patchを派生する', () => {
    const observations = normalizeObservations([
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛の過去は傭兵だった',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        subjectCharacterIds: ['char-1'],
        evidenceExcerpt: '護衛は告白した。',
      },
    ]);
    const patch = deriveCanonPatch(observations);
    expect(patch).toEqual([
      {
        operation: 'upsert',
        scope: 'character',
        subjectCharacterIds: ['char-1'],
        statement: '護衛の過去は傭兵だった',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        knownBy: [],
        explicitlyUnknownBy: [],
        evidenceExcerpt: '護衛は告白した。',
      },
    ]);
  });

  it('conflict付き観測はcanon patchに入らずpendingConflictsへ送る', () => {
    const observations = normalizeObservations([
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛は裏切った',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '護衛は裏切った。',
        conflict: {
          kind: 'hard-contract',
          targetContractId: 'ctr-1',
          summary: '「護衛は最後まで裏切らない」と矛盾',
        },
      },
    ]);
    const patch = deriveCanonPatch(observations);
    expect(patch).toEqual([]);
    const conflicts = deriveConflicts(observations, generation);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('hard-contract');
    expect(conflicts[0].contractId).toBe('ctr-1');
    expect(conflicts[0].generationId).toBe('gen-1');
  });

  it('retireTargetCanonId付き観測はretired: contradicted patchになる', () => {
    const observations = normalizeObservations([
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛の過去は山賊だった',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '護衛は山賊だった。',
        retireTargetCanonId: 'can-old',
      },
    ]);
    const patch = deriveCanonPatch(observations);
    expect(patch).toEqual([
      expect.objectContaining({
        operation: 'retire',
        canonId: 'can-old',
        retiredReason: 'contradicted',
      }),
    ]);
  });

  it('deriveCanonPatchForExceptionはconflict付き観測も正史化する（レビュー指摘 P1）', () => {
    const observation = normalizeObservations([
      {
        kind: 'canon',
        operation: 'add',
        text: '護衛は裏切った',
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '護衛は裏切った。',
        conflict: {
          kind: 'hard-contract',
          targetContractId: 'ctr-1',
          summary: '「護衛は最後まで裏切らない」と矛盾',
        },
      },
    ])[0];
    // 通常のderiveCanonPatchはconflict付きを除外する
    expect(deriveCanonPatch([observation])).toEqual([]);
    // 例外承認時はconflictを無視してpatchを導出できる
    const patch = deriveCanonPatchForException(observation);
    expect(patch).toHaveLength(1);
    expect(patch[0].operation).toBe('upsert');
    expect(patch[0].statement).toBe('護衛は裏切った');
  });
});

describe('normalizeObservationsの上限', () => {
  it('大量の観測は切り捨てる', () => {
    const observations = normalizeObservations(
      Array.from({ length: 100 }, (_, index) => ({
        kind: 'canon',
        operation: 'add',
        text: `設定${index}`,
        scope: 'character',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '',
      }))
    );
    expect(observations.length).toBeLessThanOrEqual(80);
  });
});

describe('applyDerivationの部分保存からの回復（レビュー指摘 P1・設計書 12.3）', () => {
  it('StoryState適用済み・canon未適用の回復でderivationがappliedになる', async () => {
    const projectId = await createTrackedProject();
    const project = (await storage.readProject(projectId))!;
    const now = '2026-07-02T00:00:00Z';

    // StoryState側は適用済み（processedGenerationIds含む）で、canon側は未適用の状態を作る。
    const storyState = {
      schemaVersion: 1,
      currentSituation: ['既に適用済み'],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 1 },
      processedGenerationIds: ['gen-1'],
      updatedAt: now,
    };
    await storage.writeStoryState(projectId, storyState);
    const canonStore = await storage.readLatentCanon(projectId);
    expect(canonStore?.processedGenerationIds).toEqual([]);

    const derivation: AcceptedNarrativeDerivation = {
      generationId: 'gen-1',
      extractedAt: now,
      observations: normalizeObservations([
        {
          kind: 'canon',
          operation: 'add',
          text: '護衛の過去は傭兵だった',
          scope: 'character',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '護衛は告白した。',
        },
      ]),
      storyStatePatch: {
        currentSituation: ['既に適用済み'],
      },
      canonPatch: deriveCanonPatch(
        normalizeObservations([
          {
            kind: 'canon',
            operation: 'add',
            text: '護衛の過去は傭兵だった',
            scope: 'character',
            epistemicStatus: 'fact',
            disclosure: 'revealed',
            evidenceExcerpt: '護衛は告白した。',
          },
        ])
      ),
      status: 'partially-applied',
      storyStateAppliedAt: now,
    };
    await storage.writeAcceptedDerivations(projectId, [derivation]);

    const applied = await applyDerivation(project, generation, derivation);
    // storyState側は前回適用済みのため今回はfalse、canon側は今回適用でtrue。
    expect(applied.storyStateApplied).toBe(false);
    expect(applied.canonApplied).toBe(true);

    const [derivations, storedCanon] = await Promise.all([
      readDerivations(projectId),
      storage.readLatentCanon(projectId),
    ]);
    expect(derivations[0].status).toBe('applied');
    expect(storedCanon?.processedGenerationIds).toContain('gen-1');
    expect(storedCanon?.items[0].statement).toBe('護衛の過去は傭兵だった');
  });
});

void vi;
