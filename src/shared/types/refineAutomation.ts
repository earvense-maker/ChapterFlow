import type { GenerationId } from './ids.js';
import type { WorldContent } from './project.js';
import type { Character } from './character.js';

export type RefineAutomationMode = 'off' | 'suggest' | 'safe' | 'all';
export type RefineAutomationScanPolicy = 'when-needed' | 'always';

export interface RefineAutomationSettings {
  mode: RefineAutomationMode;
  scanPolicy: RefineAutomationScanPolicy;
}

export type RefineMaintenancePhase =
  | 'scanning'
  | 'awaitingAcceptance'
  | 'applying'
  | 'reverting'
  | 'complete'
  | 'needsReview'
  | 'stale'
  | 'failed';

export interface RefineMaintenanceStatus {
  runId: string;
  generationId: GenerationId;
  phase: RefineMaintenancePhase;
  startedAt: string;
  updatedAt: string;
  leaseExpiresAt: string;
  appliedPatchIds: string[];
  pendingPatchIds: string[];
  reviewPatchIds: string[];
  postAcceptanceContinuation?: {
    generationId: GenerationId;
    action: 'story-state-refresh';
    owner: 'maintenance';
    requestedAt: string;
  };
  errorMessage?: string;
}

export const AUTOMATION_SCHEMA_VERSION = 1;

export interface RefineAutomationRun {
  schemaVersion: 1;
  runId: string;
  generationId: GenerationId;
  status: RefineMaintenancePhase;
  mode: RefineAutomationMode;
  usedModel: { provider: string; modelName: string };
  createdAt: string;
  completedAt?: string;
  sourceStaticHash: string;
  sourceStoryStateUpdatedAt?: string | null;
  sourceAcceptedGenerationCount: number;
  patchIds: string[];
  appliedPatchIds: string[];
  pendingPatchIds: string[];
  reviewPatchIds: string[];
  highRiskAppliedPatchIds: string[];
  acknowledgement?: 'pending' | 'acknowledged' | 'reverted';
  revertedAt?: string;
  revertError?: string;
  // NOTE: 走査モデル呼び出しや保存に失敗した場合の監査用メッセージ。状態の正本は
  // ProjectState.refineMaintenance だが、過去 run の履歴表示にも残す。
  errorMessage?: string;
  beforeSnapshot?: { worldText: string; characters: Character[] };
  resultStaticHash?: string;
}

export interface RefineAutomationStore {
  schemaVersion: 1;
  runs: RefineAutomationRun[]; // newest-first
  // NOTE: ロールバック自体が失敗した場合の「ハードストップ」フラグ。設定されている間、
  // explicitConfirmation なしでは runRefineAutomationPipeline が新規runを拒否する。
  confirmationRequired?: { reason: string; sinceRunId: string; setAt: string };
}

export interface RefineAutomationSettingsResponse {
  settings: RefineAutomationSettings | null; // null = 未保存（off として扱う）
  status: RefineMaintenanceStatus | null;
}

export interface UpdateRefineAutomationSettingsBody {
  mode: RefineAutomationMode;
  scanPolicy: RefineAutomationScanPolicy;
}

export interface RevertRefineAutomationRunResponse {
  run: RefineAutomationRun;
  world: WorldContent;
  characters: Character[];
}

// ===== ロールプレイモード =====
//
// 会話ランタイム。相談モードで作った roleplay 型プロジェクトを開くと、この
// セッション単位で会話が保存される。設計書 3.1 のデータ整合性方針:
//  - 保存済みセッションが正、ストリーミング中の暫定表示はコミット点に達するまで
//    未保存として扱う。
//  - 全変更操作は sessionId 単位の in-memory mutex + revision 検査を通す。
//  - contextSnapshot は作成時のペルソナ・世界観をスナップショットし、後日の
//    キャラ編集で既存会話が変質しないようにする。
