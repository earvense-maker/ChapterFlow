// NOTE: 採用本文から StoryState patch と canon patch を1回の構造化LLM抽出から作る
// サービス（設計書 6.3・7.1）。LLMは NarrativeObservation[] だけを正本として返し、
// 両patchは正規化済みobservationsからserver側が派生させる。抽出結果は
// accepted-derivations.json にgenerationId単位でキャッシュし、部分保存からの再開で
// モデルを再呼び出ししない。
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { matchStoryCharacterStates } from '../utils/characterStateMatching.js';
import * as storage from './storageService.js';
import {
  applyCanonPatchUnlocked,
  LATENT_CANON_LIMITS,
  readLatentCanonStore,
  registerConflictsUnlocked,
} from './latentCanonService.js';
import {
  mergeStoryState,
  normalizeStoryState,
  withStoryStateLock,
} from './storyStateService.js';
import { withProjectWriteLock } from './projectLock.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  AcceptedNarrativeDerivation,
  CanonPatchEntry,
  Character,
  CreativeContract,
  GenerationRecord,
  NarrativeObservation,
  NarrativeObservationConflict,
  Project,
  StoryAuthorUndecidedRecord,
  StoryState,
} from '../types/index.js';

const DERIVATION_OUTPUT_LENGTH = 9_000;
const DERIVATION_RETRY_OUTPUT_LENGTH = 14_000;
const DERIVATION_MAX_OUTPUT_TOKENS_INITIAL = 12_000;
const DERIVATION_MAX_OUTPUT_TOKENS_RETRY = 20_000;
const DERIVATION_TEMPERATURE = 0.15;
const MAX_CANON_OBSERVATIONS = 20;

// NOTE: 観測抽出のLLM呼び出し。既存のstoryState抽出プロンプトを観測モデルへ拡張した形。
export async function extractNarrativeObservations(input: {
  project: Project;
  adapter: ModelAdapter;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
  previousState: StoryState;
  relatedCanon: import('../types/index.js').LatentCanonItem[];
  contract: CreativeContract | null;
  authorUndecided: StoryAuthorUndecidedRecord[];
  timeoutMs: number;
}): Promise<NarrativeObservation[]> {
  const userPrompt = buildExtractionPrompt(input);
  let parsed: NarrativeObservation[] | null = null;

  const attempts = [
    {
      outputLength: DERIVATION_OUTPUT_LENGTH,
      maxOutputTokens: DERIVATION_MAX_OUTPUT_TOKENS_INITIAL,
    },
    {
      outputLength: DERIVATION_RETRY_OUTPUT_LENGTH,
      maxOutputTokens: DERIVATION_MAX_OUTPUT_TOKENS_RETRY,
    },
  ];
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const result = await input.adapter.generateText({
      debugLabel: `acceptedDerivation.extract.attempt${attemptIndex + 1}`,
      systemInstructions: buildSystemInstructions(),
      userPrompt,
      outputLength: attempt.outputLength,
      maxOutputTokens: attempt.maxOutputTokens,
      temperature: DERIVATION_TEMPERATURE,
      timeoutMs:
        attemptIndex === 0 ? input.timeoutMs : Math.max(5_000, Math.floor(input.timeoutMs / 2)),
      modelName: input.project.activeModelName,
      responseMimeType: 'application/json',
    });

    if (result.finishReason === 'timeout') {
      throw new Error('物語の状態抽出がタイムアウトしました。少し待ってから再抽出してください。');
    }
    if (result.finishReason === 'error') {
      throw new Error(
        result.errorMessage ||
          (result.errorCode ? `物語の状態抽出に失敗しました（${result.errorCode}）。` : '物語の状態抽出に失敗しました。')
      );
    }
    if (result.finishReason === 'content_filter') {
      throw new Error('モデルの安全判定により物語の状態を抽出できませんでした。');
    }

    parsed = parseObservations(result.text);
    if (result.finishReason === 'length') {
      if (attemptIndex === attempts.length - 1) {
        throw new Error('物語の状態JSONが出力上限で途中までになりました。再抽出してください。');
      }
      parsed = null;
      continue;
    }
    if (parsed) break;
  }

  if (!parsed) {
    throw new Error('モデルの応答が途中で切れたか、状態JSONとして読み取れませんでした。再抽出してください。');
  }
  return parsed;
}

