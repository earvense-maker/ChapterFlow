// 妄想増幅器（Delusion Amplifier）ドメイン型
//
// NOTE: 設計書 docs/design/妄想増幅器_設計書.md の正本に従う。このファイルは
// サーバー・クライアント共通で使う。欲望のタグ体系・数値軸は追加しない（設計書 6.1）。
// PreferenceMemo は AI の暫定仮説であり、ユーザーの真実や心理診断ではない。

import type { ProjectId } from './ids.js';

export type ExperienceMode = 'standard' | 'amplifier';

// --- 嗜好理解（設計書 6.2） ---

export type PreferenceScope = 'global' | 'project' | 'current';
export type PreferenceAppliesTo = 'novel' | 'roleplay' | 'mixed';
export type PreferenceConfidence = 'tentative' | 'recurring';

// NOTE: text が中心であり、嗜好タグ配列や数値軸は持たない。confidence は確率ではなく
// 解釈の成熟度（設計書 6.2 制約）。根拠IDは代表的なものを最大20件まで保持する。
export interface PreferenceMemo {
  memoId: string;
  scope: PreferenceScope;
  appliesTo: PreferenceAppliesTo;
  text: string;
  confidence: PreferenceConfidence;
  evidenceEventIds: string[];
  counterEvidenceEventIds: string[];
  revision: number;
  updatedAt: string;
}

