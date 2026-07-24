import { STYLE_PROFILE_SCHEMA_VERSION } from './types/index.js';
import type {
  ActivePresets,
  GenerationStyleProfile,
  GenerationNotificationEvents,
  GenerationNotificationSettings,
  ProjectType,
  RefineAutomationMode,
  RefineAutomationScanPolicy,
  RefineAutomationSettings,
  SetupPurpose,
  StyleAxis,
  StyleVariationSettings,
} from './types/index.js';

export const DEFAULT_ACTIVE_PRESET_IDS = {
  narration: 'third-close',
} satisfies ActivePresets;

export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

export function geminiOmitsSamplingParameters(modelName: string): boolean {
  const normalized = modelName.trim().toLowerCase().replace(/^models\//, '');
  // NOTE: latest alias は破壊的変更の予告後に新モデルへ追従するため、新仕様側に倒す。
  if (/^gemini-.+-latest$/.test(normalized)) return true;
  if (/^gemini-3\.5-flash-lite(?:[.-]|$)/.test(normalized)) return true;

  const version = normalized.match(/^gemini-(\d+)(?:\.(\d+))?(?:[.-]|$)/);
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  return major > 3 || (major === 3 && minor >= 6);
}

// NOTE: 保存データが未指定のときの正規化先。全 API 境界で共通化する。
export const DEFAULT_PROJECT_TYPE: ProjectType = 'novel';
export const DEFAULT_SETUP_PURPOSE: SetupPurpose = 'novel';

export function normalizeProjectType(value: unknown): ProjectType {
  return value === 'roleplay' ? 'roleplay' : DEFAULT_PROJECT_TYPE;
}

export function normalizeSetupPurpose(value: unknown): SetupPurpose {
  return value === 'roleplay' ? 'roleplay' : DEFAULT_SETUP_PURPOSE;
}

// NOTE: ロールプレイモードのキャラ・プロジェクト用の上限。projectService の
// normalizeCharacter / normalizeRoleplayProjectFields で全書き込み経路に適用する。
export const ROLEPLAY_LIMITS = {
  greetingChars: 500,
  dialogueExampleChars: 200,
  dialogueExamplesCount: 5,
  scenarioSeedChars: 200,
  scenarioSeedsCount: 10,
  scenarioChars: 1000,
  // NOTE: 1 応答の目安字数の許容範囲。UI と projectService の両方で使う。
  outputCharsMin: 100,
  outputCharsMax: 500,
} as const;

export const DEFAULT_ROLEPLAY_OUTPUT_CHARS = 250;

// NOTE: 既存利用者へ突然音・OS通知を出さないよう、sound/popup は既定 false。
// firstOutput/failed/settingsUpdated/reviewRequired は有用性が高いため既定 true、
// completed のみ「毎回鳴る」を避けるため既定 false（設計書 5.1）。
export const DEFAULT_GENERATION_NOTIFICATION_SETTINGS: GenerationNotificationSettings = {
  soundEnabled: false,
  systemPopupEnabled: false,
  onlyWhenUnfocused: true,
  events: {
    firstOutput: true,
    completed: false,
    failed: true,
    settingsUpdated: true,
    reviewRequired: true,
  },
};

export function normalizeGenerationNotificationSettings(value: unknown): GenerationNotificationSettings {
  const defaults = DEFAULT_GENERATION_NOTIFICATION_SETTINGS;
  if (typeof value !== 'object' || value === null) {
    return defaults;
  }
  const raw = value as Partial<GenerationNotificationSettings> & {
    events?: Partial<GenerationNotificationEvents> | null;
  };
  const rawEvents: Partial<GenerationNotificationEvents> =
    typeof raw.events === 'object' && raw.events !== null ? raw.events : {};
  const bool = (input: unknown, fallback: boolean): boolean => (typeof input === 'boolean' ? input : fallback);
  return {
    soundEnabled: bool(raw.soundEnabled, defaults.soundEnabled),
    systemPopupEnabled: bool(raw.systemPopupEnabled, defaults.systemPopupEnabled),
    onlyWhenUnfocused: bool(raw.onlyWhenUnfocused, defaults.onlyWhenUnfocused),
    events: {
      firstOutput: bool(rawEvents.firstOutput, defaults.events.firstOutput),
      completed: bool(rawEvents.completed, defaults.events.completed),
      failed: bool(rawEvents.failed, defaults.events.failed),
      settingsUpdated: bool(rawEvents.settingsUpdated, defaults.events.settingsUpdated),
      reviewRequired: bool(rawEvents.reviewRequired, defaults.events.reviewRequired),
    },
  };
}

// NOTE: 新規プロジェクトの既定値。既存プロジェクトで refineAutomation が未保存の場合は
// undefined のままとし、ガード側は effectiveRefineAutomationMode で 'off' と解釈する
// （設計書 5.2 の移行方針: 明示保存されるまで有効化しない）。
export const NEW_PROJECT_REFINE_AUTOMATION_SETTINGS: RefineAutomationSettings = {
  mode: 'safe',
  scanPolicy: 'when-needed',
};

const REFINE_AUTOMATION_MODES: readonly RefineAutomationMode[] = ['off', 'suggest', 'safe', 'all'];
const REFINE_AUTOMATION_SCAN_POLICIES: readonly RefineAutomationScanPolicy[] = ['when-needed', 'always'];

export function normalizeRefineAutomationSettings(value: unknown): RefineAutomationSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    return { mode: 'off', scanPolicy: 'when-needed' };
  }
  const raw = value as { mode?: unknown; scanPolicy?: unknown };
  const mode = REFINE_AUTOMATION_MODES.includes(raw.mode as RefineAutomationMode)
    ? (raw.mode as RefineAutomationMode)
    : 'off';
  const scanPolicy = REFINE_AUTOMATION_SCAN_POLICIES.includes(raw.scanPolicy as RefineAutomationScanPolicy)
    ? (raw.scanPolicy as RefineAutomationScanPolicy)
    : 'when-needed';
  return { mode, scanPolicy };
}