function buildSystemInstructions(): string {
  return [
    'あなたは連載小説アプリの状態管理係です。',
    '採用済み本文だけを根拠に、次回生成で矛盾を避けるための構造化JSONを更新してください。',
    '小説本文や説明文を書かず、JSON配列だけを出力してください。',
    '本文にない事実や未確定の過去を勝手に確定しないでください。',
  ].join('\n');
}

function buildExtractionPrompt(input: {
  previousState: StoryState;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
  relatedCanon: import('../types/index.js').LatentCanonItem[];
  contract: CreativeContract | null;
  authorUndecided: StoryAuthorUndecidedRecord[];
}): string {
  const matches = matchStoryCharacterStates(input.characters, input.previousState.characterStates);
  const characterHints = input.characters.map((character) => {
    const trackedState = matches.byCharacterId.get(character.characterId);
    const initialState = trackedState?.currentState.trim()
      ? ''
      : character.currentState || '';
    return {
      characterId: character.characterId,
      name: character.name,
      aliases: character.aliases ?? [],
      role: character.role,
      initialState,
      relationshipNotes: character.relationshipNotes || '',
    };
  });

  const hardContracts = (input.contract?.items ?? []).filter(
    (item) => item.strength === 'hard' && item.status === 'active'
  );
  const exceptions = input.contract?.exceptions ?? [];
  const canonSummary = input.relatedCanon.map((item) => ({
    canonId: item.canonId,
    scope: item.scope,
    statement: item.statement,
    status: item.status,
    epistemicStatus: item.epistemicStatus,
    subjectCharacterIds: item.subjectCharacterIds ?? [],
  }));

  return [
    '【既存の物語状態JSON】',
    JSON.stringify(input.previousState, null, 2),
    '【人物ヒント】',
    JSON.stringify(characterHints, null, 2),
    '【世界設定抜粋】',
    input.worldText.trim().slice(0, 4000) || 'なし',
    '【既存の潜在設定（関連項目のみ・本文にまだ出ていない可能性がある）】',
    canonSummary.length > 0 ? JSON.stringify(canonSummary, null, 2) : 'なし',
    '【作品の約束（絶対に守る・hard）】',
    hardContracts.length > 0
      ? hardContracts
          .map((item) => `[${item.contractId}] ${item.kind}: ${item.text}`)
          .join('\n')
      : 'なし',
    '【承認済み例外（このgenerationには契約が適用されない）】',
    exceptions.length > 0
      ? exceptions
          .map((item) => `[${item.contractId}] generation=${item.generationId}`)
          .join('\n')
      : 'なし',
    '【まだ確定させないこと（authorUndecided）】',
    input.authorUndecided.length > 0
      ? input.authorUndecided.map((item) => `- ${item.text}`).join('\n')
      : 'なし',
    '【今回採用された場面】',
    [
      `episodeId: ${input.generation.episodeId}`,
      `sceneId: ${input.generation.sceneId}`,
      input.generation.responseText,
    ].join('\n\n'),
    '【更新方針】',
    [
      '- 出力はJSON配列。今回の場面で「起きた・明らかになった・示唆された」ことを観測として返す。',
      '- kind の使い分け:',
      '  - situation: 次の場面開始時点の現在状況（短文、複数あれば複数件）。',
      '  - character-state: 新規または更新が必要な人物の現在状態。textに新しい状態を入れる。knowledgeには今回得た小さな知識・観察・仮説（1件30字以内、1人物あたり最大3件）。既存knowledgeの取り消しはremoveKnowledgeに完全一致文字列。',
      '  - event: 不可逆な出来事・約束・秘密の開示。既存eventの解決はoperation=resolve。',
      '  - thread: 作中で提示済みの謎・伏線。解決済みはoperation=resolveで既存threadIdを維持する。',
      '  - canon: 世界観・人物の過去・関係性など設定的事実で、次回以降の生成で一貫させる必要があるもの。',
      '- epistemicStatus: fact=地の文や証拠で明示された客観的事実。claim=人物が主張した。belief=人物が信じている（内容の真偽は未確定）。rumor=噂として存在する。台詞・内心・噂をfactにしない。',
      '- disclosure: revealed=本文で明示された。foreshadowed=曖昧な示唆だけ。',
      '- targetId: 既存のeventId/threadId/characterId/canonIdを更新するときだけ指定。新規は空文字。',
      '- subjectCharacterIds: 観測の主体となる人物のcharacterId。actorCharacterId / recipientCharacterId は「主客の構造」が明確なeventだけ指定し、誰が主体か読み取れない場合は指定しない（推測しない）。人物ヒントに存在するIDだけを使う。',
      '- knownBy / addUnknownBy / removeUnknownBy には人物ヒントのcharacterIdだけを使う。',
      '  - addUnknownBy: この場面終了時点で、その場に居合わせず伝聞・立ち聞き・観察でも知り得ない主要人物のcharacterId。原則としてknownBy以外の主要人物は全員入れる。',
      '  - 判定は「この場面が終わった瞬間」で切る。次の場面で伝える予定があっても、この場面終了時点ではまだ知らないので addUnknownBy に入れる。',
      '  - 主要人物とは role が protagonist / deuteragonist の人物と直前のcharacterStatesに登場する人物。',
      '- evidenceExcerpt: 根拠となる本文の短い抜粋（100字以内）。本文全体を複製しない。',
      '- 既存の潜在設定と対応する観測は targetId に既存 canonId を指定し、IDを維持する。',
      '- 既存の潜在設定（provisional/foreshadowed）と採用本文が矛盾する場合、新しいcanon観測の retireTargetCanonId に旧canonIdを指定する。',
      '- 既存のrevealed canonまたはhard契約と意味的に矛盾する観測には conflict を付ける。この場合もevent等としての記録は通常どおり返してよい。',
      '- authorUndecided の項目は本文で確定させない。該当するcanon観測を返さない。',
      '- clock は場面終了時点の物語内時間。日をまたいだ描写があればdayを進める。経過が読み取れない場合は省略。',
      '- archiveEventIds / archiveThreadIds: 不要になった既存ID。',
      '- 各配列は簡潔に保つ。長い本文引用は入れない。',
    ].join('\n'),
    '【観測JSON形式】',
    JSON.stringify(
      [
        {
          observationId: '一意キー（空文字でもよい）',
          kind: 'canon',
          operation: 'add',
          targetId: '既存canonIdまたは空文字',
          scope: 'world|character|relationship|history|plot|other',
          text: '観測の内容',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          subjectCharacterIds: ['char-id'],
          actorCharacterId: 'char-id',
          recipientCharacterId: 'char-id',
          knownBy: ['char-id'],
          addUnknownBy: ['char-id'],
          removeUnknownBy: ['char-id'],
          evidenceExcerpt: '根拠の短い抜粋',
          conflict: {
            kind: 'revealed-canon',
            targetCanonId: 'canon-id',
            targetContractId: 'contract-id',
            summary: '矛盾の理由',
          },
          retireTargetCanonId: 'canon-id',
          knowledge: ['小さな知識（30字以内）'],
          removeKnowledge: ['既存knowledgeの完全一致文字列'],
          characters: ['関係人物名'],
          presentCharacters: ['char-id'],
          learnedBy: ['char-id'],
          relatedCharacterIds: ['char-id'],
          importance: 'high',
          clock: { day: 1, timeOfDay: '朝', note: '' },
          archiveEventIds: ['evt-id'],
          archiveThreadIds: ['thread-id'],
        },
      ],
      null,
      2
    ),
  ].join('\n\n---\n\n');
}

