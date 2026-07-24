import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import {
  DEFAULT_ACTIVE_PRESET_IDS,
  normalizeSetupPurpose,
  ROLEPLAY_LIMITS,
} from '../types/index.js';
import type {
  ActivePresets,
  Character,
  CharacterRole,
  CreateProjectBody,
  Memory,
  MemoryImportance,
  MemoryType,
  ProjectType,
  SetupSession,
  StoryAuthorUndecidedRecord,
  StoryCharacterState,
  StoryClock,
  StoryEventRecord,
  StoryItemStatus,
  StoryState,
  StoryThreadRecord,
  WorldContent,
} from '../types/index.js';
import type { PresetIdsByCategory } from './setupPromptBuilder.js';
import { normalizeComparableText } from './setupDraftPatchService.js';
import { parseWorldMd } from '../utils/worldMd.js';
import { normalizeActivePresetIds } from '../../shared/presetMigration.js';
import {
  normalizeCharacterForStorage,
  normalizeCharacterTraits,
} from '../../shared/characterSchema.js';

const MIN_OUTPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 10000;

export interface NormalizedSetupCommitData {
  projectInput: CreateProjectBody;
  memories: Memory[];
  storyState: StoryState;
}

export async function readPresetIdsByCategory(): Promise<PresetIdsByCategory> {
  const text = await fs.readFile(PRESETS_PATH, 'utf-8');
  const parsed = JSON.parse(text) as {
    categories?: Record<string, { items?: Record<string, unknown> }>;
  };

  const result: PresetIdsByCategory = {};
  for (const [category, data] of Object.entries(parsed.categories ?? {})) {
    result[category] = Object.keys(data.items ?? {});
  }
  return result;
}

export function normalizeSetupCommitData(input: {
  raw: unknown;
  session: SetupSession;
  presetIdsByCategory: PresetIdsByCategory;
  now?: string;
}): NormalizedSetupCommitData {
  return normalizeSetupCommitPlan({ ...input, fallbackWhenWorldEmpty: true });
}

export function normalizeSetupCommitPlan(input: {
  raw: unknown;
  session: SetupSession;
  presetIdsByCategory: PresetIdsByCategory;
  now?: string;
  fallbackWhenWorldEmpty?: boolean;
}): NormalizedSetupCommitData {
  const now = input.now ?? nowIso();
  const raw = isRecord(input.raw) ? input.raw : {};
  const rawProject = isRecord(raw.project) ? raw.project : {};
  const purpose = normalizeSetupPurpose(input.session.purpose);
  const rawActivePresetIds =
    isRecord(rawProject.activePresetIds) ? rawProject.activePresetIds : undefined;
  const activePresetIds = {
    ...DEFAULT_ACTIVE_PRESET_IDS,
    ...normalizeSetupActivePresetIds(
      rawActivePresetIds,
      input.session.projectSettings.activePresetIds ?? {},
      input.presetIdsByCategory
    ),
  };
  // NOTE: roleplay 用途では firstWishSuggestion を出力側で扱わない（設計書 2.2）。
  const firstWishSuggestion =
    purpose === 'roleplay'
      ? ''
      : raw.firstWishSuggestion === undefined
        ? input.session.draft.openingSeeds[0] || ''
        : asString(raw.firstWishSuggestion);

  const characters = normalizeCharacters(raw.characters, now, input.session);
  // NOTE: projectType はモデル出力を信用せず、session.purpose を優先させる（設計書 2.2）。
  const projectType: ProjectType = purpose === 'roleplay' ? 'roleplay' : 'novel';
  const scenarioSeeds =
    purpose === 'roleplay'
      ? normalizeScenarioSeedList(
          Array.isArray(raw.scenarioSeeds) && raw.scenarioSeeds.length > 0
            ? raw.scenarioSeeds
            : input.session.draft.scenarioSeeds ?? []
        )
      : [];

  const projectInput: CreateProjectBody = {
    title: truncate(
      asString(rawProject.title) ||
      input.session.projectSettings.title ||
      buildFallbackProjectTitle(input.session),
      100
    ),
    outputLength: clampOutputLength(
      asNumber(rawProject.outputLength) ?? input.session.projectSettings.outputLength
    ),
    streamingEnabled: input.session.projectSettings.streamingEnabled,
    activeModelProvider: input.session.model.provider,
    activeModelName: input.session.model.modelName,
    activePresetIds,
    applyDefaultPresets: false,
    coreConcept: truncate(asString(raw.coreConcept) || input.session.draft.coreConcept, 300),
    firstWishSuggestion: truncate(firstWishSuggestion, 300),
    styleSample: truncate(asString(raw.styleSample), 1000),
    world: extractWorldContent(raw, input.session, input.fallbackWhenWorldEmpty === true),
    characters,
    customSystemPrompt: asString(raw.customSystemPrompt),
    projectType,
    scenarioSeeds,
  };

  const memories = mergeDraftPreferenceMemories(
    normalizeMemories(raw.memories, now, purpose),
    input.session.draft,
    now
  );

  return {
    projectInput,
    memories,
    storyState: mergeDraftUndecidedIntoStoryState(
      normalizeStoryState(raw.storyState, now, characters),
      input.session,
      now
    ),
  };
}

function normalizeScenarioSeedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    result.push(text.slice(0, ROLEPLAY_LIMITS.scenarioSeedChars));
    if (result.length >= ROLEPLAY_LIMITS.scenarioSeedsCount) break;
  }
  return result;
}

function buildFallbackProjectTitle(session: SetupSession): string {
  const draft = session.draft;
  const source =
    draft.coreConcept ||
    draft.confirmed.find((item) => item.status === 'active')?.text ||
    draft.candidates.find((item) => item.status === 'active')?.title ||
    draft.openingSeeds[0] ||
    '新しい物語';
  const normalized = source
    .replace(/[*#_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const firstPhrase = normalized.split(/[。！？\n]/, 1)[0]?.trim() || '新しい物語';
  const excerpt = firstPhrase.length > 28 ? `${firstPhrase.slice(0, 28)}…` : firstPhrase;
  return `仮題：${excerpt}`;
}

function normalizeSetupActivePresetIds(
  raw: Record<string, unknown> | undefined,
  fallback: Partial<ActivePresets>,
  presetIdsByCategory: PresetIdsByCategory
): Partial<ActivePresets> {
  const normalizedRaw = migrateLegacySetupPresetIds(raw);
  const normalizedFallback = migrateLegacySetupPresetIds(fallback);
  const result: Partial<ActivePresets> = {};
  const keys: Array<keyof ActivePresets> = [
    'narration',
    'aftertaste',
    'emotionDisplay',
    'sceneProgression',
    'chapterEnding',
    'painLevel',
    'intimacy',
  ];

  for (const key of keys) {
    if (key === 'aftertaste') {
      const allowed = presetIdsByCategory[key] ?? [];
      const rawValues = normalizePresetIdList(normalizedRaw?.[key])
        .filter((value) => allowed.includes(value));
      const fallbackValues = normalizePresetIdList(normalizedFallback?.[key])
        .filter((value) => allowed.includes(value));
      const normalized = (rawValues.length > 0 ? rawValues : fallbackValues).slice(0, 2);
      if (normalized.length > 0) result.aftertaste = normalized;
      continue;
    }
    const fallbackValue = asString(normalizedFallback?.[key]);
    const value = asString(normalizedRaw?.[key]) || fallbackValue;
    if (!value) continue;
    const allowed = presetIdsByCategory[key];
    if (allowed?.includes(value)) {
      result[key] = value;
    } else if (
      fallbackValue &&
      allowed?.includes(fallbackValue)
    ) {
      result[key] = fallbackValue;
    }
  }

  return result;
}

function migrateLegacySetupPresetIds(
  value: Record<string, unknown> | Partial<ActivePresets> | undefined
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (Object.hasOwn(value, 'narration')) return { ...value };
  const legacyKeys = [
    'genre',
    'style',
    'pov',
    'distance',
    'pacing',
    'density',
    'conversation',
    'relationshipPacing',
    'constraint',
  ];
  if (!legacyKeys.some((key) => Object.hasOwn(value, key))) return { ...value };

  const migrated: Partial<ActivePresets> = { ...normalizeActivePresetIds(value) };
  const legacyPov = asString((value as Record<string, unknown>).pov);
  if (
    legacyPov !== 'first-person' &&
    legacyPov !== 'third-person-fixed' &&
    legacyPov !== 'third-person-close' &&
    legacyPov !== 'per-scene'
  ) {
    // NOTE: 共通移行関数が必須 narration を補う分は、raw が実際に指定した値ではない。
    // setup の fallback を不意に上書きしないよう、移行可能な旧 pov が無ければ外す。
    delete migrated.narration;
  }
  return { ...migrated };
}

function normalizePresetIdList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const result: string[] = [];
  for (const entry of entries) {
    const id = asString(entry);
    if (!id || result.includes(id)) continue;
    result.push(id);
  }
  return result;
}

function normalizeCharacters(value: unknown, now: string, session: SetupSession): Character[] {
  const characters = asArray(value)
    .map((item) => normalizeCharacter(item, now))
    .filter((item): item is Character => item !== null)
    .slice(0, 12);
  return characters.length > 0 ? characters : normalizeDraftCharacters(session, now);
}

function normalizeCharacter(value: unknown, _now: string): Character | null {
  if (!isRecord(value)) return null;
  const description = asString(value.description);
  const name = asString(value.name);
  const role = normalizeRole(value.role) ?? 'supporting';
  if (!description && !name) return null;

  const dialogueExamples = normalizeDialogueExamplesForCharacter(value.dialogueExamples);
  const greeting = truncate(asString(value.greeting), ROLEPLAY_LIMITS.greetingChars);
  const { cleanTraits, secretsFromTraits } = extractSecretsFromTraits(value.traits);

  return normalizeCharacterForStorage({
    characterId: normalizeId(value.characterId, 'char'),
    name,
    role,
    description,
    aliases: normalizeStringList(value.aliases, 8),
    speechStyle: asString(value.speechStyle) || undefined,
    relationshipNotes: asString(value.relationshipNotes) || undefined,
    secrets: asString(value.secrets) || secretsFromTraits || undefined,
    traits: normalizeCharacterTraits(cleanTraits),
    want: value.want,
    fear: value.fear,
    currentState: asString(value.currentState) || undefined,
    greeting,
    dialogueExamples: dialogueExamples.length > 0 ? dialogueExamples : undefined,
  });
}

function extractSecretsFromTraits(value: unknown): {
  cleanTraits: unknown[];
  secretsFromTraits: string;
} {
  if (!Array.isArray(value)) return { cleanTraits: [], secretsFromTraits: '' };
  const cleanTraits: unknown[] = [];
  let secretsFromTraits = '';
  for (const item of value) {
    if (!isRecord(item)) {
      cleanTraits.push(item);
      continue;
    }
    const label = asString(item.label);
    if (label === '見せない面' || label === '秘密') {
      if (!secretsFromTraits) secretsFromTraits = asString(item.text);
      continue;
    }
    cleanTraits.push(item);
  }
  return { cleanTraits, secretsFromTraits };
}

function normalizeDialogueExamplesForCharacter(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    result.push(text.slice(0, ROLEPLAY_LIMITS.dialogueExampleChars));
    if (result.length >= ROLEPLAY_LIMITS.dialogueExamplesCount) break;
  }
  return result;
}

