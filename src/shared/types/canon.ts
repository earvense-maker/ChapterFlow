import type { CharacterId, GenerationId, ProjectId, SceneId } from './ids.js';
import type { RoleplaySessionId } from './roleplay.js';

// ============================================================
// 創作契約 (Creative Contract)
// ============================================================

export type CreativeContractKind = 'promise' | 'prohibition' | 'preference';
export type CreativeContractStrength = 'hard' | 'soft';
export type CreativeContractSource = 'user' | 'manual' | 'ai-suggested';
export type CreativeContractItemStatus = 'active' | 'disabled';
export type CreativeContractVerificationMode = 'strict' | 'fast';

export interface CreativeContractItem {
  contractId: string;
  kind: CreativeContractKind;
  strength: CreativeContractStrength;
  text: string;
  source: CreativeContractSource;
  status: CreativeContractItemStatus;
  createdAt: string;
  updatedAt: string;
}

// NOTE: 過去の採用済み generation にだけ作用する例外（設計書 5.2）。
// 契約を無効化せず、該当 generation 由来の正史との説明済み衝突を記録する。
export interface ContractException {
  exceptionId: string;
  contractId: string;
  generationId: GenerationId;
  evidenceExcerpt: string;
  reason?: string;
  createdAt: string;
}

export interface CreativeContract {
  schemaVersion: 1;
  projectId: ProjectId;
  revision: number;
  items: CreativeContractItem[];
  exceptions: ContractException[];
  verificationMode: CreativeContractVerificationMode;
  updatedAt: string;
}

// NOTE: 初回PUTは409+conflictFingerprint、同一revisionと確認fingerprint付き再PUTで保存（設計書 5.2）。
export interface CreativeContractConflictCandidate {
  contractIds: string[];
  reason: string;
}

export interface CreativeContractPutBody {
  revision: number;
  items: CreativeContractItemInput[];
  verificationMode?: CreativeContractVerificationMode;
  confirmConflictFingerprint?: string;
}

export type CreativeContractItemInput = Omit<CreativeContractItem, 'createdAt' | 'updatedAt'>;

// ============================================================
// 潜在設定 (Latent Canon)
// ============================================================

export type CanonLifecycle = 'provisional' | 'foreshadowed' | 'revealed' | 'retired';
export type CanonEpistemicStatus = 'fact' | 'claim' | 'belief' | 'rumor' | 'unknown';
export type CanonScope = 'world' | 'character' | 'relationship' | 'history' | 'plot' | 'other';
export type CanonEvidenceKind =
  | 'generation'
  | 'roleplay-message'
  | 'roleplay-promotion'
  | 'manual';
export type CanonSource = 'setup' | 'on-demand' | 'generation' | 'roleplay' | 'manual';
export type CanonRetiredReason =
  | 'unused'
  | 'contradicted'
  | 'replaced'
  | 'evidence-removed'
  | 'manual';

export interface CanonEvidence {
  kind: CanonEvidenceKind;
  disclosure: 'foreshadowed' | 'revealed';
  generationId?: GenerationId;
  sceneId?: SceneId;
  sessionId?: RoleplaySessionId;
  messageId?: string;
  excerpt?: string;
  createdAt: string;
}