export function parseObservations(text: string): NarrativeObservation[] | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!withoutFence) return null;
  // NOTE: '{}'（変更なし）を返すモデル応答は空の観測として扱う。配列以外のJSONは
  // 追加のモデル呼び出しで再試行せず「変更なし」に寄せる（旧storyState抽出は
  // mergeStoryState({}) で実質no-opだった。設計書 6.3 の再試行は出力上限時のみ）。
  if (withoutFence.startsWith('{')) {
    try {
      const parsed = JSON.parse(withoutFence);
      if (typeof parsed === 'object' && parsed !== null) return [];
    } catch {
      return null;
    }
  }
  const start = withoutFence.indexOf('[');
  const end = withoutFence.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return normalizeObservations(parsed);
  } catch {
    return null;
  }
}

export function normalizeObservations(value: unknown): NarrativeObservation[] {
  if (!Array.isArray(value)) return [];
  const result: NarrativeObservation[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const kind = asEnum(record.kind, ['situation', 'character-state', 'event', 'thread', 'canon']);
    const text = asString(record.text);
    if (!kind || !text) continue;
    const operation = asEnum(record.operation, ['add', 'update', 'resolve']) ?? 'add';
    const epistemicStatus = asEnum(record.epistemicStatus, [
      'fact',
      'claim',
      'belief',
      'rumor',
      'unknown',
    ]);
    const disclosure = asEnum(record.disclosure, ['foreshadowed', 'revealed']);
    if (!epistemicStatus || !disclosure) continue;
    const observation: NarrativeObservation = {
      observationId: asString(record.observationId) || generateTimestampId('obs'),
      kind,
      operation,
      targetId: asString(record.targetId) || undefined,
      text: text.slice(0, 2_000),
      scope: asEnum(record.scope, [
        'world',
        'character',
        'relationship',
        'history',
        'plot',
        'other',
      ]),
      epistemicStatus,
      disclosure,
      subjectCharacterIds: asStringArray(record.subjectCharacterIds, 24),
      actorCharacterId: asString(record.actorCharacterId) || undefined,
      recipientCharacterId: asString(record.recipientCharacterId) || undefined,
      knownBy: asStringArray(record.knownBy, 24),
      explicitlyUnknownBy: asStringArray(record.explicitlyUnknownBy, 24),
      evidenceExcerpt: asString(record.evidenceExcerpt).slice(0, 160),
      ...(isConflict(record.conflict) ? { conflict: record.conflict } : {}),
      ...(asString(record.retireTargetCanonId)
        ? { retireTargetCanonId: asString(record.retireTargetCanonId) }
        : {}),
      characters: asStringArray(record.characters, 12),
      presentCharacters: asStringArray(record.presentCharacters, 24),
      learnedBy: asStringArray(record.learnedBy, 24),
      addUnknownBy: asStringArray(record.addUnknownBy, 24),
      removeUnknownBy: asStringArray(record.removeUnknownBy, 24),
      knowledge: asStringArray(record.knowledge, 3),
      removeKnowledge: asStringArray(record.removeKnowledge, 12),
      relationships: asStringArray(record.relationships, 12),
      relatedCharacterIds: asStringArray(record.relatedCharacterIds, 24),
      importance: asEnum(record.importance, ['high', 'medium', 'low']),
      clock: normalizeClock(record.clock),
      archiveEventIds: asStringArray(record.archiveEventIds, 24),
      archiveThreadIds: asStringArray(record.archiveThreadIds, 24),
    };
    result.push(observation);
    if (result.length >= MAX_CANON_OBSERVATIONS * 4) break;
  }
  return result;
}