// NOTE: ユーザーの訂正は AI メモと別レイヤーに保持する（設計書 6.4）。AI 更新は
// active な Correction を常に読み、その記述を反転しない。
export interface PreferenceCorrection {
  correctionId: string;
  scope: PreferenceScope;
  appliesTo: PreferenceAppliesTo;
  text: string;
  status: 'active' | 'withdrawn';
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// --- アンカー（設計書 8.1） ---

export type AmplifierAnchor =
  | {
      kind: 'novel';
      generationId: string;
      textRevisionNumber: number;
    }
  | {
      kind: 'roleplay';
      sessionId: string;
      messageId: string;
      contentRevision: number;
    };

// --- 選択肢とターン（設計書 5.4 / 8.1） ---

export type AmplifierStrategy = 'exploit' | 'variation' | 'explore';

export interface AmplifierChoice {
  choiceId: string;
  strategy: AmplifierStrategy;
  label: string;
  description: string;
}

export type AmplifierTurnStatus =
  | 'choices_pending'
  | 'ready'
  | 'failed'
  | 'consumed'
  | 'superseded';

export interface AmplifierTurn {
  schemaVersion: 1;
  turnId: string;
  projectId: string;
  contextKey: string;
  anchor: AmplifierAnchor;
  anchorTextHash: string;
  anchorExcerpt: string;
  status: AmplifierTurnStatus;
  choices: AmplifierChoice[];
  supersedesTurnId?: string;
  consumedByEventId?: string;
  errorCode?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// --- 観察イベント（設計書 7.1） ---

export type AmplifierInteractionType =
  | 'choice_selected'
  | 'free_text'
  | 'stay'
  | 'choice_alternatives_requested'
  | 'favorite'
  | 'direction_rejected'
  | 'scene_regenerated'
  | 'content_edited'
  | 'memo_corrected';

export type AmplifierInteractionMode = 'novel' | 'roleplay';

export interface AmplifierInteractionEventBase {
  schemaVersion: 1;
  eventId: string;
  clientEventId: string;
  sequence: number;
  projectId: string;
  contextKey: string;
  mode: AmplifierInteractionMode;
  anchor: AmplifierAnchor;
  turnId?: string;
  excludeFromGlobalLearning: boolean;
  createdAt: string;
}

// NOTE: payload はイベント種別ごとの判別共用体。API 境界で必ず検証し、任意オブジェクトを
// そのまま保存しない（設計書 7.1）。
export type AmplifierInteractionEvent = AmplifierInteractionEventBase &
  (
    | { type: 'choice_selected'; payload: { choiceId: string } }
    | { type: 'free_text'; payload: { text: string } }
    | { type: 'stay'; payload: { command: 'stay' } }
    | { type: 'choice_alternatives_requested'; payload: { previousTurnId: string } }
    | {
        type: 'favorite';
        payload: { scope: 'whole' | 'selection'; anchor: AmplifierAnchor; excerpt?: string };
      }
    | { type: 'direction_rejected'; payload: { turnId: string; reason?: string } }
    | {
        type: 'scene_regenerated';
        payload: { beforeAnchor: AmplifierAnchor; afterAnchor: AmplifierAnchor };
      }
    | {
        type: 'content_edited';
        payload: { anchor: AmplifierAnchor; beforeHash: string; afterHash: string };
      }
    | {
        type: 'memo_corrected';
        payload: { correctionId: string; beforeText: string; afterText: string };
      }
  );

// --- 小説 advance lease（設計書 9.1） ---

export type PendingNovelAdvanceStatus =
  | 'reserved'
  | 'generating'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface PendingNovelAdvance {
  operationId: string;
  interactionEventId: string;
  sourceTurnId: string;
  acceptedGenerationId: string;
  status: PendingNovelAdvanceStatus;
  resultGenerationId?: string;
  errorCode?: string;
  leaseExpiresAt: string;
  revision: number;
  updatedAt: string;
}

// --- 観察ノート（設計書 9.1 / 9.2） ---

export interface AmplifierInterpreterState {
  state: 'idle' | 'pending' | 'failed';
  pendingAt?: string;
  failedAt?: string;
  lastErrorCode?: string;
}

// NOTE: notebook.json には肥大化しない運用状態だけを保持する（設計書 9.1）。
// 生ログは interactions.jsonl が正本で、ここへ埋め込まない。
export interface AmplifierProjectNotebook {
  schemaVersion: 1;
  projectMemos: PreferenceMemo[];
  // NOTE: contextKey ごとの current メモ。ロールプレイの新しい会話枠では空から始める。
  currentMemos: Record<string, PreferenceMemo[]>;
  corrections: PreferenceCorrection[];
  projectBoundary: string;
  learningEnabled: boolean;
  // NOTE: 解釈済みイベント位置。この sequence までが Desire Interpreter へ畳み込まれた。
  foldedThroughSequence: number;
  interpreter: AmplifierInterpreterState;
  pendingAdvance: PendingNovelAdvance | null;
  revision: number;
  updatedAt: string;
}

export interface AmplifierNotebookRevisionRecord {
  revisionId: string;
  scope: PreferenceScope;
  kind: 'memo_update' | 'memo_delete' | 'correction_add' | 'correction_withdraw' | 'reset';
  memoId?: string;
  correctionId?: string;
  beforeText?: string;
  afterText?: string;
  note?: string;
  createdAt: string;
}

// NOTE: グローバル学習状態は app-settings ではなくグローバルノートに保存する
// （設計書 9.2）。データ保存先の移動・バックアップ・復元と一緒に移ることを保証する。
export interface GlobalNotebook {
  schemaVersion: 1;
  globalLearningEnabled: boolean;
  globalLearningResetAt: string | null;
  memos: PreferenceMemo[];
  corrections: PreferenceCorrection[];
  globalBoundary: string;
  foldedThroughSequence: number;
  interpreter: AmplifierInterpreterState;
  revision: number;
  updatedAt: string;
}

// NOTE: global-observations.jsonl の1行。場面全文や自由入力原文は複製せず、作品内解釈から
// 得た自然言語の抽象観察・視点・成熟度・元イベント参照だけを保存する（設計書 9.2）。
export interface AmplifierGlobalObservation {
  schemaVersion: 1;
  observationId: string;
  projectId: string;
  contextKey: string;
  appliesTo: PreferenceAppliesTo;
  text: string;
  confidence: PreferenceConfidence;
  sourceEventId: string;
  createdAt: string;
}

// --- API ボディ ---

// NOTE: クライアントから本文を受け取らない。アンカーと期待改訂だけを受け、サーバーが
// 保存済み本文を読んでハッシュを計算する（設計書 13.1）。
export interface CreateAmplifierTurnBody {
  anchor: AmplifierAnchor;
}

export interface RequestAmplifierTurnAlternativesBody {
  clientEventId: string;
  expectedTurnRevision: number;
}

export interface RecordDirectionRejectionBody {
  clientEventId: string;
  turnId: string;
  expectedTurnRevision: number;
  reason?: string;
}

export type AmplifierDirectionInput =
  | { selectedChoiceId: string }
  | { freeText: string }
  | { command: 'stay' };

// NOTE: AmplifierDirectionInput は判別共用体のため interface extends できない。
// 交差型で拡張する（union の各要素に advance 固有フィールドが足される）。
export type AmplifierNovelAdvanceBody = AmplifierDirectionInput & {
  clientEventId: string;
  turnId: string;
  turnRevision: number;
  anchor: AmplifierAnchor;
};

export type AmplifierRoleplayAdvanceBody = AmplifierDirectionInput & {
  clientEventId: string;
  turnId: string;
  turnRevision: number;
  anchor: AmplifierAnchor;
  sessionRevision: number;
};

export interface AmplifierFavoriteBody {
  clientEventId: string;
  scope: 'whole' | 'selection';
  anchor: AmplifierAnchor;
  excerpt?: string;
}

export interface AmplifierPreferencesUpdateBody {
  addCorrections?: Array<{
    scope: PreferenceScope;
    appliesTo: PreferenceAppliesTo;
    text: string;
  }>;
  withdrawCorrectionIds?: string[];
  deleteMemoIds?: string[];
  projectBoundary?: string | null;
  resetCurrentContextKeys?: string[];
  // NOTE: この作品からグローバルへ学習するか（設計書 14.2）。省略時は変更しない。
  learningEnabled?: boolean;
}

export interface AmplifierSettingsUpdateBody {
  globalLearningEnabled?: boolean;
}

export interface AmplifierGlobalPreferencesUpdateBody {
  addCorrections?: Array<{
    appliesTo: PreferenceAppliesTo;
    text: string;
  }>;
  withdrawCorrectionIds?: string[];
  deleteMemoIds?: string[];
  globalBoundary?: string | null;
}

// --- レスポンス ---

export interface AmplifierStateResponse {
  projectId: ProjectId;
  contextKey: string;
  turn: AmplifierTurn | null;
  notebook: AmplifierProjectNotebook;
}

export interface AmplifierPreferencesResponse {
  notebook: AmplifierProjectNotebook;
}

export interface AmplifierSettingsResponse {
  globalLearningEnabled: boolean;
  globalLearningResetAt: string | null;
}

export interface AmplifierGlobalPreferencesResponse {
  notebook: GlobalNotebook;
}

export interface AmplifierTurnCreateResponse {
  turn: AmplifierTurn;
}

export interface AmplifierStateQuery {
  kind: 'novel' | 'roleplay';
  sessionId?: string;
}

// --- アンカー本文ハッシュ（設計書 8.2） ---
// 実効本文をUTF-8文字列として、改行だけLFへ正規化し、trimや空白圧縮をせずSHA-256で
// 計算する。選択肢 prepare / commit / 押下検証で同じ純関数を使う。
export function normalizeAnchorTextForHash(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
