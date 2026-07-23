import type {
  ActivePresets,
  GenerationNotificationEvents,
  GenerationNotificationSettings,
  ProjectType,
  RefineAutomationMode,
  RefineAutomationScanPolicy,
  RefineAutomationSettings,
  SetupPurpose,
} from './types.js';

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