// ============================================================
// patch派生（server側・設計書 6.3「LLMの独立patchを受け取らない」）
// ============================================================

export function deriveStoryStatePatch(
  observations: NarrativeObservation[],
  generation: GenerationRecord,
  characters: Character[]
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const situations = observations.filter((obs) => obs.kind === 'situation');
  if (situations.length > 0) {
    patch.currentSituation = situations.map((obs) => obs.text).slice(0, 12);
  }

  const characterStates = observations
    .filter((obs) => obs.kind === 'character-state')
    .map((obs) => {
      const matched = resolveCharacter(obs, characters);
      const entry: Record<string, unknown> = {
        characterId: matched?.characterId ?? asNullableString(obs.targetId),
        name: matched?.name ?? asString(obs.targetId) ?? '',
        currentState: obs.text,
      };
      if ((obs.knowledge ?? []).length > 0) entry.knowledge = obs.knowledge;
      if ((obs.removeKnowledge ?? []).length > 0) entry.removeKnowledge = obs.removeKnowledge;
      if ((obs.relationships ?? []).length > 0) entry.relationships = obs.relationships;
      return entry;
    })
    .slice(0, 12);
  if (characterStates.length > 0) patch.characterStates = characterStates;

  const events = observations
    .filter((obs) => obs.kind === 'event')
    .map((obs) => {
      const entry: Record<string, unknown> = {
        eventId: asString(obs.targetId),
        sceneId: generation.sceneId,
        summary: obs.text,
        importance: obs.importance ?? 'high',
        status: obs.operation === 'resolve' ? 'resolved' : 'active',
      };
      if ((obs.characters ?? []).length > 0) entry.characters = obs.characters;
      if ((obs.presentCharacters ?? []).length > 0) entry.presentCharacters = obs.presentCharacters;
      if ((obs.learnedBy ?? []).length > 0) entry.learnedBy = obs.learnedBy;
      if ((obs.knownBy ?? []).length > 0) entry.knownBy = obs.knownBy;
      if ((obs.addUnknownBy ?? []).length > 0) entry.addUnknownBy = obs.addUnknownBy;
      if ((obs.removeUnknownBy ?? []).length > 0) entry.removeUnknownBy = obs.removeUnknownBy;
      if (obs.actorCharacterId) entry.actor = obs.actorCharacterId;
      if (obs.recipientCharacterId) entry.recipient = obs.recipientCharacterId;
      return entry;
    })
    .slice(0, 24);
  if (events.length > 0) patch.importantEvents = events;

  const threads = observations
    .filter((obs) => obs.kind === 'thread')
    .map((obs) => ({
      threadId: asString(obs.targetId),
      summary: obs.text,
      ...(((obs.relatedCharacterIds ?? []).length > 0
        ? { relatedCharacters: obs.relatedCharacterIds }
        : {}) as object),
      importance: obs.importance ?? 'medium',
      status: obs.operation === 'resolve' ? 'resolved' : 'active',
    }))
    .slice(0, 12);
  if (threads.length > 0) patch.openThreads = threads;

  const archiveEventIds = observations.flatMap((obs) => obs.archiveEventIds ?? []).slice(0, 24);
  if (archiveEventIds.length > 0) patch.archiveEventIds = archiveEventIds;
  const archiveThreadIds = observations
    .flatMap((obs) => obs.archiveThreadIds ?? [])
    .slice(0, 12);
  if (archiveThreadIds.length > 0) patch.archiveThreadIds = archiveThreadIds;

  const clockObservation = observations.find((obs) => obs.clock && obs.clock.day > 0);
  if (clockObservation?.clock) patch.clock = clockObservation.clock;

  return patch;
}