function normalizeDraftCharacters(session: SetupSession, _now: string): Character[] {
  return session.draft.characters
    .filter((character) => character.status === 'active')
    .map((character): Character | null => {
      const name = character.name || character.label;
      const description = character.description || character.label || character.name;
      if (!name && !description) return null;
      return normalizeCharacterForStorage({
        characterId: normalizeId(character.id, 'char'),
        name,
        role: character.role,
        description,
        aliases: character.label && character.label !== name ? [character.label] : undefined,
        speechStyle: character.speechStyle,
        relationshipNotes: character.relationshipNotes,
        secrets: character.secrets,
        traits: character.traits,
        greeting: character.greeting,
        dialogueExamples: character.dialogueExamples,
      });
    })
    .filter((character): character is Character => character !== null)
    .slice(0, 12);
}

function normalizeMemories(value: unknown, now: string, purpose: 'novel' | 'roleplay' = 'novel'): Memory[] {
  const normalized = asArray(value)
    .map((item) => normalizeMemory(item, now))
    .filter((item): item is Memory => item !== null);
  // NOTE: roleplay 用途は preference / negative のみ許可（設計書 2.2）。
  const filtered = purpose === 'roleplay'
    ? normalized.filter((m) => m.type === 'preference' || m.type === 'negative')
    : normalized;
  return filtered.slice(0, 24);
}

