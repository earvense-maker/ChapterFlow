import type { EpisodeId, GenerationId, MemoryId, ProjectId, SceneId } from './ids.js';
import type { StyleVariationSettings } from './style.js';
import type { Character } from './character.js';
import type { RefineAutomationSettings, RefineMaintenanceStatus } from './refineAutomation.js';

export interface ActivePresets {
  narration: string;
  aftertaste?: string[];
  emotionDisplay?: string;
  sceneProgression?: string;
  chapterEnding?: string;
  painLevel?: string;
  intimacy?: string;
}

export interface SamplingConfig {
  frequencyPenalty: number;
  presencePenalty: number;
  // NOTE: 未指定なら生成サービス側の TEMPERATURE_DEFAULT (0.9) を使う。variate モードは
  // ここで指定した値に +0.15 を上乗せ（上限 1.3）する。
  temperature?: number;
}

// NOTE: ロールプレイモード用。'novel' は連載小説、'roleplay' はキャラ会話。undefined は
// 後方互換で 'novel' 扱い。API 境界では必ず正規化して返す。
export type ProjectType = 'novel' | 'roleplay';

export interface Project {
  schemaVersion: number;
  projectId: ProjectId;
  title: string;
  coreConcept?: string;
  firstWishSuggestion?: string;
  styleSample?: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  activeModelProvider: string;
  activeModelName: string;
  outputLength: number;
  streamingEnabled: boolean;
  activePresetIds: ActivePresets;
  samplingConfig?: SamplingConfig;
  // NOTE: 種別。保存データでは optional のまま後方互換、API では 'novel' に正規化。
  projectType?: ProjectType;
  // NOTE: ロールプレイ会話開始時に提示するシナリオ候補（会話の舞台）。最大10件。
  scenarioSeeds?: string[];
  // NOTE: ロールプレイ 1 応答の目安字数（プロンプトの outputLength に流し、hard cap も
  // ここから派生）。未指定なら DEFAULT_ROLEPLAY_OUTPUT_CHARS を使う。range 100〜500。
  roleplayOutputChars?: number;
  // NOTE: 生成後の自動設定レビュー設定。undefined は「未保存」（ガード上は off 扱い、
  // 設定画面では safe/when-needed をプレビュー選択として提示）。
  refineAutomation?: RefineAutomationSettings;
  // NOTE: 既存作品では undefined を disabled と解釈する。本文生成の互換性を守るため、
  // 明示的に有効化されるまでpromptへ文体レンズを追加しない。
  styleVariation?: StyleVariationSettings;
}

export interface WorldContent {
  foundation: string;
  initialSituation: string;
}

export interface ProjectState {
  lastOpenedAt: string;
  currentEpisodeId: EpisodeId | null;
  currentSceneId: SceneId | null;
  selectedDraftGenerationId: GenerationId | null;
  lastAcceptedGenerationId: GenerationId | null;
  pendingMemoryCandidateIds: MemoryId[];
  storyStateRefresh?: StoryStateRefreshStatus;
  storyStateBacklogCount?: number;
  // NOTE: 生成後自動レビューの進行状況。scanning/applying/reverting のみ新規生成を
  // ブロックする（refineAutomationService.maintenanceBlocksGeneration）。
  refineMaintenance?: RefineMaintenanceStatus;
  uiState: {
    readingPosition: number;
    fontSize: number;
  };
}

export interface StoryStateRefreshStatus {
  status: 'fresh' | 'pending' | 'stale';
  generationId: GenerationId | null;
  updatedAt: string;
  errorMessage?: string;
}

export interface ProjectSummary {
  projectId: ProjectId;
  title: string;
  updatedAt: string;
  lastOpenedAt: string;
  activePresetIds: ActivePresets;
  lastExcerpt: string;
  // NOTE: サマリーでは undefined を返さず 'novel' に正規化。UI 一覧のバッジ・遷移振分けに使う。
  projectType: ProjectType;
}

export interface CreateProjectBody {
  title?: string;
  outputLength?: number;
  streamingEnabled?: boolean;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
  // NOTE: 後方互換のため残す。現在は false でも必須の narration 既定値だけは補完する。
  applyDefaultPresets?: boolean;
  samplingConfig?: Partial<SamplingConfig>;
  duplicateFrom?: ProjectId;
  coreConcept?: string;
  firstWishSuggestion?: string;
  styleSample?: string;
  world?: WorldContent;
  characters?: Character[];
  customSystemPrompt?: string;
  // NOTE: ロールプレイ型プロジェクトを作る時のみ指定。UpdateProjectBody には含めない
  // （種別の後変更は不可、相互昇格は Phase 2 の課題）。
  projectType?: ProjectType;
  scenarioSeeds?: string[];
  roleplayOutputChars?: number;
  styleVariation?: StyleVariationSettings;
}

export interface UpdateProjectBody {
  title?: string;
  coreConcept?: string;
  firstWishSuggestion?: string;
  styleSample?: string;
  outputLength?: number;
  streamingEnabled?: boolean;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
  samplingConfig?: Partial<SamplingConfig>;
  // NOTE: projectType は不変（後変更は Phase 2 の課題）。scenarioSeeds は
  // ロールプレイ型プロジェクトで会話開始時のチップを追加編集するために更新可能。
  scenarioSeeds?: string[];
  roleplayOutputChars?: number;
  styleVariation?: StyleVariationSettings;
}