export function deriveCanonPatch(observations: NarrativeObservation[]): CanonPatchEntry[] {
  const patch: CanonPatchEntry[] = [];
  for (const obs of observations) {
    if (obs.kind !== 'canon') continue;
    if (obs.conflict) continue;
    if (obs.retireTargetCanonId) {
      patch.push({
        operation: 'retire',
        canonId: obs.retireTargetCanonId,
        scope: obs.scope ?? 'other',
        statement: obs.text,
        epistemicStatus: obs.epistemicStatus,
        disclosure: obs.disclosure,
        knownBy: obs.knownBy,
        explicitlyUnknownBy: obs.explicitlyUnknownBy,
        evidenceExcerpt: obs.evidenceExcerpt,
        retiredReason: 'contradicted',
      });
      continue;
    }
    patch.push({
      operation: obs.operation === 'resolve' ? 'resolve' : 'upsert',
      canonId: asString(obs.targetId) || undefined,
      scope: obs.scope ?? 'other',
      subjectCharacterIds: obs.subjectCharacterIds,
      statement: obs.text,
      epistemicStatus: obs.epistemicStatus,
      disclosure: obs.disclosure,
      knownBy: obs.knownBy,
      explicitlyUnknownBy: obs.explicitlyUnknownBy,
      evidenceExcerpt: obs.evidenceExcerpt,
    });
  }
  return patch.slice(0, LATENT_CANON_LIMITS.maxNewPerCall * 2);
}

export function deriveConflicts(
  observations: NarrativeObservation[],
  generation: GenerationRecord
): Array<{
  generationId: string;
  canonId?: string;
  contractId?: string;
  kind: 'revealed-canon' | 'hard-contract';
  summary: string;
  evidenceExcerpt: string;
}> {
  const conflicts: Array<{
    generationId: string;
    canonId?: string;
    contractId?: string;
    kind: 'revealed-canon' | 'hard-contract';
    summary: string;
    evidenceExcerpt: string;
  }> = [];
  for (const obs of observations) {
    const conflict = obs.conflict as NarrativeObservationConflict | undefined;
    if (!conflict) continue;
    conflicts.push({
      generationId: generation.generationId,
      canonId: conflict.targetCanonId ?? (asString(obs.targetId) || undefined),
      contractId: conflict.targetContractId,
      kind: conflict.kind,
      summary: conflict.summary.slice(0, 300),
      evidenceExcerpt: obs.evidenceExcerpt.slice(0, 160),
    });
  }
  return conflicts.slice(0, 20);
}

function resolveCharacter(
  obs: NarrativeObservation,
  characters: Character[]
): { characterId: string; name: string } | null {
  if (obs.subjectCharacterIds && obs.subjectCharacterIds.length > 0) {
    const matched = characters.find((character) => character.characterId === obs.subjectCharacterIds?.[0]);
    if (matched) return { characterId: matched.characterId, name: matched.name };
  }
  const targetId = asString(obs.targetId);
  if (targetId) {
    const matched = characters.find((character) => character.characterId === targetId);
    if (matched) return { characterId: matched.characterId, name: matched.name };
  }
  return null;
}