function mergeDraftPreferenceMemories(memories: Memory[], draft: SetupSession['draft'], now: string): Memory[] {
  const memoryTexts = new Set(memories.map((memory) => normalizeComparableText(memory.content)));
  const next = [...memories];

  for (const text of draft.ng) {
    const normalized = normalizeComparableText(text);
    if (!normalized || memoryTexts.has(normalized)) continue;
    if (next.length >= 24) {
      dropLowestImportanceLlmMemory(next);
    }
    if (next.length >= 24) continue;
    next.push({
      memoryId: generateTimestampId('mem'),
      type: 'negative',
      content: text,
      importance: 'high',
      relatedCharacters: [],
      relatedEpisodes: [],
      createdAt: now,
      updatedAt: now,
      sourceSceneId: null,
      status: 'active',
      source: 'manual',
    });
    memoryTexts.add(normalized);
  }

  for (const text of draft.tone) {
    const normalized = normalizeComparableText(text);
    if (!normalized || memoryTexts.has(normalized)) continue;
    if (next.length >= 24) continue;
    next.push({
      memoryId: generateTimestampId('mem'),
      type: 'preference',
      content: text,
      importance: 'medium',
      relatedCharacters: [],
      relatedEpisodes: [],
      createdAt: now,
      updatedAt: now,
      sourceSceneId: null,
      status: 'active',
      source: 'manual',
    });
    memoryTexts.add(normalized);
  }

  return next.slice(0, 24);
}

function dropLowestImportanceLlmMemory(memories: Memory[]): void {
  for (const importance of ['low', 'medium'] as const) {
    for (let index = memories.length - 1; index >= 0; index--) {
      if (memories[index].importance === importance) {
        memories.splice(index, 1);
        return;
      }
    }
  }
}

function normalizeMemory(value: unknown, now: string): Memory | null {
  if (!isRecord(value)) return null;
  const content = asString(value.content);
  if (!content) return null;
  return {
    memoryId: normalizeId(value.memoryId, 'mem'),
    type: normalizeMemoryType(value.type),
    content,
    importance: normalizeImportance(value.importance, 'medium'),
    relatedCharacters: normalizeStringList(value.relatedCharacters, 12),
    relatedEpisodes: normalizeStringList(value.relatedEpisodes, 12),
    createdAt: asString(value.createdAt) || now,
    updatedAt: asString(value.updatedAt) || now,
    sourceSceneId: null,
    status: 'active',
    source: 'manual',
  };
}

function normalizeStoryState(value: unknown, now: string, characters: Character[] = []): StoryState {
  if (!isRecord(value)) {
    return {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 1 },
      processedGenerationIds: [],
      updatedAt: now,
    };
  }

  return {
    schemaVersion: 1,
    currentSituation: normalizeStringList(value.currentSituation, 12),
    characterStates: asArray(value.characterStates)
      .map((item) => normalizeStoryCharacterState(item, now))
      .filter((item): item is StoryCharacterState => item !== null)
      .slice(0, 24),
    importantEvents: asArray(value.importantEvents)
      .map((item) => normalizeStoryEvent(item, now, characters))
      .filter((item): item is StoryEventRecord => item !== null)
      .slice(0, 48),
    openThreads: asArray(value.openThreads)
      .map((item) => normalizeStoryThread(item, now))
      .filter((item): item is StoryThreadRecord => item !== null)
      .slice(0, 36),
    authorUndecided: asArray(value.authorUndecided)
      .map((item) => normalizeAuthorUndecided(item, now))
      .filter((item): item is StoryAuthorUndecidedRecord => item !== null)
      .slice(0, 12),
    clock: normalizeClock(value.clock) ?? { day: 1 },
    processedGenerationIds: normalizeStringList(value.processedGenerationIds, Number.MAX_SAFE_INTEGER),
    updatedAt: asString(value.updatedAt) || now,
  };
}

