import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { normalizeComparableText } from '../utils/characterStateMatching.js';
import * as storage from './storageService.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  Character,
  CharacterId,
  GenerationRecord,
  MemoryImportance,
  Project,
  StoryAuthorUndecidedRecord,
  StoryCharacterState,
  StoryClock,
  StoryEventRecord,
  StoryItemStatus,
  StoryState,
  StoryStateDiffRecord,
  StoryStateDiffSummary,
  StoryThreadRecord,
} from '../types/index.js';

const STORY_STATE_OUTPUT_LENGTH = 4000;
const STORY_STATE_RETRY_OUTPUT_LENGTH = 6000;
const STORY_STATE_TEMPERATURE = 0.15;
const MAX_CURRENT_SITUATION = 12;
const MAX_CHARACTER_STATES = 24;
const MAX_IMPORTANT_EVENTS = 48;
const MAX_OPEN_THREADS = 36;
const MAX_AUTHOR_UNDECIDED = 12;
const MAX_EXPLICITLY_UNKNOWN = 4;
const MAX_EVENT_KNOWN_BY = 12;
const MAX_DIFF_RECORDS = 20;
const MAX_DIFF_SNAPSHOTS = 3;
const storyStateMutexes = new Map<string, Promise<void>>();

export function createEmptyStoryState(updatedAt = nowIso()): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    authorUndecided: [],
    clock: { day: 1 },
    processedGenerationIds: [],
    updatedAt,
  };
}

export async function readStoryState(projectId: string): Promise<StoryState> {
  return normalizeStoryState(await storage.readStoryState(projectId));
}