// NOTE: exception-accepted時の正史化用（設計書 6.3）。deriveCanonPatchはconflict付き観測を
// 正規のcanon patchから除外するため、作者が「今回の本文だけ例外として残す」を選んだ
// 場合にだけ、conflictフラグを無視して該当観測のpatchを導出する。
export function deriveCanonPatchForException(
  observation: NarrativeObservation
): CanonPatchEntry[] {
  if (observation.kind !== 'canon') return [];
  if (observation.retireTargetCanonId) {
    return [
      {
        operation: 'retire',
        canonId: observation.retireTargetCanonId,
        scope: observation.scope ?? 'other',
        statement: observation.text,
        epistemicStatus: observation.epistemicStatus,
        disclosure: observation.disclosure,
        knownBy: observation.knownBy,
        explicitlyUnknownBy: observation.explicitlyUnknownBy,
        evidenceExcerpt: observation.evidenceExcerpt,
        retiredReason: 'contradicted',
      },
    ];
  }
  return [
    {
      operation: observation.operation === 'resolve' ? 'resolve' : 'upsert',
      canonId: asString(observation.targetId) || undefined,
      scope: observation.scope ?? 'other',
      subjectCharacterIds: observation.subjectCharacterIds,
      statement: observation.text,
      epistemicStatus: observation.epistemicStatus,
      disclosure: observation.disclosure,
      knownBy: observation.knownBy,
      explicitlyUnknownBy: observation.explicitlyUnknownBy,
      evidenceExcerpt: observation.evidenceExcerpt,
    },
  ];
}

// ============================================================
// journal（accepted-derivations.json）
// ============================================================

export async function readDerivations(projectId: string): Promise<AcceptedNarrativeDerivation[]> {
  const raw = await storage.readAcceptedDerivations(projectId);
  return raw
    .map((item) => normalizeDerivation(item))
    .filter((item): item is AcceptedNarrativeDerivation => item !== null);
}

export function normalizeDerivation(value: unknown): AcceptedNarrativeDerivation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const generationId = asString(record.generationId);
  if (!generationId) return null;
  const status = asEnum(record.status, ['extracted', 'partially-applied', 'applied', 'stale']);
  return {
    generationId,
    extractedAt: asString(record.extractedAt) || nowIso(),
    observations: Array.isArray(record.observations)
      ? normalizeObservations(record.observations)
      : [],
    storyStatePatch: isRecord(record.storyStatePatch) ? record.storyStatePatch : {},
    canonPatch: Array.isArray(record.canonPatch) ? (record.canonPatch as CanonPatchEntry[]) : [],
    status: status ?? 'extracted',
    ...(asString(record.storyStateAppliedAt)
      ? { storyStateAppliedAt: asString(record.storyStateAppliedAt) }
      : {}),
    ...(asString(record.canonAppliedAt)
      ? { canonAppliedAt: asString(record.canonAppliedAt) }
      : {}),
    ...(asString(record.lastError) ? { lastError: asString(record.lastError).slice(0, 500) } : {}),
  };
}

async function upsertDerivation(projectId: string, derivation: AcceptedNarrativeDerivation): Promise<void> {
  const existing = await readDerivations(projectId);
  const next = [
    derivation,
    ...existing.filter((item) => item.generationId !== derivation.generationId),
  ];
  await storage.writeAcceptedDerivations(projectId, next);
}

// ============================================================
// 適用（冪等・design書 6.3）
// ============================================================

