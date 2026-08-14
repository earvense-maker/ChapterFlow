import type { EpisodeId, GenerationId, MemoryId, SceneId } from './ids.js';
import type { GenerationStyleProfile } from './style.js';
import type { ActivePresets, StoryStateRefreshStatus } from './project.js';
import type { AdapterGenerateResult, FinishReason } from './model.js';
import type { GenerationContractValidation } from './canon.js';

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

// NOTE: 予算判定そのものは常に行われる。この型は「判定の内訳を記録に残す」ためのもので、
// 本文・秘密・プロンプト原文を持たない数値と sectionId/action だけを常に保存する
// （AC13: UI とログの両方から確認できるようにするため、開発診断フラグには依存しない）。
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

export type GenerationTextRevisionSource = 'manual-edit' | 'history-restore' | 'ng-auto-rewrite';

export interface EditGenerationTextBody {
  text: string;
  expectedRevisionNumber: number;
  expectedStatus: GenerationStatus;
  expectedAcceptedGenerationId: GenerationId | null;
}

export interface RestoreGenerationTextBody {
  expectedRevisionNumber: number;
  expectedStatus: GenerationStatus;
  expectedAcceptedGenerationId: GenerationId | null;
}
// NOTE: モデルの推論本文は含めない。生成速度の切り分けに必要な時刻・件数・使用量だけを
// GenerationRecord と一緒に永続化し、既存レコードとの互換性は optional field で保つ。
// NOTE: 開発版限定。CHAPTERFLOW_DEV_DIAGNOSTICS が立っているときだけ記録されるため、
// リリース版で作られたレコードにはこのフィールドが無い（読む側は必ず optional 扱いにする）。
// 有効化の判定は src/server/utils/devDiagnostics.ts。
export interface GenerationTelemetry {
  schemaVersion: 1;
  requestStartedAt: string;
  modelRequestStartedAt: string;
  modelCompletedAt: string;
  firstProviderEventAt?: string;
  firstReasoningAt?: string;
  firstContentAt?: string;
  requestToModelMs: number;
  modelDurationMs: number;
  totalDurationMs: number;
  timeToFirstProviderEventMs?: number;
  timeToFirstReasoningMs?: number;
  timeToFirstContentMs?: number;
  reasoningChars?: number;
  reasoningChunks?: number;
  contentChars?: number;
  contentChunks?: number;
  usage?: AdapterGenerateResult['rawUsage'];
}

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
  // NOTE: 以下2つは開発診断（GenerationTelemetry のコメント参照）とセットで記録され、
  // リリース版では書かれない。generationMode は telemetry を読むための文脈情報。
  generationMode?: GenerateRequestBody['mode'];
  telemetry?: GenerationTelemetry;
  styleProfile?: GenerationStyleProfile;
  // NOTE: 予算の適用結果（原文なし）。常に記録する。旧レコードには無いため optional 扱い。
  promptBudgetReport?: PromptBudgetReport;
  // NOTE: 契約検証の監査情報（原文なし・設計書 5.6）。旧レコードの欠損は skipped 相当。
  contractValidation?: GenerationContractValidation;
  /** 実効本文の改訂番号。旧レコード・原文は 0。 */
  textRevisionNumber?: number;
  editedAt?: string;
  // NOTE: 妄想増幅器の advance で作られたレコードに付く。リトライと根拠追跡に使う
  // （設計書 13.2）。旧レコードには無いため optional 扱い。
  amplifierInteractionId?: string;
}

export interface GenerationTextRevisionRecord {
  revisionId: string;
  revisionNumber: number;
  generationId: GenerationId;
  responseText: string;
  source: GenerationTextRevisionSource;
  reason: string;
  before: string;
  after: string;
  beforeHash: string;
  afterHash: string;
  updatedAt: string;
}

export interface GenerationTextVersion {
  revisionId: string;
  revisionNumber: number;
  source: 'original' | GenerationTextRevisionSource;
  text: string;
  createdAt: string;
  beforeHash?: string;
  afterHash: string;
}

export interface GenerationTextEditResult {
  generation: GenerationRecord;
  revisionNumber: number;
  derivationStatus: 'not-applicable' | StoryStateRefreshStatus['status'];
}

export interface GenerateRequestBody {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
  viewpointCharacterId?: string | null;
  // NOTE: 妄想増幅器の小説 advance 専用。指定時はサーバーが保存済みInteractionEvent・
  // 未完了lease・対象generationが現在選択下書きだったことを検証し、今回方向を解決する。
  // 通常の wish だけの既存経路は変更しない（設計書 13.2）。
  amplifierInteractionId?: string;
  amplifierOperationId?: string;
}
