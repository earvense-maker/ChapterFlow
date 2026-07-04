import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  Character,
  GenerationRecord,
  MemoryImportance,
  Project,
  StoryCharacterState,
  StoryEventRecord,
  StoryItemStatus,
  StoryState,
  StoryThreadRecord,
} from '../types/index.js';

const STORY_STATE_OUTPUT_LENGTH = 2400;
const STORY_STATE_TEMPERATURE = 0.15;
const MAX_CURRENT_SITUATION = 12;
const MAX_CHARACTER_STATES = 24;
const MAX_IMPORTANT_EVENTS = 48;
const MAX_OPEN_THREADS = 36;
const storyStateMutexes = new Map<string, Promise<void>>();

export function createEmptyStoryState(updatedAt = nowIso()): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
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
  return withStoryStateLock(input.project.projectId, async () => {
    const previousState = await readStoryState(input.project.projectId);
    const result = await input.adapter.generateText({
      systemInstructions: buildSystemInstructions(),
      userPrompt: buildUpdatePrompt({
        previousState,
        generation: input.generation,
        characters: input.characters,
        worldText: input.worldText,
      }),
      outputLength: STORY_STATE_OUTPUT_LENGTH,
      temperature: STORY_STATE_TEMPERATURE,
      timeoutMs: input.timeoutMs,
      modelName: input.project.activeModelName,
    });

    if (result.finishReason === 'error' || result.finishReason === 'timeout') {
      return null;
    }

    const parsed = parseStoryStateJson(result.text);
    if (!parsed) return null;

    const nextState = mergeStoryState(previousState, parsed, nowIso());
    await storage.writeStoryState(input.project.projectId, nextState);
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
    role: character.role,
    currentState: character.currentState || '',
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
      '- importantEvents には、新規または更新が必要な不可逆な出来事・約束・秘密の開示だけを入れる。',
      '- openThreads には、新規または更新が必要な未解決の伏線だけを入れる。解決済みは既存threadIdを使い status を resolved にする。',
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
            knowledge: ['今回更新が必要な認識'],
            relationships: ['今回更新が必要な関係変化'],
          },
        ],
        importantEvents: [
          {
            eventId: '既存eventIdまたは空文字',
            sceneId: input.generation.sceneId,
            summary: '今回追加または更新が必要な重要イベント',
            characters: ['関係人物'],
            visibility: '誰が知っているか',
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
  fallbackUpdatedAt = nowIso()
): StoryState {
  const previous = normalizeStoryState(previousValue, fallbackUpdatedAt);
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
      fallbackUpdatedAt
    ),
    importantEvents: mergeEventRecords(
      previous.importantEvents,
      patchValue.importantEvents,
      fallbackUpdatedAt
    ),
    openThreads: mergeThreadRecords(
      previous.openThreads,
      patchValue.openThreads,
      fallbackUpdatedAt
    ),
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

function normalizeStoryState(value: unknown, fallbackUpdatedAt = nowIso()): StoryState {
  if (!isRecord(value)) return createEmptyStoryState(fallbackUpdatedAt);

  return {
    schemaVersion: 1,
    currentSituation: asStringArray(value.currentSituation, MAX_CURRENT_SITUATION),
    characterStates: asArray(value.characterStates)
      .map((item) => normalizeCharacterState(item, fallbackUpdatedAt))
      .filter((item): item is StoryCharacterState => item !== null)
      .slice(0, MAX_CHARACTER_STATES),
    importantEvents: asArray(value.importantEvents)
      .map((item) => normalizeEventRecord(item, fallbackUpdatedAt))
      .filter((item): item is StoryEventRecord => item !== null)
      .slice(0, MAX_IMPORTANT_EVENTS),
    openThreads: asArray(value.openThreads)
      .map((item) => normalizeThreadRecord(item, fallbackUpdatedAt))
      .filter((item): item is StoryThreadRecord => item !== null)
      .slice(0, MAX_OPEN_THREADS),
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

function mergeCharacterStates(
  previous: StoryCharacterState[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string
): StoryCharacterState[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findCharacterStateIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeCharacterStatePatch(raw, existing, fallbackUpdatedAt);
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
  fallbackUpdatedAt: string
): StoryCharacterState | null {
  const characterId = hasField(value, 'characterId')
    ? asNullableString(value.characterId)
    : existing?.characterId ?? null;
  const name = hasField(value, 'name') ? asString(value.name) : existing?.name ?? '';
  const currentState = hasField(value, 'currentState')
    ? asString(value.currentState)
    : existing?.currentState ?? '';
  if (!name && !currentState) return null;

  return {
    characterId,
    name: name || existing?.name || 'Unknown',
    currentState,
    knowledge: hasField(value, 'knowledge')
      ? asStringArray(value.knowledge, 12)
      : existing?.knowledge ?? [],
    relationships: hasField(value, 'relationships')
      ? asStringArray(value.relationships, 12)
      : existing?.relationships ?? [],
    updatedAt: fallbackUpdatedAt,
  };
}

function findCharacterStateIndex(
  states: StoryCharacterState[],
  raw: Record<string, unknown>
): number {
  const characterId = asString(raw.characterId);
  if (characterId) {
    const byId = states.findIndex((state) => state.characterId === characterId);
    if (byId >= 0) return byId;
  }

  const name = asString(raw.name);
  return name ? states.findIndex((state) => state.name === name) : -1;
}

function normalizeEventRecord(value: unknown, fallbackUpdatedAt: string): StoryEventRecord | null {
  if (!isRecord(value)) return null;

  const summary = asString(value.summary);
  if (!summary) return null;

  return {
    eventId: normalizeId(value.eventId, 'evt'),
    sceneId: asNullableString(value.sceneId),
    summary,
    characters: asStringArray(value.characters, 12),
    visibility: asString(value.visibility),
    importance: asImportance(value.importance, 'medium'),
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function mergeEventRecords(
  previous: StoryEventRecord[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string
): StoryEventRecord[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findEventIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeEventPatch(raw, existing, fallbackUpdatedAt);
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
  fallbackUpdatedAt: string
): StoryEventRecord | null {
  const summary = hasField(value, 'summary') ? asString(value.summary) : existing?.summary ?? '';
  if (!summary) return null;

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
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function withStoryStateLock<T>(
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