// NOTE: 採用後の派生ジョブの本体。generation単位でjournalを確認し、未抽出なら1回だけ
// LLM抽出してから、StoryState/canonの両patchを同一project lock内で冪等適用する。
export async function runAcceptedNarrativeDerivation(input: {
  project: Project;
  adapter: ModelAdapter;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
  contract: CreativeContract | null;
  authorUndecided: StoryAuthorUndecidedRecord[];
  relatedCanon: import('../types/index.js').LatentCanonItem[];
  timeoutMs: number;
  // NOTE: モデル応答待ちの間に採用が差し替わった場合、適用を無効化するためのガード
  // （project write lock内で評価される）。
  isCurrentAcceptance?: () => Promise<boolean>;
}): Promise<{ storyStateApplied: boolean; canonApplied: boolean }> {
  const projectId = input.project.projectId;
  const generationId = input.generation.generationId;

  const existing = (await readDerivations(projectId)).find(
    (item) => item.generationId === generationId
  );
  let derivation: AcceptedNarrativeDerivation;
  if (existing && existing.status !== 'stale') {
    derivation = existing;
  } else {
    const previousState = normalizeStoryState(await storage.readStoryState(projectId));
    const observations = await extractNarrativeObservations({
      project: input.project,
      adapter: input.adapter,
      generation: input.generation,
      characters: input.characters,
      worldText: input.worldText,
      previousState,
      relatedCanon: input.relatedCanon,
      contract: input.contract,
      authorUndecided: input.authorUndecided,
      timeoutMs: input.timeoutMs,
    });
    derivation = {
      generationId,
      extractedAt: nowIso(),
      observations,
      storyStatePatch: deriveStoryStatePatch(observations, input.generation, input.characters),
      canonPatch: deriveCanonPatch(observations),
      status: 'extracted',
    };
    await upsertDerivation(projectId, derivation);
  }

  return applyDerivation(input.project, input.generation, derivation, {
    isCurrentAcceptance: input.isCurrentAcceptance,
  });
}

// NOTE: 再抽出リトライ・手動refreshから呼ばれる適用。キャッシュ済みpatchだけを使い、
// モデルは再呼び出ししない（設計書 6.3-6・6.4）。
export async function applyDerivation(
  project: Project,
  generation: GenerationRecord,
  derivation: AcceptedNarrativeDerivation,
  options: { isCurrentAcceptance?: () => Promise<boolean> } = {}
): Promise<{ storyStateApplied: boolean; canonApplied: boolean }> {
  const projectId = project.projectId;
  const appliedAt = nowIso();

  const result = await withProjectWriteLock(projectId, async () => {
    if (
      options.isCurrentAcceptance &&
      !(await options.isCurrentAcceptance())
    ) {
      return { storyStateApplied: false, canonApplied: false };
    }

    let storyStateApplied = false;
    let canonApplied = false;

    const [storyStateResult, canonResult] = await Promise.all([
      applyStoryStatePart(projectId, generation, derivation, appliedAt),
      applyCanonPart(projectId, generation, derivation, appliedAt),
    ]);
    storyStateApplied = storyStateResult;
    canonApplied = canonResult;

    // NOTE: 状態は「今回保存したか」ではなく、台帳の実状態（両方のprocessed集合）から
    // 決める。前回StoryState成功・今回canon成功の部分回復では、storyState側は
    // 適用済みとしてfalseを返すため、実状態を見ないとpartially-appliedが永遠に残る
    // （設計書 6.3-6・12.3）。
    const storyStateProcessed = (
      normalizeStoryState(await storage.readStoryState(projectId)).processedGenerationIds ?? []
    ).includes(generation.generationId);
    const canonProcessed = (await readLatentCanonStore(projectId)).processedGenerationIds.includes(
      generation.generationId
    );
    const nextStatus: AcceptedNarrativeDerivation['status'] =
      storyStateProcessed && canonProcessed
        ? 'applied'
        : storyStateProcessed || canonProcessed
          ? 'partially-applied'
          : 'extracted';
    const updated: AcceptedNarrativeDerivation = {
      ...derivation,
      status: nextStatus,
      ...(storyStateProcessed ? { storyStateAppliedAt: appliedAt } : {}),
      ...(canonProcessed ? { canonAppliedAt: appliedAt } : {}),
    };
    await upsertDerivation(projectId, updated);
    return { storyStateApplied, canonApplied };
  });

  return result;
}

async function applyStoryStatePart(
  projectId: string,
  generation: GenerationRecord,
  derivation: AcceptedNarrativeDerivation,
  appliedAt: string
): Promise<boolean> {
  const hasPatch = Object.keys(derivation.storyStatePatch ?? {}).length > 0;
  const previous = normalizeStoryState(await storage.readStoryState(projectId));
  if ((previous.processedGenerationIds ?? []).includes(generation.generationId)) return false;
  await withStoryStateLock(projectId, async () => {
    const latest = normalizeStoryState(await storage.readStoryState(projectId));
    if ((latest.processedGenerationIds ?? []).includes(generation.generationId)) return;
    const characters = await storage.readCharacters(projectId);
    if (hasPatch) {
      const next = mergeStoryState(latest, derivation.storyStatePatch, appliedAt, characters);
      next.processedGenerationIds = appendUnique(
        latest.processedGenerationIds ?? [],
        generation.generationId
      );
      await storage.writeStoryState(projectId, next);
      await appendStoryStateDiff(projectId, generation, latest, next, appliedAt, characters);
    } else {
      // NOTE: 空patch（観測なし）でも、このgenerationは適用済みとしてprocessedに載せる
      // （旧updateStoryStateFromAcceptedSceneはmergeStoryState({})を常に書いていた。
      // 冪等性とbacklogの終了条件は「両方のprocessed集合に入ること」で決まる）。
      await storage.writeStoryState(projectId, {
        ...latest,
        processedGenerationIds: appendUnique(
          latest.processedGenerationIds ?? [],
          generation.generationId
        ),
        updatedAt: appliedAt,
      });
    }
  });
  return true;
}