export interface LatentCanonItem {
  canonId: string;
  scope: CanonScope;
  subjectCharacterIds?: CharacterId[];
  statement: string;
  status: CanonLifecycle;
  // NOTE: evidenceをすべて失ったときの復元先（設計書 5.3）。
  // setup/on-demand由来は provisional、採用本文・roleplayから新規抽出は retired。
  baseStatusWithoutEvidence: Exclude<CanonLifecycle, 'foreshadowed' | 'revealed'>;
  // NOTE: 手動退役・競合退役を取り消すときだけ使う。evidence喪失時の復元先には使わない。
  statusBeforeRetired?: Exclude<CanonLifecycle, 'retired'>;
  epistemicStatus: CanonEpistemicStatus;
  knownBy?: CharacterId[];
  explicitlyUnknownBy?: CharacterId[];
  source: CanonSource;
  manualLock: boolean;
  evidence: CanonEvidence[];
  supersedesCanonId?: string;
  retiredReason?: CanonRetiredReason;
  // NOTE: 採用本文との矛盾で自動退役させたgeneration。採用取消時に元状態へ戻すために
  // 記録する（設計書 6.4）。手動退役では使わない。
  retiredByGenerationId?: GenerationId;
  // NOTE: ロールプレイのsession canonが作品へ昇格済みか。作品側の項目には付けない。
  promotedToProjectAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type CanonConflictKind = 'revealed-canon' | 'hard-contract';
export type CanonConflictStatus = 'pending' | 'resolved' | 'exception-accepted' | 'dismissed';

export interface CanonConflict {
  conflictId: string;
  generationId: GenerationId;
  canonId?: string;
  contractId?: string;
  kind: CanonConflictKind;
  summary: string;
  evidenceExcerpt: string;
  status: CanonConflictStatus;
  createdAt: string;
  resolvedAt?: string;
}

export interface CanonPatchBody {
  revision: number;
  statement?: string;
  scope?: CanonScope;
  epistemicStatus?: CanonEpistemicStatus;
  knownBy?: CharacterId[];
  explicitlyUnknownBy?: CharacterId[];
}

// NOTE: 作品設定画面向けのshielded summary DTO（設計書 7.2）。shielded時は未公開本文を
// 含まない。visible時のみ items に未公開本文が入る。
export interface CanonSummaryResponse {
  revision: number;
  spoilerMode: 'shielded' | 'visible';
  latentSeedStatus: 'ok' | 'failed';
  revealed: Array<{
    canonId: string;
    scope: CanonScope;
    statement: string;
    epistemicStatus: CanonEpistemicStatus;
    updatedAt: string;
  }>;
  pendingConflicts: Array<{
    conflictId: string;
    kind: CanonConflictKind;
    summary: string;
    evidenceExcerpt: string;
    status: CanonConflictStatus;
    generationId: GenerationId;
    canonId?: string;
    contractId?: string;
    createdAt: string;
    resolvedAt?: string;
  }>;
  hidden: {
    total: number;
    byScope: Record<CanonScope, number>;
  };
  // NOTE: 退役項目は作者の管理対象（取り消し可能・レビュー指摘 P2）。本文は含めず
  // opaqueなID・scope・退役理由だけを返す。
  retired: {
    total: number;
    byScope: Record<CanonScope, number>;
    items: Array<{
      canonId: string;
      scope: CanonScope;
      retiredReason: string;
      updatedAt: string;
    }>;
  };
  items?: LatentCanonItem[];
}

export interface LatentCanonStore {
  schemaVersion: 1;
  projectId: ProjectId;
  revision: number;
  items: LatentCanonItem[];
  // NOTE: StoryStateの同名集合と独立に持ち、canon patchの二重適用を防ぐ（設計書 5.3）。
  processedGenerationIds: GenerationId[];
  pendingConflicts: CanonConflict[];
  // NOTE: クイックセットアップの初期補完結果。欠損は 'ok' と解釈する（設計書 4.1）。
  latentSeedStatus?: 'ok' | 'failed';
  updatedAt: string;
}

// ============================================================
// 採用本文の観測抽出 (NarrativeObservation)
// ============================================================

// NOTE: LLMはこの観測配列だけを正本として返す（設計書 6.3）。
// StoryState patch と canon patch は正規化済み観測からserver側で派生させる。
export interface NarrativeObservationConflict {
  kind: CanonConflictKind;
  targetCanonId?: string;
  targetContractId?: string;
  summary: string;
}

export interface NarrativeObservation {
  observationId: string;
  kind: 'situation' | 'character-state' | 'event' | 'thread' | 'canon';
  operation: 'add' | 'update' | 'resolve';
  // NOTE: 既存 eventId / threadId / characterId / canonId。空文字は新規。
  targetId?: string;
  text: string;
  // NOTE: canon観測の分類先（設計書 5.3 のCanonScope）。canon以外の観測では不要。
  scope?: CanonScope;
  epistemicStatus: CanonEpistemicStatus;
  disclosure: 'foreshadowed' | 'revealed';
  subjectCharacterIds?: CharacterId[];
  actorCharacterId?: CharacterId;
  recipientCharacterId?: CharacterId;
  knownBy?: CharacterId[];
  explicitlyUnknownBy?: CharacterId[];
  evidenceExcerpt: string;
  // NOTE: この観測が既存のrevealed canon / hard契約と意味的に矛盾する場合。
  // 付いた観測はcanon patch適用の対象にせず、pendingConflictsへ送る。
  conflict?: NarrativeObservationConflict;
  // NOTE: このcanon観測が既存の潜在設定（provisional/foreshadowed）を退役させる場合。
  retireTargetCanonId?: string;
  // NOTE: StoryState patch派生用の拡張フィールド（設計書 5.3 の型に追加したoptional項目）。
  characters?: string[];
  presentCharacters?: CharacterId[];
  learnedBy?: CharacterId[];
  addUnknownBy?: CharacterId[];
  removeUnknownBy?: CharacterId[];
  knowledge?: string[];
  removeKnowledge?: string[];
  relationships?: string[];
  relatedCharacterIds?: CharacterId[];
  importance?: 'high' | 'medium' | 'low';
  clock?: { day: number; timeOfDay?: string; note?: string };
  archiveEventIds?: string[];
  archiveThreadIds?: string[];
}

// NOTE: canon patchの中間表現。server内部でのみ使う。
export interface CanonPatchEntry {
  operation: 'upsert' | 'retire' | 'resolve';
  canonId?: string;
  scope: CanonScope;
  subjectCharacterIds?: CharacterId[];
  statement: string;
  epistemicStatus: CanonEpistemicStatus;
  disclosure: 'foreshadowed' | 'revealed';
  knownBy?: CharacterId[];
  explicitlyUnknownBy?: CharacterId[];
  evidenceExcerpt: string;
  retiredReason?: CanonRetiredReason;
}

export interface AcceptedNarrativeDerivation {
  generationId: GenerationId;
  /** 抽出元の実効本文 revision。欠損は旧データの 0 と解釈する。 */
  sourceTextRevisionNumber?: number;
  extractedAt: string;
  observations: NarrativeObservation[];
  // NOTE: 正規化済みobservationsからserverが作る再試行用cache。LLM出力ではない（設計書 5.3）。
  storyStatePatch: unknown;
  canonPatch: CanonPatchEntry[];
  status: 'extracted' | 'partially-applied' | 'applied' | 'stale';
  storyStateAppliedAt?: string;
  canonAppliedAt?: string;
  lastError?: string;
}

// ============================================================
// 生成レコードの契約検証状態 (設計書 5.6)
// ============================================================

export interface GenerationContractValidation {
  status: 'passed' | 'repaired' | 'review-required' | 'skipped';
  checkedContractIds: string[];
  failedContractIds: string[];
  uncertainContractIds: string[];
  verifierCalls: number;
  repairCalls: number;
  completedAt: string;
}