// NOTE: 「未保存 = off」の解釈を1箇所に集約する。生成ガード・パイプライン・UI は
// すべてここを経由し、`settings?.mode ?? 'off'` を各所へ書き散らさない。
export function effectiveRefineAutomationMode(settings: RefineAutomationSettings | undefined): RefineAutomationMode {
  return settings?.mode ?? 'off';
}

export const STYLE_AXES: readonly StyleAxis[] = [
  'visual',
  'auditory',
  'somatic',
  'introspective',
  'kinetic',
  'dialogic',
  'temporal',
];

export const STYLE_ENTRY_CHANNELS = [
  'visual',
  'pressure',
  'temperature',
  'sound',
  'distance',
] as const;

const DEFAULT_STYLE_AXIS_WEIGHTS = Object.fromEntries(
  STYLE_AXES.map((axis) => [axis, 0.5])
) as Record<StyleAxis, number>;

export const DEFAULT_STYLE_VARIATION_SETTINGS: StyleVariationSettings = {
  enabled: false,
  intensity: 'subtle',
  axisWeights: DEFAULT_STYLE_AXIS_WEIGHTS,
  surfaceDecayEnabled: true,
  patternDecayEnabled: true,
  motifExclusions: [],
};

export function normalizeStyleVariationSettings(value: unknown): StyleVariationSettings | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ...DEFAULT_STYLE_VARIATION_SETTINGS,
      axisWeights: { ...DEFAULT_STYLE_AXIS_WEIGHTS },
      motifExclusions: [],
    };
  }

  const raw = value as {
    enabled?: unknown;
    intensity?: unknown;
    axisWeights?: unknown;
    surfaceDecayEnabled?: unknown;
    patternDecayEnabled?: unknown;
    motifExclusions?: unknown;
  };
  const rawWeights =
    typeof raw.axisWeights === 'object' && raw.axisWeights !== null && !Array.isArray(raw.axisWeights)
      ? (raw.axisWeights as Record<string, unknown>)
      : {};
  const hasValidCore =
    typeof raw.enabled === 'boolean' &&
    (raw.intensity === 'subtle' || raw.intensity === 'balanced') &&
    typeof raw.surfaceDecayEnabled === 'boolean' &&
    typeof raw.patternDecayEnabled === 'boolean' &&
    typeof raw.axisWeights === 'object' &&
    raw.axisWeights !== null &&
    !Array.isArray(raw.axisWeights);
  const axisWeights = Object.fromEntries(
    STYLE_AXES.map((axis) => {
      const candidate = rawWeights[axis];
      const weight =
        typeof candidate === 'number' && Number.isFinite(candidate)
          ? Math.min(1, Math.max(0, candidate))
          : DEFAULT_STYLE_AXIS_WEIGHTS[axis];
      return [axis, weight];
    })
  ) as Record<StyleAxis, number>;
  const allZero = STYLE_AXES.every((axis) => axisWeights[axis] === 0);

  const motifExclusions = Array.isArray(raw.motifExclusions)
    ? [...new Set(
        raw.motifExclusions
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().slice(0, 100))
          .filter(Boolean)
      )].slice(0, 30)
    : [];

  return {
    enabled: hasValidCore && raw.enabled === true,
    intensity: raw.intensity === 'balanced' ? 'balanced' : 'subtle',
    axisWeights: allZero ? { ...DEFAULT_STYLE_AXIS_WEIGHTS } : axisWeights,
    surfaceDecayEnabled:
      typeof raw.surfaceDecayEnabled === 'boolean' ? raw.surfaceDecayEnabled : true,
    patternDecayEnabled:
      typeof raw.patternDecayEnabled === 'boolean' ? raw.patternDecayEnabled : true,
    motifExclusions,
  };
}

export function normalizeGenerationStyleProfile(
  value: unknown
): GenerationStyleProfile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Partial<GenerationStyleProfile>;
  if (
    raw.schemaVersion !== STYLE_PROFILE_SCHEMA_VERSION ||
    typeof raw.seed !== 'string' ||
    !STYLE_AXES.includes(raw.primaryAxis as StyleAxis) ||
    (raw.secondaryAxis !== undefined && !STYLE_AXES.includes(raw.secondaryAxis as StyleAxis)) ||
    (raw.intensity !== 'subtle' && raw.intensity !== 'balanced')
  ) {
    return undefined;
  }
  const entryChannel = STYLE_ENTRY_CHANNELS.includes(
    raw.entryChannel as (typeof STYLE_ENTRY_CHANNELS)[number]
  )
    ? raw.entryChannel
    : undefined;
  const secondaryAxis =
    raw.intensity === 'balanced' && raw.secondaryAxis
      ? (raw.secondaryAxis as StyleAxis)
      : undefined;

  return {
    schemaVersion: STYLE_PROFILE_SCHEMA_VERSION,
    seed: raw.seed,
    primaryAxis: raw.primaryAxis as StyleAxis,
    ...(secondaryAxis ? { secondaryAxis } : {}),
    ...(entryChannel ? { entryChannel } : {}),
    attenuatedPatterns: Array.isArray(raw.attenuatedPatterns)
      ? raw.attenuatedPatterns
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().slice(0, 100))
          .filter(Boolean)
          .slice(0, 3)
      : [],
    intensity: raw.intensity,
  };
}
