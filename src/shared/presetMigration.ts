import { DEFAULT_ACTIVE_PRESET_IDS } from './defaults.js';
import type { ActivePresets } from './types/index.js';

export const PRESET_CATEGORY_ORDER = [
  'narration',
  'aftertaste',
  'emotionDisplay',
  'sceneProgression',
  'chapterEnding',
  'painLevel',
  'intimacy',
] as const satisfies readonly (keyof ActivePresets)[];

const presetIds = {
  narration: new Set(['first-person', 'third-close', 'third-objective']),
  aftertaste: new Set(['heartwarming', 'poignant', 'searing', 'uplifting', 'eerie', 'comical']),
  emotionDisplay: new Set(['restrained', 'expressive']),
  sceneProgression: new Set(['immersive', 'brisk']),
  chapterEnding: new Set(['hook', 'lingering']),
  painLevel: new Set(['safe', 'bittersweet', 'unflinching']),
  intimacy: new Set([
    'fade-to-black',
    'suggestive',
    'aesthetic-soft',
    'direct-soft',
    'direct-explicit',
  ]),
} as const;

export function normalizeActivePresetIds(raw: unknown): ActivePresets {
  const source = isRecord(raw) ? raw : {};
  return Object.hasOwn(source, 'narration')
    ? normalizeCurrentPresetIds(source)
    : migrateLegacyPresetIds(source);
}

function normalizeCurrentPresetIds(source: Record<string, unknown>): ActivePresets {
  const result: ActivePresets = { ...DEFAULT_ACTIVE_PRESET_IDS };
  const narration = asKnownString(source.narration, presetIds.narration);
  if (narration) result.narration = narration;

  const aftertaste = normalizeAftertaste(source.aftertaste);
  if (aftertaste.length > 0) result.aftertaste = aftertaste;

  assignKnownString(result, 'emotionDisplay', source.emotionDisplay, presetIds.emotionDisplay);
  assignKnownString(result, 'sceneProgression', source.sceneProgression, presetIds.sceneProgression);
  assignKnownString(result, 'chapterEnding', source.chapterEnding, presetIds.chapterEnding);
  assignKnownString(result, 'painLevel', source.painLevel, presetIds.painLevel);
  assignKnownString(result, 'intimacy', source.intimacy, presetIds.intimacy);
  return result;
}

function migrateLegacyPresetIds(source: Record<string, unknown>): ActivePresets {
  const result: ActivePresets = { ...DEFAULT_ACTIVE_PRESET_IDS };
  const legacyPov = asString(source.pov);
  if (legacyPov === 'first-person') result.narration = 'first-person';
  else if (
    legacyPov === 'third-person-fixed' ||
    legacyPov === 'third-person-close' ||
    legacyPov === 'per-scene'
  ) {
    result.narration = 'third-close';
  }

  const legacyIntimacy = asKnownString(source.intimacy, presetIds.intimacy);
  if (legacyIntimacy) result.intimacy = legacyIntimacy;

  const distance = asString(source.distance);
  if (distance === 'emotional') result.emotionDisplay = 'expressive';
  else if (distance === 'factual') result.emotionDisplay = 'restrained';

  const style = asString(source.style);
  if (!result.emotionDisplay && style === 'quiet') result.emotionDisplay = 'restrained';
  if (style === 'afterglow') result.chapterEnding = 'lingering';
  if (style === 'tense') result.aftertaste = ['searing'];

  const pacing = asString(source.pacing);
  if (pacing === 'slow') result.sceneProgression = 'immersive';
  else if (pacing === 'fast' || pacing === 'action-driven') {
    result.sceneProgression = 'brisk';
  }

  if (!result.emotionDisplay && asString(source.density) === 'emotion-descriptive') {
    result.emotionDisplay = 'expressive';
  }
  return result;
}

function normalizeAftertaste(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const result: string[] = [];
  for (const entry of values) {
    const id = asKnownString(entry, presetIds.aftertaste);
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length === 2) break;
  }
  return result;
}

function assignKnownString<K extends Exclude<keyof ActivePresets, 'narration' | 'aftertaste'>>(
  result: ActivePresets,
  key: K,
  value: unknown,
  allowed: ReadonlySet<string>
): void {
  const id = asKnownString(value, allowed);
  if (id) result[key] = id;
}

function asKnownString(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  const normalized = asString(value);
  return normalized && allowed.has(normalized) ? normalized : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
