import type { EpisodeId, GenerationId, MemoryId, SceneId } from './ids.js';
import type { GenerationStyleProfile } from './style.js';
import type { ActivePresets } from './project.js';
import type { FinishReason } from './model.js';

export interface GenerationRequest {
  wish: string;
  outputLength: number;
  previousContextText: string;
  previousContextFilePath?: string;
  previousContextChars?: number;
  situationMemo?: string;
  // NOTE: null / 未指定は「自動」。wish 文字列から視点を推測する旧挙動は廃止したので、
  // 明示指定が無い限りサーバーは hard rule を作らない。
  viewpointCharacterId?: string | null;
}

// NOTE: プロンプト予算の適用結果。本文・秘密・プロンプト原文は絶対に含めない
// （report は UI とログの双方へ出るため）。
export type PromptBudgetAction =
  | 'full'
  | 'truncated'
  | 'omitted'
  | 'selected'
  | 'summarized';

export interface PromptBudgetEntry {
  sectionId: string;
  originalChars: number;
  includedChars: number;
  action: PromptBudgetAction;
}

export interface PromptBudgetReport {
  maxChars: number;
  assembledChars: number;
  // NOTE: promptTokens は provider 実測値か予算判定用の保守的推定値のどちらか。
  // どちらであるかは source で必ず判別できるようにする。
  tokenCheck?: {
    promptTokens: number;
    source: 'provider' | 'conservative';
    inputTokenLimit?: number;
    contextWindowTokens: number;
    estimatedMaxOutputTokens: number;
    safetyMarginTokens: number;
  };
  entries: PromptBudgetEntry[];
}

export type GenerationStatus = 'draft' | 'accepted' | 'rejected' | 'superseded';

export interface GenerationRecord {
  generationId: GenerationId;
  sceneId: SceneId;
  episodeId: EpisodeId;
  request: GenerationRequest;
  responseText: string;
  usedPresets: ActivePresets;
  usedModel: {
    provider: string;
    modelName: string;
  };
  referencedMemoryIds: MemoryId[];
  status: GenerationStatus;
  createdAt: string;
  parentGenerationId: GenerationId | null;
  outputFilePath?: string;
  bannedExpressions?: string[];
  // NOTE: 'length' の場合は本文を失わず下書きとして残しつつ、UIで上限到達を通知する。
  finishReason?: FinishReason;
  styleProfile?: GenerationStyleProfile;
  promptBudgetReport?: PromptBudgetReport;
}

export interface GenerateRequestBody {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
  viewpointCharacterId?: string | null;
}
