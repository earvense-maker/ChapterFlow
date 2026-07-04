import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import type {
  ActivePresets,
  Character,
  CharacterRole,
  CreateProjectBody,
  Memory,
  MemoryImportance,
  MemoryType,
  SetupSession,
  StoryCharacterState,
  StoryEventRecord,
  StoryItemStatus,
  StoryState,
  StoryThreadRecord,
} from '../types/index.js';
import type { PresetIdsByCategory } from './setupPromptBuilder.js';

const DEFAULT_ACTIVE_PRESETS: ActivePresets = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  relationshipPacing: 'standard',
};

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
  const now = input.now ?? nowIso();
  const raw = isRecord(input.raw) ? input.raw : {};
  const rawProject = isRecord(raw.project) ? raw.project : {};
  const fallbackPresets: Partial<ActivePresets> = {
    ...DEFAULT_ACTIVE_PRESETS,
    ...input.session.projectSettings.activePresetIds,
  };
  const activePresetIds = normalizeActivePresetIds(
    isRecord(rawProject.activePresetIds) ? rawProject.activePresetIds : undefined,
    fallbackPresets,
    input.presetIdsByCategory
  );

  const projectInput: CreateProjectBody = {
    title: asString(rawProject.title) || input.session.projectSettings.title || '無題の作品',
    outputLength: clampOutputLength(
      asNumber(rawProject.outputLength) ?? input.session.projectSettings.outputLength
    ),
    streamingEnabled: input.session.projectSettings.streamingEnabled,
    activeModelProvider: input.session.model.provider,
    activeModelName: input.session.model.modelName,
    activePresetIds,
    worldText: asString(raw.worldText) || buildFallbackWorldText(input.session),
    characters: normalizeCharacters(raw.characters, now, input.session),
    customSystemPrompt: asString(raw.customSystemPrompt),
  };

  return {
    projectInput,
    memories: normalizeMemories(raw.memories, now),
    storyState: normalizeStoryState(raw.storyState, now),
  };
}

function normalizeActivePresetIds(
  raw: Record<string, unknown> | undefined,
  fallback: Partial<ActivePresets>,
  presetIdsByCategory: PresetIdsByCategory
): Partial<ActivePresets> {
  const result: Partial<ActivePresets> = {};
  const keys: Array<keyof ActivePresets> = [
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

  for (const key of keys) {
    const value = asString(raw?.[key]) || fallback[key];
    if (!value) continue;
    const allowed = presetIdsByCategory[key];
    if (allowed?.includes(value)) {
      result[key] = value;
    } else if (fallback[key] && allowed?.includes(fallback[key] as string)) {
      result[key] = fallback[key];
    }
  }

  return {
    ...DEFAULT_ACTIVE_PRESETS,
    ...result,
  };
}

function normalizeCharacters(value: unknown, now: string, session: SetupSession): Character[] {
  const characters = asArray(value)
    .map((item) => normalizeCharacter(item, now))
    .filter((item): item is Character => item !== null)
    .slice(0, 12);
  return characters.length > 0 ? characters : normalizeDraftCharacters(session, now);
}

function normalizeCharacter(value: unknown, now: string): Character | null {
  if (!isRecord(value)) return null;
  const description = asString(value.description);
  const name = asString(value.name);
  const role = normalizeRole(value.role) ?? 'supporting';
  if (!description && !name) return null;

  return {
    characterId: normalizeId(value.characterId, 'char'),
    name,
    role,
    description,
    speechStyle: asString(value.speechStyle) || undefined,
    relationshipNotes: asString(value.relationshipNotes) || undefined,
    secrets: asString(value.secrets) || undefined,
    currentState: asString(value.currentState) || undefined,
  };
}

function normalizeDraftCharacters(session: SetupSession, now: string): Character[] {
  return session.draft.characters
    .filter((character) => character.status === 'active')
    .map((character): Character | null => {
      const name = character.name || character.label;
      const description = character.description || character.label || character.name;
      if (!name && !description) return null;
      return {
        characterId: normalizeId(character.id, 'char'),
        name,
        role: character.role,
        description,
        speechStyle: character.speechStyle,
        relationshipNotes: character.relationshipNotes,
      } satisfies Character;
    })
    .filter((character): character is Character => character !== null)
    .slice(0, 12);
}

function normalizeMemories(value: unknown, now: string): Memory[] {
  return asArray(value)
    .map((item) => normalizeMemory(item, now))
    .filter((item): item is Memory => item !== null)
    .slice(0, 24);
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

function normalizeStoryState(value: unknown, now: string): StoryState {
  if (!isRecord(value)) {
    return {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
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
      .map((item) => normalizeStoryEvent(item, now))
      .filter((item): item is StoryEventRecord => item !== null)
      .slice(0, 48),
    openThreads: asArray(value.openThreads)
      .map((item) => normalizeStoryThread(item, now))
      .filter((item): item is StoryThreadRecord => item !== null)
      .slice(0, 36),
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

function normalizeStoryEvent(value: unknown, now: string): StoryEventRecord | null {
  if (!isRecord(value)) return null;
  const summary = asString(value.summary);
  if (!summary) return null;
  return {
    eventId: normalizeId(value.eventId, 'evt'),
    sceneId: asNullableString(value.sceneId),
    summary,
    characters: normalizeStringList(value.characters, 12),
    visibility: asString(value.visibility),
    importance: normalizeImportance(value.importance, 'medium'),
    status: normalizeStoryStatus(value.status),
    updatedAt: asString(value.updatedAt) || now,
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
    ...session.draft.openingSeeds.map((seed) => `冒頭候補: ${seed}`),
  ]
    .filter(Boolean)
    .join('\n');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