function normalizeStoryCharacterState(value: unknown, now: string): StoryCharacterState | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const currentState = asString(value.currentState);
  if (!name && !currentState) return null;
  return {
    characterId: asNullableString(value.characterId),
    name: name || 'Unknown',
    currentState,
    knowledge: normalizeStringList(value.knowledge, 12),
    relationships: normalizeStringList(value.relationships, 12),
    updatedAt: asString(value.updatedAt) || now,
  };
}

function normalizeStoryEvent(
  value: unknown,
  now: string,
  characters: Character[]
): StoryEventRecord | null {
  if (!isRecord(value)) return null;
  const summary = asString(value.summary);
  if (!summary) return null;
  const knownBy = normalizeCharacterIdList(value.knownBy, characters, 12);
  // NOTE: Track 2A: 4 → 12 に緩和（storyStateService 側の MAX_EXPLICITLY_UNKNOWN と揃える）。
  const explicitlyUnknownBy = normalizeCharacterIdList(value.explicitlyUnknownBy, characters, 12)
    .filter((id) => !knownBy.includes(id));
  const hasActor = Object.prototype.hasOwnProperty.call(value, 'actor');
  const hasRecipient = Object.prototype.hasOwnProperty.call(value, 'recipient');
  const actor = hasActor ? normalizeSingleCharacterId(value.actor, characters) : undefined;
  const recipient = hasRecipient ? normalizeSingleCharacterId(value.recipient, characters) : undefined;
  return {
    eventId: normalizeId(value.eventId, 'evt'),
    sceneId: asNullableString(value.sceneId),
    summary,
    characters: normalizeStringList(value.characters, 12),
    visibility: asString(value.visibility),
    knownBy,
    explicitlyUnknownBy,
    ...(actor !== undefined ? { actor } : {}),
    ...(recipient !== undefined ? { recipient } : {}),
    importance: normalizeImportance(value.importance, 'medium'),
    status: normalizeStoryStatus(value.status),
    updatedAt: asString(value.updatedAt) || now,
  };
}

function normalizeAuthorUndecided(value: unknown, now: string): StoryAuthorUndecidedRecord | null {
  if (!isRecord(value)) return null;
  const text = asString(value.text);
  if (!text) return null;
  return {
    id: normalizeId(value.id, 'und'),
    text,
    reason: asString(value.reason) || undefined,
    status: normalizeStoryStatus(value.status),
    updatedAt: asString(value.updatedAt) || now,
  };
}

function normalizeClock(value: unknown): StoryClock | undefined {
  if (!isRecord(value)) return undefined;
  const day = asNumber(value.day);
  return {
    day: day ? Math.max(1, Math.floor(day)) : 1,
    timeOfDay: asString(value.timeOfDay) || undefined,
    note: asString(value.note) || undefined,
  };
}

function mergeDraftUndecidedIntoStoryState(
  storyState: StoryState,
  session: SetupSession,
  now: string
): StoryState {
  const existing = new Set(
    (storyState.authorUndecided ?? []).map((item) => normalizeComparableText(item.text))
  );
  const authorUndecided = [...(storyState.authorUndecided ?? [])];
  for (const item of session.draft.undecided) {
    if (item.status !== 'active') continue;
    const normalized = normalizeComparableText(item.text);
    if (!normalized || existing.has(normalized)) continue;
    authorUndecided.push({
      id: normalizeId(item.id, 'und'),
      text: item.text,
      reason: item.reason,
      status: 'active',
      updatedAt: now,
    });
    existing.add(normalized);
    if (authorUndecided.length >= 12) break;
  }
  return {
    ...storyState,
    authorUndecided,
    clock: storyState.clock ?? { day: 1 },
    processedGenerationIds: storyState.processedGenerationIds ?? [],
  };
}

