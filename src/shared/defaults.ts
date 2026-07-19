import type { ActivePresets, ProjectType, SetupPurpose } from './types.js';

export const DEFAULT_ACTIVE_PRESET_IDS = {
  narration: 'third-close',
} satisfies ActivePresets;

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