export async function updateStoryStateFromAcceptedScene(input: {
  project: Project;
  adapter: ModelAdapter;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
  timeoutMs: number;
}): Promise<StoryState | null> {
  const promptState = await readStoryState(input.project.projectId);
  const userPrompt = buildUpdatePrompt({
    previousState: promptState,
    generation: input.generation,
    characters: input.characters,
    worldText: input.worldText,
  });
  let parsed: unknown | null = null;

  const outputLengths = [STORY_STATE_OUTPUT_LENGTH, STORY_STATE_RETRY_OUTPUT_LENGTH];
  for (const [attemptIndex, outputLength] of outputLengths.entries()) {
    const result = await input.adapter.generateText({
      systemInstructions: buildSystemInstructions(),
      userPrompt,
      outputLength,
      temperature: STORY_STATE_TEMPERATURE,
      timeoutMs: attemptIndex === 0 ? input.timeoutMs : Math.max(5_000, Math.floor(input.timeoutMs / 2)),
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

    parsed = parseStoryStateJson(result.text);
    if (result.finishReason === 'length') {
      if (attemptIndex === outputLengths.length - 1) {
        throw new Error('物語の状態JSONが出力上限で途中までになりました。再抽出してください。');
      }
      parsed = null;
      continue;
    }
    if (parsed) break;
    // NOTE: 長期作品では差分JSONも出力上限に達することがある。JSON指定でも
    // 応答が途中で切れた場合だけ、一度だけ余裕を増やして再試行する。
  }

  if (!parsed) {
    throw new Error('モデルの応答が途中で切れたか、状態JSONとして読み取れませんでした。再抽出してください。');
  }

  return withStoryStateLock(input.project.projectId, async () => {
    const previousState = await readStoryState(input.project.projectId);
    const appliedAt = nowIso();
    const nextState = mergeStoryState(previousState, parsed, appliedAt, input.characters);
    nextState.processedGenerationIds = appendUnique(
      previousState.processedGenerationIds ?? [],
      input.generation.generationId
    );
    await storage.writeStoryState(input.project.projectId, nextState);
    await appendStoryStateDiff(input.project.projectId, {
      diffId: generateTimestampId('diff'),
      generationId: input.generation.generationId,
      sceneId: input.generation.sceneId,
      appliedAt,
      previousUpdatedAt: previousState.updatedAt,
      summary: summarizeDiff(previousState, nextState, input.characters),
      beforeState: previousState,
      resultUpdatedAt: nextState.updatedAt,
      reverted: false,
    });
    return nextState;
  });
}

function buildSystemInstructions(): string {
  return [
    'あなたは連載小説アプリの状態管理係です。',
    '採用済み本文だけを根拠に、次回生成で矛盾を避けるための構造化JSONを更新してください。',
    '小説本文や説明文を書かず、JSONオブジェクトだけを出力してください。',
    '本文にない事実や未確定の過去を勝手に確定しないでください。',
  ].join('\n');
}

function buildUpdatePrompt(input: {
  previousState: StoryState;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
}): string {
  const characterHints = input.characters.map((character) => ({
    characterId: character.characterId,
    name: character.name,
    aliases: character.aliases ?? [],
    role: character.role,
    initialState: character.currentState || '',
    relationshipNotes: character.relationshipNotes || '',
  }));

  return [
    '【既存の物語状態JSON】',
    JSON.stringify(input.previousState, null, 2),
    '【人物ヒント】',
    JSON.stringify(characterHints, null, 2),
    '【世界設定抜粋】',
    input.worldText.trim().slice(0, 4000) || 'なし',
    '【今回採用された場面】',
    [
      `episodeId: ${input.generation.episodeId}`,
      `sceneId: ${input.generation.sceneId}`,
      input.generation.responseText,
    ].join('\n\n'),
    '【更新方針】',
    [
      '- 出力は既存JSONの全置換ではなく、今回の場面から必要になった差分だけにする。',
      '- currentSituation には、次の場面開始時点の現在状況だけを短く入れる。',
      '- characterStates には、新規または更新が必要な人物だけを入れる。',
      '- 人物ヒントの initialState は開始時点の状態であり、出力キーとして模倣しない。現在状態は characterStates[].currentState に返す。',
      '- characterStates の knowledge は更新対象ではないため出力しない。',
      '- importantEvents には、新規または更新が必要な不可逆な出来事・約束・秘密の開示だけを入れる。',
      '- importantEvents の characters は出来事の当事者名、presentCharacters はその場に居合わせた人物のcharacterId、learnedBy は伝聞・立ち聞き・観察などでこの場面で新たに知った人物のcharacterId。',
      '- knownBy / explicitlyUnknownBy には人物ヒントのcharacterIdだけを使う。本文中の呼び名・あだ名は aliases を参照して必ずcharacterIdへ解決する。',
      '- explicitlyUnknownBy は通常0〜2名。知らないことが物語上の緊張や皮肉を生む人物だけを入れ、その場にいなかった人物を機械的に列挙しない。',
      '- openThreads には、作中で提示済みの謎・伏線だけを入れる。作者がまだ決めていない事項は authorUndecided であり、抽出・更新しない。解決済みは既存threadIdを使い status を resolved にする。',
      '- clock には場面終了時点の物語内時間を入れる。経過が読み取れない場合は既存値をそのまま返す。日をまたいだ描写があればdayを進める。',
      '- 既存項目を更新する場合は eventId/threadId/characterId を維持する。',
      '- 古い項目を出力から省略しても削除にはならない。削除したい場合は archiveEventIds または archiveThreadIds にIDを入れる。',
      '- 各配列は簡潔に保つ。長い本文引用は入れない。',
      '- 新規項目の eventId/threadId は空文字でもよい。',
    ].join('\n'),
    '【差分JSON形式】',
    JSON.stringify(
      {
        currentSituation: ['次の場面開始時点の現在状況'],
        characterStates: [
          {
            characterId: '既存characterIdまたはnull',
            name: '人物名',
            currentState: '今回更新が必要な現在状態',
            relationships: ['今回更新が必要な関係変化'],
          },
        ],
        clock: {
          day: input.previousState.clock?.day ?? 1,
          timeOfDay: input.previousState.clock?.timeOfDay ?? '',
          note: input.previousState.clock?.note ?? '',
        },
        importantEvents: [
          {
            eventId: '既存eventIdまたは空文字',
            sceneId: input.generation.sceneId,
            summary: '今回追加または更新が必要な重要イベント',
            characters: ['関係人物'],
            presentCharacters: ['char-id'],
            learnedBy: ['char-id'],
            knownBy: ['char-id'],
            explicitlyUnknownBy: ['char-id'],
            importance: 'high',
            status: 'active',
          },
        ],
        openThreads: [
          {
            threadId: '既存threadIdまたは空文字',
            summary: '今回追加または更新が必要な未解決事項',
            relatedCharacters: ['関係人物'],
            importance: 'medium',
            status: 'active',
          },
        ],
        archiveEventIds: ['不要になった既存eventId'],
        archiveThreadIds: ['不要になった既存threadId'],
      },
      null,
      2
    ),
  ].join('\n\n---\n\n');
}

export function parseStoryStateJson(text: string): unknown | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function mergeStoryState(
  previousValue: unknown,
  patchValue: unknown,
  fallbackUpdatedAt = nowIso(),
  characters: Character[] = []
): StoryState {
  const previous = normalizeStoryState(previousValue, fallbackUpdatedAt, characters);
  if (!isRecord(patchValue)) {
    return previous;
  }

  const next: StoryState = {
    ...previous,
    currentSituation: hasField(patchValue, 'currentSituation')
      ? asStringArray(patchValue.currentSituation, MAX_CURRENT_SITUATION)
      : previous.currentSituation,
    characterStates: mergeCharacterStates(
      previous.characterStates,
      patchValue.characterStates,
      fallbackUpdatedAt,
      characters
    ),
    importantEvents: mergeEventRecords(
      previous.importantEvents,
      patchValue.importantEvents,
      fallbackUpdatedAt,
      characters
    ),
    openThreads: mergeThreadRecords(
      previous.openThreads,
      patchValue.openThreads,
      fallbackUpdatedAt
    ),
    authorUndecided: previous.authorUndecided,
    clock: hasField(patchValue, 'clock')
      ? mergeClock(previous.clock, patchValue.clock)
      : previous.clock,
    processedGenerationIds: previous.processedGenerationIds,
    updatedAt: fallbackUpdatedAt,
  };

  return {
    ...next,
    importantEvents: archiveEvents(
      next.importantEvents,
      asStringArray(patchValue.archiveEventIds, MAX_IMPORTANT_EVENTS),
      fallbackUpdatedAt
    ).slice(0, MAX_IMPORTANT_EVENTS),
    openThreads: archiveThreads(
      next.openThreads,
      asStringArray(patchValue.archiveThreadIds, MAX_OPEN_THREADS),
      fallbackUpdatedAt
    ).slice(0, MAX_OPEN_THREADS),
  };
}

export function normalizeStoryState(
  value: unknown,
  fallbackUpdatedAt = nowIso(),
  characters: Character[] = []
): StoryState {
  if (!isRecord(value)) return createEmptyStoryState(fallbackUpdatedAt);

  return {
    schemaVersion: 1,
    currentSituation: asStringArray(value.currentSituation, MAX_CURRENT_SITUATION),
    characterStates: asArray(value.characterStates)
      .map((item) => normalizeCharacterState(item, fallbackUpdatedAt))
      .filter((item): item is StoryCharacterState => item !== null)
      .slice(0, MAX_CHARACTER_STATES),
    importantEvents: asArray(value.importantEvents)
      .map((item) => normalizeEventRecord(item, fallbackUpdatedAt, characters))
      .filter((item): item is StoryEventRecord => item !== null)
      .slice(0, MAX_IMPORTANT_EVENTS),
    openThreads: asArray(value.openThreads)
      .map((item) => normalizeThreadRecord(item, fallbackUpdatedAt))
      .filter((item): item is StoryThreadRecord => item !== null)
      .slice(0, MAX_OPEN_THREADS),
    authorUndecided: asArray(value.authorUndecided)
      .map((item) => normalizeAuthorUndecided(item, fallbackUpdatedAt))
      .filter((item): item is StoryAuthorUndecidedRecord => item !== null)
      .slice(0, MAX_AUTHOR_UNDECIDED),
    clock: normalizeClock(value.clock),
    processedGenerationIds: asStringArray(value.processedGenerationIds, Number.MAX_SAFE_INTEGER),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeCharacterState(value: unknown, fallbackUpdatedAt: string): StoryCharacterState | null {
  if (!isRecord(value)) return null;

  const name = asString(value.name);
  const currentState = asString(value.currentState);
  if (!name && !currentState) return null;

  return {
    characterId: asNullableString(value.characterId),
    name: name || 'Unknown',
    currentState,
    knowledge: asStringArray(value.knowledge, 12),
    relationships: asStringArray(value.relationships, 12),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeAuthorUndecided(
  value: unknown,
  fallbackUpdatedAt: string
): StoryAuthorUndecidedRecord | null {
  if (!isRecord(value)) return null;
  const text = asString(value.text);
  if (!text) return null;
  return {
    id: normalizeId(value.id, 'und'),
    text,
    reason: asString(value.reason) || undefined,
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeClock(value: unknown): StoryClock | undefined {
  if (!isRecord(value)) return undefined;
  const dayValue = value.day;
  const day =
    typeof dayValue === 'number' && Number.isFinite(dayValue)
      ? Math.max(1, Math.floor(dayValue))
      : 1;
  return {
    day,
    timeOfDay: asString(value.timeOfDay) || undefined,
    note: asString(value.note) || undefined,
  };
}

function mergeClock(previous: StoryClock | undefined, patch: unknown): StoryClock | undefined {
  const next = normalizeClock(patch);
  if (!next) return previous;
  if (previous && next.day < previous.day) return previous;
  if (!isRecord(patch)) return next;
  return {
    day: next.day,
    timeOfDay: hasField(patch, 'timeOfDay') ? next.timeOfDay : previous?.timeOfDay,
    note: hasField(patch, 'note') ? next.note : previous?.note,
  };
}

function mergeCharacterStates(
  previous: StoryCharacterState[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryCharacterState[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findCharacterStateIndex(next, raw, characters);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeCharacterStatePatch(raw, existing, fallbackUpdatedAt, characters);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_CHARACTER_STATES);
}

function normalizeCharacterStatePatch(
  value: Record<string, unknown>,
  existing: StoryCharacterState | undefined,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryCharacterState | null {
  const rawName = hasField(value, 'name') ? asString(value.name) : existing?.name ?? '';
  const matchedCharacter = rawName ? findCharacterByNameOrAlias(characters, rawName) : null;
  const characterId = hasField(value, 'characterId')
    ? asNullableString(value.characterId) ?? matchedCharacter?.characterId ?? null
    : existing?.characterId ?? matchedCharacter?.characterId ?? null;
  const name = matchedCharacter?.name ?? rawName;
  const currentState = hasField(value, 'currentState')
    ? asString(value.currentState)
    : existing?.currentState ?? '';
  if (!name && !currentState) return null;

  return {
    characterId,
    name: name || existing?.name || 'Unknown',
    currentState,
    knowledge: existing?.knowledge ?? [],
    relationships: hasField(value, 'relationships')
      ? asStringArray(value.relationships, 12)
      : existing?.relationships ?? [],
    updatedAt: fallbackUpdatedAt,
  };
}

function findCharacterStateIndex(
  states: StoryCharacterState[],
  raw: Record<string, unknown>,
  characters: Character[]
): number {
  const characterId = asString(raw.characterId);
  if (characterId) {
    const byId = states.findIndex((state) => state.characterId === characterId);
    if (byId >= 0) return byId;
  }

  const name = asString(raw.name);
  if (name) {
    const byName = states.findIndex((state) => state.name === name);
    if (byName >= 0) return byName;
    const canonical = findCharacterByNameOrAlias(characters, name);
    if (canonical) {
      const byCanonicalId = states.findIndex((state) => state.characterId === canonical.characterId);
      if (byCanonicalId >= 0) return byCanonicalId;
      const byCanonicalName = states.findIndex((state) => state.name === canonical.name);
      if (byCanonicalName >= 0) return byCanonicalName;
    }
  }
  return -1;
}

function normalizeEventRecord(
  value: unknown,
  fallbackUpdatedAt: string,
  characters: Character[] = []
): StoryEventRecord | null {
  if (!isRecord(value)) return null;

  const summary = asString(value.summary);
  if (!summary) return null;
  const knownBy = normalizeCharacterIdList(value.knownBy, characters, MAX_EVENT_KNOWN_BY);
  const explicitlyUnknownBy = normalizeCharacterIdList(
    value.explicitlyUnknownBy,
    characters,
    MAX_EXPLICITLY_UNKNOWN
  ).filter((id) => !knownBy.includes(id));

  return {
    eventId: normalizeId(value.eventId, 'evt'),
    sceneId: asNullableString(value.sceneId),
    summary,
    characters: asStringArray(value.characters, 12),
    visibility: asString(value.visibility),
    knownBy,
    explicitlyUnknownBy,
    importance: asImportance(value.importance, 'medium'),
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function mergeEventRecords(
  previous: StoryEventRecord[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryEventRecord[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findEventIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeEventPatch(raw, existing, fallbackUpdatedAt, characters);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_IMPORTANT_EVENTS);
}

function normalizeEventPatch(
  value: Record<string, unknown>,
  existing: StoryEventRecord | undefined,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryEventRecord | null {
  const summary = hasField(value, 'summary') ? asString(value.summary) : existing?.summary ?? '';
  if (!summary) return null;
  const validExistingKnown = normalizeCharacterIdList(
    existing?.knownBy ?? [],
    characters,
    MAX_EVENT_KNOWN_BY
  );
  const explicitKnownPatchIds = hasField(value, 'knownBy')
    ? normalizeCharacterIdList(value.knownBy, characters, MAX_EVENT_KNOWN_BY)
    : [];
  const presentIds = normalizeCharacterIdList(value.presentCharacters, characters, MAX_EVENT_KNOWN_BY);
  const learnedIds = normalizeCharacterIdList(value.learnedBy, characters, MAX_EVENT_KNOWN_BY);
  const knownBy = mergeUniqueStrings([
    ...validExistingKnown,
    ...explicitKnownPatchIds,
    ...presentIds,
    ...learnedIds,
  ]).slice(0, MAX_EVENT_KNOWN_BY);
  const explicitUnknownSource = hasField(value, 'explicitlyUnknownBy')
    ? value.explicitlyUnknownBy
    : existing?.explicitlyUnknownBy ?? [];
  const explicitlyUnknownBy = normalizeCharacterIdList(
    explicitUnknownSource,
    characters,
    MAX_EXPLICITLY_UNKNOWN
  ).filter((id) => !knownBy.includes(id));

  return {
    eventId: existing?.eventId ?? normalizeId(value.eventId, 'evt'),
    sceneId: hasField(value, 'sceneId')
      ? asNullableString(value.sceneId)
      : existing?.sceneId ?? null,
    summary,
    characters: hasField(value, 'characters')
      ? asStringArray(value.characters, 12)
      : existing?.characters ?? [],
    visibility: hasField(value, 'visibility') ? asString(value.visibility) : existing?.visibility ?? '',
    knownBy,
    explicitlyUnknownBy,
    importance: hasField(value, 'importance')
      ? asImportance(value.importance, existing?.importance ?? 'medium')
      : existing?.importance ?? 'medium',
    status: hasField(value, 'status')
      ? asStatus(value.status, existing?.status ?? 'active')
      : existing?.status ?? 'active',
    updatedAt: fallbackUpdatedAt,
  };
}

function findEventIndex(events: StoryEventRecord[], raw: Record<string, unknown>): number {
  const eventId = asString(raw.eventId);
  if (eventId) {
    const byId = events.findIndex((event) => event.eventId === eventId);
    if (byId >= 0) return byId;
  }

  const summary = normalizeComparableSummary(asString(raw.summary));
  return summary
    ? events.findIndex((event) => normalizeComparableSummary(event.summary) === summary)
    : -1;
}

function archiveEvents(
  events: StoryEventRecord[],
  eventIds: string[],
  fallbackUpdatedAt: string
): StoryEventRecord[] {
  if (eventIds.length === 0) return events;
  const archiveSet = new Set(eventIds);
  return events.map((event) =>
    archiveSet.has(event.eventId)
      ? { ...event, status: 'archived', updatedAt: fallbackUpdatedAt }
      : event
  );
}

function normalizeThreadRecord(value: unknown, fallbackUpdatedAt: string): StoryThreadRecord | null {
  if (!isRecord(value)) return null;

  const summary = asString(value.summary);
  if (!summary) return null;

  return {
    threadId: normalizeId(value.threadId, 'thread'),
    summary,
    relatedCharacters: asStringArray(value.relatedCharacters, 12),
    importance: asImportance(value.importance, 'medium'),
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function mergeThreadRecords(
  previous: StoryThreadRecord[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string
): StoryThreadRecord[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findThreadIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeThreadPatch(raw, existing, fallbackUpdatedAt);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_OPEN_THREADS);
}

function normalizeThreadPatch(
  value: Record<string, unknown>,
  existing: StoryThreadRecord | undefined,
  fallbackUpdatedAt: string
): StoryThreadRecord | null {
  const summary = hasField(value, 'summary') ? asString(value.summary) : existing?.summary ?? '';
  if (!summary) return null;

  return {
    threadId: existing?.threadId ?? normalizeId(value.threadId, 'thread'),
    summary,
    relatedCharacters: hasField(value, 'relatedCharacters')
      ? asStringArray(value.relatedCharacters, 12)
      : existing?.relatedCharacters ?? [],
    importance: hasField(value, 'importance')
      ? asImportance(value.importance, existing?.importance ?? 'medium')
      : existing?.importance ?? 'medium',
    status: hasField(value, 'status')
      ? asStatus(value.status, existing?.status ?? 'active')
      : existing?.status ?? 'active',
    updatedAt: fallbackUpdatedAt,
  };
}

function findThreadIndex(threads: StoryThreadRecord[], raw: Record<string, unknown>): number {
  const threadId = asString(raw.threadId);
  if (threadId) {
    const byId = threads.findIndex((thread) => thread.threadId === threadId);
    if (byId >= 0) return byId;
  }

  const summary = normalizeComparableSummary(asString(raw.summary));
  return summary
    ? threads.findIndex((thread) => normalizeComparableSummary(thread.summary) === summary)
    : -1;
}

function archiveThreads(
  threads: StoryThreadRecord[],
  threadIds: string[],
  fallbackUpdatedAt: string
): StoryThreadRecord[] {
  if (threadIds.length === 0) return threads;
  const archiveSet = new Set(threadIds);
  return threads.map((thread) =>
    archiveSet.has(thread.threadId)
      ? { ...thread, status: 'archived', updatedAt: fallbackUpdatedAt }
      : thread
  );
}

function normalizeCharacterIdList(value: unknown, characters: Character[], maxItems: number): CharacterId[] {
  const validIds = new Set(characters.map((character) => character.characterId));
  const allowAny = validIds.size === 0;
  const result: CharacterId[] = [];
  for (const id of asStringArray(value, maxItems * 2)) {
    if (!allowAny && !validIds.has(id)) continue;
    if (result.includes(id)) continue;
    result.push(id);
    if (result.length >= maxItems) break;
  }
  return result;
}

function mergeUniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const key = normalizeComparableSummary(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function findCharacterByNameOrAlias(characters: Character[], value: string): Character | null {
  const normalized = normalizeComparableSummary(value);
  if (!normalized) return null;
  const candidates = characters.filter(
    (character) =>
      normalizeComparableSummary(character.name) === normalized ||
      (character.aliases ?? []).some(
        (alias) => normalizeComparableSummary(alias) === normalized
      )
  );
  // NOTE: LLM が名前だけを返した場合も、同名・同別名で任意の人物 ID を補完しない。
  return candidates.length === 1 ? candidates[0] : null;
}

function characterNameForId(characterId: string, characters: Character[]): string | null {
  return characters.find((character) => character.characterId === characterId)?.name ?? null;
}

export async function readStoryStateDiffs(projectId: string): Promise<StoryStateDiffRecord[]> {
  const diffs = await storage.readStoryStateDiffs(projectId);
  return normalizeDiffRecords(diffs);
}

export async function revertLatestStoryStateDiff(
  projectId: string,
  diffId: string
): Promise<{ storyState: StoryState; diff: StoryStateDiffRecord }> {
  return withStoryStateLock(projectId, async () => {
    const diffs = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
    const latest = findLatestRevertibleDiff(diffs);
    if (!latest || latest.diffId !== diffId) {
      throw new StoryStateServiceError(
        '取り消せるのは最新の自動更新だけです。',
        'story_state_diff_not_latest',
        409
      );
    }
    if (!latest.beforeState) {
      throw new StoryStateServiceError(
        'この自動更新は復元用データが残っていません。',
        'story_state_snapshot_missing',
        409
      );
    }

    const current = await readStoryState(projectId);
    if (current.updatedAt !== latest.resultUpdatedAt) {
      throw new StoryStateServiceError(
        '状態が手動編集されているため取り消せません。',
        'story_state_stale',
        409
      );
    }

    await storage.writeStoryState(projectId, latest.beforeState);
    const { beforeState: _beforeState, ...diffWithoutSnapshot } = latest;
    const nextDiff = { ...diffWithoutSnapshot, reverted: true };
    const nextDiffs = diffs.map((diff) => (diff.diffId === diffId ? nextDiff : diff));
    await storage.writeStoryStateDiffs(projectId, nextDiffs);
    return { storyState: latest.beforeState, diff: nextDiff };
  });
}

export async function revertLatestStoryStateDiffForGeneration(
  projectId: string,
  generationId: string
): Promise<boolean> {
  return withStoryStateLock(projectId, async () => {
    const diffs = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
    const latest = findLatestRevertibleDiff(diffs);
    if (!latest || latest.generationId !== generationId || !latest.beforeState) return false;
    const current = await readStoryState(projectId);
    if (current.updatedAt !== latest.resultUpdatedAt) return false;

    await storage.writeStoryState(projectId, latest.beforeState);
    const { beforeState: _beforeState, ...diffWithoutSnapshot } = latest;
    await storage.writeStoryStateDiffs(
      projectId,
      diffs.map((diff) =>
        diff.diffId === latest.diffId ? { ...diffWithoutSnapshot, reverted: true } : diff
      )
    );
    return true;
  });
}

export async function replaceStoryState(input: {
  projectId: string;
  storyState: unknown;
  characters: Character[];
}): Promise<StoryState> {
  return withStoryStateLock(input.projectId, async () => {
    const existing = await readStoryState(input.projectId);
    const normalized = normalizeStoryState(input.storyState, nowIso(), input.characters);
    const next: StoryState = {
      ...normalized,
      processedGenerationIds: existing.processedGenerationIds ?? [],
      updatedAt: nowIso(),
    };
    await storage.writeStoryState(input.projectId, next);
    return next;
  });
}

async function appendStoryStateDiff(
  projectId: string,
  record: StoryStateDiffRecord
): Promise<void> {
  const existing = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
  const next = [record, ...existing].slice(0, MAX_DIFF_RECORDS);
  let snapshotsLeft = MAX_DIFF_SNAPSHOTS;
  const trimmed = next.map((diff) => {
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

function normalizeDiffRecords(value: unknown): StoryStateDiffRecord[] {
  return asArray(value)
    .map((item): StoryStateDiffRecord | null => {
      if (!isRecord(item)) return null;
      const diffId = asString(item.diffId);
      const generationId = asString(item.generationId);
      const sceneId = asString(item.sceneId);
      if (!diffId || !generationId || !sceneId) return null;
      const beforeState = isRecord(item.beforeState)
        ? normalizeStoryState(item.beforeState, asString(item.appliedAt) || nowIso())
        : undefined;
      const previousUpdatedAt = asString(item.previousUpdatedAt);
      return {
        diffId,
        generationId,
        sceneId,
        appliedAt: asString(item.appliedAt) || nowIso(),
        ...(previousUpdatedAt ? { previousUpdatedAt } : {}),
        summary: normalizeDiffSummary(item.summary),
        ...(beforeState ? { beforeState } : {}),
        resultUpdatedAt: asString(item.resultUpdatedAt),
        reverted: item.reverted === true,
      };
    })
    .filter((item): item is StoryStateDiffRecord => item !== null)
    .slice(0, MAX_DIFF_RECORDS);
}

function normalizeDiffSummary(value: unknown): StoryStateDiffSummary {
  const record = isRecord(value) ? value : {};
  return {
    addedEvents: asStringArray(record.addedEvents, 8),
    updatedEvents: asStringArray(record.updatedEvents, 8),
    addedThreads: asStringArray(record.addedThreads, 8),
    resolvedThreads: asStringArray(record.resolvedThreads, 8),
    updatedCharacters: asStringArray(record.updatedCharacters, 8),
    clockChanged: record.clockChanged === true,
  };
}

function findLatestRevertibleDiff(diffs: StoryStateDiffRecord[]): StoryStateDiffRecord | null {
  return diffs.find((diff) => !diff.reverted) ?? null;
}

function summarizeDiff(
  previous: StoryState,
  next: StoryState,
  characters: Character[]
): StoryStateDiffSummary {
  const previousEvents = new Map(previous.importantEvents.map((event) => [event.eventId, event]));
  const addedEvents: string[] = [];
  const updatedEvents: string[] = [];
  for (const event of next.importantEvents) {
    const before = previousEvents.get(event.eventId);
    if (!before) {
      addedEvents.push(event.summary);
    } else if (JSON.stringify(before) !== JSON.stringify(event)) {
      updatedEvents.push(event.summary);
    }
  }

  const previousThreads = new Map(previous.openThreads.map((thread) => [thread.threadId, thread]));
  const addedThreads: string[] = [];
  const resolvedThreads: string[] = [];
  for (const thread of next.openThreads) {
    const before = previousThreads.get(thread.threadId);
    if (!before) {
      addedThreads.push(thread.summary);
    } else if (before.status !== 'resolved' && thread.status === 'resolved') {
      resolvedThreads.push(thread.summary);
    }
  }

  const previousCharacters = new Map(previous.characterStates.map((state) => [state.characterId ?? state.name, state]));
  const updatedCharacters = next.characterStates
    .filter((state) => {
      const before = previousCharacters.get(state.characterId ?? state.name);
      return !before || JSON.stringify(before) !== JSON.stringify(state);
    })
    .map((state) => characterNameForId(state.characterId ?? '', characters) ?? state.name)
    .filter(Boolean);

  return {
    addedEvents: addedEvents.slice(0, 8),
    updatedEvents: updatedEvents.slice(0, 8),
    addedThreads: addedThreads.slice(0, 8),
    resolvedThreads: resolvedThreads.slice(0, 8),
    updatedCharacters: mergeUniqueStrings(updatedCharacters).slice(0, 8),
    clockChanged: JSON.stringify(previous.clock) !== JSON.stringify(next.clock),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  return asArray(value)
    .map(asString)
    .filter(Boolean)
    .slice(0, maxItems);
}

function asImportance(value: unknown, fallback: MemoryImportance): MemoryImportance {
  return value === 'high' || value === 'medium' || value === 'low' ? value : fallback;
}

function asStatus(value: unknown, fallback: StoryItemStatus): StoryItemStatus {
  return value === 'active' || value === 'resolved' || value === 'archived' ? value : fallback;
}

function normalizeId(value: unknown, prefix: string): string {
  const text = asString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : generateTimestampId(prefix);
}

function normalizeComparableSummary(value: string): string {
  return normalizeComparableText(value);
}

export async function withStoryStateLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = storyStateMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  storyStateMutexes.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (storyStateMutexes.get(projectId) === next) {
      storyStateMutexes.delete(projectId);
    }
  }
}

export class StoryStateServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'StoryStateServiceError';
  }
}
