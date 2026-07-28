import { DEFAULT_ACTIVE_PRESET_IDS } from './defaults.js';
import type { ActivePresets } from './types/index.js';

// NOTE: 連載小説の生成で使うカテゴリ順。地の文・章立てを前提にした語彙なので、
// ロールプレイ会話には流さない（流すと固定規則の応答形式と衝突する）。
export const NOVEL_PRESET_CATEGORY_ORDER = [
  'narration',
  'aftertaste',
  'emotionDisplay',
  'sceneProgression',
  'chapterEnding',
  'painLevel',
  'intimacy',
] as const satisfies readonly (keyof ActivePresets)[];

// NOTE: ロールプレイ会話用。UI の編集対象はこの全カテゴリ。
export const ROLEPLAY_PRESET_CATEGORY_ORDER = [
  'rpResponseStyle',
  'rpInitiative',
  'rpDistance',
  'rpMood',
  'rpEmotionDisplay',
  'rpPainLevel',
  'rpIntimacy',
] as const satisfies readonly (keyof ActivePresets)[];

// NOTE: rpResponseStyle だけは【ロールプレイ規則】の応答形式として直接埋め込むため、
// プリセット本文としては描画しない（同じ指示が二重に出るのを避ける）。
export const ROLEPLAY_RENDERED_PRESET_CATEGORY_ORDER =
  ROLEPLAY_PRESET_CATEGORY_ORDER.filter(
    (key) => key !== 'rpResponseStyle'
  ) as readonly (keyof ActivePresets)[];

// NOTE: intimacy は旧形式にも同名キーがあるため、新旧判定の材料から外す。
// rp* は旧形式と衝突しないので、ロールプレイ設定だけの入力も現行形式として扱える。
const CURRENT_PRESET_CATEGORY_MARKERS = [
  ...NOVEL_PRESET_CATEGORY_ORDER.filter((key) => key !== 'intimacy'),
  ...ROLEPLAY_PRESET_CATEGORY_ORDER,
] as const;

// NOTE: default-presets.json と正規化許可リストの双方向ドリフトをテストするため公開する。
// 実行時ロジックとテストが別々のID一覧を持たないことが目的。
export const BUILT_IN_PRESET_ID_SETS = {
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
  rpResponseStyle: new Set(['dialogue-only', 'bracketed-action', 'prose-mixed']),
  rpInitiative: new Set(['follow', 'balanced', 'lead']),
  rpDistance: new Set(['guarded', 'natural', 'eager']),
  rpMood: new Set(['warm', 'tense', 'playful', 'melancholic', 'eerie', 'flirtatious']),
  rpEmotionDisplay: new Set(['restrained', 'expressive']),
  rpPainLevel: new Set(['safe', 'bittersweet', 'unflinching']),
  rpIntimacy: new Set([
    'fade-to-black',
    'suggestive',
    'aesthetic-soft',
    'direct-soft',
    'direct-explicit',
  ]),
} as const;

export function normalizeActivePresetIds(raw: unknown): ActivePresets {
  const source = isRecord(raw) ? raw : {};
  return CURRENT_PRESET_CATEGORY_MARKERS.some((key) => Object.hasOwn(source, key))
    ? normalizeCurrentPresetIds(source)
    : migrateLegacyPresetIds(source);
}

function normalizeCurrentPresetIds(source: Record<string, unknown>): ActivePresets {
  const result: ActivePresets = { ...DEFAULT_ACTIVE_PRESET_IDS };
  const narration = asKnownString(source.narration, BUILT_IN_PRESET_ID_SETS.narration);
  if (narration) result.narration = narration;
  const responseStyle = asKnownString(
    source.rpResponseStyle,
    BUILT_IN_PRESET_ID_SETS.rpResponseStyle
  );
  if (responseStyle) result.rpResponseStyle = responseStyle;

  const aftertaste = normalizeMultiSelect(
    source.aftertaste,
    BUILT_IN_PRESET_ID_SETS.aftertaste
  );
  if (aftertaste.length > 0) result.aftertaste = aftertaste;
  const rpMood = normalizeMultiSelect(source.rpMood, BUILT_IN_PRESET_ID_SETS.rpMood);
  if (rpMood.length > 0) result.rpMood = rpMood;

  assignKnownString(
    result,
    'emotionDisplay',
    source.emotionDisplay,
    BUILT_IN_PRESET_ID_SETS.emotionDisplay
  );
  assignKnownString(
    result,
    'sceneProgression',
    source.sceneProgression,
    BUILT_IN_PRESET_ID_SETS.sceneProgression
  );
  assignKnownString(
    result,
    'chapterEnding',
    source.chapterEnding,
    BUILT_IN_PRESET_ID_SETS.chapterEnding
  );
  assignKnownString(
    result,
    'painLevel',
    source.painLevel,
    BUILT_IN_PRESET_ID_SETS.painLevel
  );
  assignKnownString(result, 'intimacy', source.intimacy, BUILT_IN_PRESET_ID_SETS.intimacy);
  assignKnownString(
    result,
    'rpInitiative',
    source.rpInitiative,
    BUILT_IN_PRESET_ID_SETS.rpInitiative
  );
  assignKnownString(
    result,
    'rpDistance',
    source.rpDistance,
    BUILT_IN_PRESET_ID_SETS.rpDistance
  );
  assignKnownString(
    result,
    'rpEmotionDisplay',
    source.rpEmotionDisplay,
    BUILT_IN_PRESET_ID_SETS.rpEmotionDisplay
  );
  assignKnownString(
    result,
    'rpPainLevel',
    source.rpPainLevel,
    BUILT_IN_PRESET_ID_SETS.rpPainLevel
  );
  assignKnownString(
    result,
    'rpIntimacy',
    source.rpIntimacy,
    BUILT_IN_PRESET_ID_SETS.rpIntimacy
  );
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

  const legacyIntimacy = asKnownString(
    source.intimacy,
    BUILT_IN_PRESET_ID_SETS.intimacy
  );
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

// NOTE: 複数選択カテゴリ（読後感・会話の空気）は最大2件。3件以上を並べても
// 相反する指示になりやすいため、上限は共通で 2 に固定する。
function normalizeMultiSelect(value: unknown, allowed: ReadonlySet<string>): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const result: string[] = [];
  for (const entry of values) {
    const id = asKnownString(entry, allowed);
    if (!id || result.includes(id)) continue;
    result.push(id);
    if (result.length === 2) break;
  }
  return result;
}

type SingleSelectKey = Exclude<
  keyof ActivePresets,
  'narration' | 'aftertaste' | 'rpResponseStyle' | 'rpMood'
>;

function assignKnownString<K extends SingleSelectKey>(
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