async function appendStoryStateDiff(
  projectId: string,
  generation: GenerationRecord,
  previous: StoryState,
  next: StoryState,
  appliedAt: string,
  characters: Character[]
): Promise<void> {
  const { summarizeStoryStateDiff } = await import('./storyStateService.js');
  const record = {
    diffId: generateTimestampId('diff'),
    generationId: generation.generationId,
    sceneId: generation.sceneId,
    appliedAt,
    previousUpdatedAt: previous.updatedAt,
    summary: summarizeStoryStateDiff(previous, next, characters),
    beforeState: previous,
    resultUpdatedAt: next.updatedAt,
    reverted: false,
  };
  const existing = await storage.readStoryStateDiffs(projectId);
  const nextDiffs = [record, ...existing].slice(0, 20);
  let snapshotsLeft = 3;
  const trimmed = nextDiffs.map((diff) => {
    if (diff.reverted || !diff.beforeState) return diff;
    if (snapshotsLeft > 0) {
      snapshotsLeft -= 1;
      return diff;
    }
    const { beforeState: _beforeState, ...rest } = diff;
    return rest;
  });
  await storage.writeStoryStateDiffs(projectId, trimmed);
}

async function applyCanonPart(
  projectId: string,
  generation: GenerationRecord,
  derivation: AcceptedNarrativeDerivation,
  appliedAt: string
): Promise<boolean> {
  const store = await readLatentCanonStore(projectId);
  if (store.processedGenerationIds.includes(generation.generationId)) return false;
  const canonPatch = derivation.canonPatch ?? [];
  const conflicts = deriveConflicts(derivation.observations, generation);
  const next = applyCanonPatchUnlocked(store, canonPatch, generation);
  const withConflicts = registerConflictsUnlocked(next.store, conflicts);
  const saved = {
    ...withConflicts,
    revision: withConflicts.revision + 1,
    updatedAt: appliedAt,
  };
  await storage.writeLatentCanon(saved);
  return true;
}

// NOTE: 採用取消時のcanon側巻き戻し（設計書 6.4）。evidence削除・両processed集合から
// 除外・未解決conflictの取り下げ・derivationをextractedへ戻す。storyState側は既存の
// diff revertが担う。モデルを呼ばない。
export async function rollbackCanonForGeneration(
  projectId: string,
  generationId: string
): Promise<void> {
  const store = await readLatentCanonStore(projectId);
  if (store.processedGenerationIds.includes(generationId)) {
    const { removeEvidenceForGenerationUnlocked } = await import('./latentCanonService.js');
    const rolledBack = removeEvidenceForGenerationUnlocked(store, generationId);
    const saved = { ...rolledBack, revision: rolledBack.revision + 1, updatedAt: nowIso() };
    await storage.writeLatentCanon(saved);
  }
  const derivations = await readDerivations(projectId);
  const updated = derivations.map((item) =>
    item.generationId === generationId && item.status !== 'extracted'
      ? { ...item, status: 'extracted' as const }
      : item
  );
  await storage.writeAcceptedDerivations(projectId, updated);
}

function isConflict(value: unknown): value is NarrativeObservationConflict {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.kind === 'revealed-canon' || record.kind === 'hard-contract') &&
    typeof record.summary === 'string'
  );
}

function normalizeClock(value: unknown): { day: number; timeOfDay?: string; note?: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.day !== 'number' || !Number.isFinite(record.day)) return undefined;
  return {
    day: Math.max(1, Math.floor(record.day)),
    ...(asString(record.timeOfDay) ? { timeOfDay: asString(record.timeOfDay) } : {}),
    ...(asString(record.note) ? { note: asString(record.note) } : {}),
  };
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}