function normalizeStoryThread(value: unknown, now: string): StoryThreadRecord | null {
  if (!isRecord(value)) return null;
  const summary = asString(value.summary);
  if (!summary) return null;
  return {
    threadId: normalizeId(value.threadId, 'thread'),
    summary,
    relatedCharacters: normalizeStringList(value.relatedCharacters, 12),
    importance: normalizeImportance(value.importance, 'medium'),
    status: normalizeStoryStatus(value.status),
    updatedAt: asString(value.updatedAt) || now,
  };
}

function buildFallbackWorldText(session: SetupSession): string {
  return [
    session.draft.coreConcept,
    ...session.draft.world,
    ...session.draft.relationshipSeeds,
    ...session.draft.tone.map((item) => `文体・トーンの希望: ${item}`),
    ...session.draft.openingSeeds.map((seed) => `冒頭候補: ${seed}`),
  ]
    .filter(Boolean)
    .join('\n');
}

function extractWorldContent(
  raw: Record<string, unknown>,
  session: SetupSession,
  fallbackWhenEmpty: boolean
): WorldContent {
  if (isRecord(raw.world)) {
    const world = {
      foundation: asString(raw.world.foundation),
      initialSituation: asString(raw.world.initialSituation),
    };
    if (!fallbackWhenEmpty || world.foundation || world.initialSituation) return world;
  }
  const slippedWorld = asString(raw.world);
  if (slippedWorld) return parseWorldMd(slippedWorld);
  const legacyWorldText = asString(raw.worldText);
  if (legacyWorldText) return parseWorldMd(legacyWorldText);
  // NOTE: フォールバックには可変・不変を判断できない相談ヒントも含まれるため、
  // 古い固定設定として強く扱わず開始時点側へ安全に寄せる。
  return { foundation: '', initialSituation: buildFallbackWorldText(session) };
}

function normalizeRole(value: unknown): CharacterRole | null {
  return value === 'protagonist' ||
    value === 'deuteragonist' ||
    value === 'supporting' ||
    value === 'other'
    ? value
    : null;
}

function normalizeMemoryType(value: unknown): MemoryType {
  return value === 'storyFact' || value === 'preference' || value === 'negative' ? value : 'preference';
}

function normalizeImportance(value: unknown, fallback: MemoryImportance): MemoryImportance {
  return value === 'high' || value === 'medium' || value === 'low' ? value : fallback;
}

function normalizeStoryStatus(value: unknown): StoryItemStatus {
  return value === 'resolved' || value === 'archived' ? value : 'active';
}

function clampOutputLength(value: number | undefined): number {
  const fallback = 3000;
  const finite = Number.isFinite(value) ? Math.round(value as number) : fallback;
  return Math.max(MIN_OUTPUT_LENGTH, Math.min(MAX_OUTPUT_LENGTH, finite));
}

function normalizeId(value: unknown, prefix: string): string {
  const text = asString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : generateTimestampId(prefix);
}

function normalizeStringList(value: unknown, limit: number): string[] {
  const result: string[] = [];
  for (const item of asArray(value)) {
    const text = asString(item);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeCharacterIdList(value: unknown, characters: Character[], limit: number): string[] {
  const validIds = new Set(characters.map((character) => character.characterId));
  const result: string[] = [];
  for (const id of normalizeStringList(value, limit * 2)) {
    if (!validIds.has(id) || result.includes(id)) continue;
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

// NOTE: setup 経路の actor / recipient 用単数 ID 正規化。**strict**:
//  - 人物一覧に無い ID は null（LLM 出力の混入防止）。
//  - characters が空でも null。setup 経路は LLM からの初期値受け入れなので、
//    人物一覧に無い任意文字列を通す必要はない。
function normalizeSingleCharacterId(
  value: unknown,
  characters: Character[]
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const validIds = new Set(characters.map((character) => character.characterId));
  return validIds.has(trimmed) ? trimmed : null;
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

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, maxChars: number): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
