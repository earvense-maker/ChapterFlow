import type { CharacterId, GenerationId, ProjectId, SceneId } from './ids.js';
import type { Character, CharacterRole, CharacterTrait } from './character.js';

// NOTE: 作品設定レビュー（refine scan）— 既存作品の設定 (world/characters/
// systemPrompt/storyState) を AI が横断的に読み、矛盾/未定義/提案を返す。
// Phase 2 では明示ボタンでのみ走らせる（トークン節約）。結果は refineScan.json
// にキャッシュし、以降は cache 表示。
export type RefineFindingKind = 'contradiction' | 'undefined' | 'suggestion';

export type RefineFindingTarget =
  | { kind: 'world' }
  | { kind: 'systemPrompt' }
  | { kind: 'character'; characterId: string; characterName: string }
  | { kind: 'storyState' }
  | { kind: 'other'; label: string };

export interface RefineFindingEvidence {
  generationId: GenerationId;
  sceneId: SceneId;
  quote: string;
}

// NOTE: finding の「話題」。scan のたびに id と自然文 message は変わるので、
// ユーザーの判断（意図的な空白など）を scan をまたいで引き継ぐための安定キー
// (fingerprint) の材料にする。モデルには限られた語彙だけを選ばせ、未知の値は
// 'other' へ正規化する。
export type RefineFindingTopic =
  | 'motivation'
  | 'past'
  | 'goal'
  | 'relationship'
  | 'secret'
  | 'speech'
  | 'world-rule'
  | 'timeline'
  | 'state'
  | 'other';

export interface RefineFinding {
  id: string;
  kind: RefineFindingKind;
  target: RefineFindingTarget;
  message: string;
  detail?: string;
  // NOTE: Phase 3 でチャット雛形の初期値として使う。Phase 2 では表示のみ。
  suggestedFix?: string;
  evidence?: RefineFindingEvidence[];
  topic?: RefineFindingTopic;
  // NOTE: サーバーが kind + target の安定識別子 + topic から計算する。AI には
  // 作らせない。target.kind === 'other' は安定識別子を持たないため、
  // fingerprint は計算するが永続 disposition の対象にはしない
  // (refineFindingFingerprint.supportsPersistentDisposition を参照)。
  fingerprint?: string;
}

export interface RefineScanResult {
  schemaVersion: 1;
  generatedAt: string;
  usedModel: { provider: string; modelName: string };
  // NOTE: 「作品の芯」= AI が world+characters+systemPrompt から抽出した
  // 1〜2 行の要旨。scan のたびに更新され、サマリーカードで最上部に表示。
  coreConcept: string;
  findings: RefineFinding[];
  // NOTE: パース失敗や部分成功時のユーザー向けメッセージ。null なら正常。
  lastError: string | null;
  // NOTE: 最後に成功した走査が確認した状態。キャッシュ鮮度判定だけに使い、
  // 作品のドメインデータではない。undefined は L5 導入前のキャッシュ。
  reviewedStoryStateDiffId?: string | null;
  reviewedStoryStateUpdatedAt?: string | null;
  reviewedStaticInputHash?: string | null;
}

export type RefineReviewReason =
  | 'story_progressed'
  | 'history_truncated'
  | 'settings_changed'
  | 'story_state_edited';

export interface RefineReviewStatus {
  backlogCountLowerBound: number;
  needsReview: boolean;
  threshold: number;
  reasons: RefineReviewReason[];
}

// NOTE: Phase 3 の作品設定チャット。setup と違い「既存の world / characters
// への差分パッチ」を扱う。system prompt はチャット対象に含めない（サイレント
// デタッチ回避のため、明示的にインライン編集で書く方針）。
export type RefineMessageRole = 'user' | 'assistant' | 'system';

// NOTE: パッチ生成可否の一次境界。クライアントが「どの導線から送ったか」を宣言する。
// - auto: 自由入力欄からの送信のみ。モデルが direct-edit と判定したときだけパッチを許す。
// - consult: 相談開始ボタン・候補ボタン・調整相談。パッチを作らせない。
// - prepare-patch: ユーザーが変更候補作成を明示的に選んだ状態。
// モデルが返す turnIntent は二次境界にすぎず、これ単独でパッチは通らない。
export type RefineResponseMode = 'auto' | 'consult' | 'prepare-patch';

// NOTE: モデルが自己申告するターンの性格。会話表示と監査、および auto モードでの
// パッチ可否判定に使う。
export type RefineTurnIntent = 'explore' | 'clarify' | 'direct-edit' | 'prepare-patch';

// NOTE: assistant 応答に添える「次の相談候補」ボタン。message を次の user 発話として
// 送る。responseMode は consult / prepare-patch のみ許可し、欠落・未知値は consult へ
// 正規化する（候補ボタン経由で auto を送れると 4.5 の一次境界が崩れるため）。
export interface RefineSuggestedAction {
  label: string;
  message: string;
  responseMode?: Exclude<RefineResponseMode, 'auto'>;
}

export type RefineConsultationNoteKind =
  | 'confirmed'
  | 'candidate'
  | 'undecided'
  | 'preference-hypothesis';

export interface RefineConsultationNote {
  noteId: string;
  kind: RefineConsultationNoteKind;
  text: string;
  sourceMessageId: string;
  createdAt: string;
  status: 'active' | 'archived';
}

export type RefineFindingDispositionStatus = 'deferred' | 'intentional-gap' | 'resolved';

export interface RefineFindingDisposition {
  fingerprint: string;
  status: RefineFindingDispositionStatus;
  note?: string;
  updatedAt: string;
  // NOTE: resolved は「この設定内容を確認した結果、対応済み」という判断なので、
  // 設定が変われば再評価する。判断時点の scan の reviewedStaticInputHash を持ち、
  // 一致する間だけ未処理件数から外す。
  staticInputHash?: string | null;
  // NOTE: deferred（今は保留）は当該 scan の間だけ有効。fingerprint 自体は scan を
  // またいで安定するので、これが無いと「次回 scan で再表示」が実現できない。
  scanGeneratedAt?: string | null;
}

export interface RefineConsultationState {
  notes: RefineConsultationNote[];
  conversationSummary?: string;
  findingDispositions: RefineFindingDisposition[];
}

export type RefineConsultationTarget =
  | { kind: 'world'; section?: 'foundation' | 'initialSituation' }
  | { kind: 'character'; characterId: CharacterId; field?: string }
  | { kind: 'finding'; findingId: string; fingerprint: string }
  | { kind: 'patch'; patchId: string }
  | { kind: 'general' };

export interface RefineMessage {
  messageId: string;
  role: RefineMessageRole;
  content: string;
  createdAt: string;
  // NOTE: assistant メッセージがパッチを提案した場合、この配列にパッチ ID を
  // 記録。UI 側で対応するパッチカードを描画する。
  patchIds?: string[];
  // NOTE: 自動レビュー run が合成したシステムメッセージにのみ設定。通知クリック時に
  // 該当run/messageへスクロールするための参照。
  automationRunId?: string;
  // NOTE: レスポンスではなく message 側に保存する。再読み込み後も候補を描画できる
  // ようにするため。ただし押せるのは「session 内で最後のメッセージ」の候補だけで、
  // その判定は messages の並びだけから再現する（RefineChatResponse には持たせない）。
  suggestedActions?: RefineSuggestedAction[];
  target?: RefineConsultationTarget;
  turnIntent?: RefineTurnIntent;
  responseMode?: RefineResponseMode;
}

// NOTE: world.md への「アンカー置換」オペレーション。anchor は world 本文中に
// ちょうど 1 回だけ現れる文字列でなければならない（apply 時に検証）。0 回や
// 複数回マッチした場合はエラーで返し、モデルの全文書き換えを許容しない。
export interface WorldReplaceOp {
  anchor: string;
  replacement: string;
}

// NOTE: world 全文の書き換えは危険なので、原則アンカー置換のみサポート。
// 例外として「まだ world が空」なケースだけ append 用に prepend として使う。
export interface WorldAppendOp {
  text: string;
}

export interface CharacterFieldPatch {
  name?: string;
  role?: CharacterRole;
  description?: string;
  speechStyle?: string;
  relationshipNotes?: string;
  secrets?: string;
  traits?: CharacterTrait[];
  // NOTE: Character.currentState と同じく、物語/会話の開始時点の状態。
  currentState?: string;
}

export type RefinePatchOperation =
  | { kind: 'world-replace'; op: WorldReplaceOp }
  | { kind: 'world-append'; op: WorldAppendOp }
  | { kind: 'character-update'; characterId: CharacterId; fields: CharacterFieldPatch }
  | { kind: 'character-add'; character: Character }
  | { kind: 'character-remove'; characterId: CharacterId };

export type RefinePatchStatus = 'pending' | 'applied' | 'rejected' | 'stale';

// NOTE: 自動レビュー機能の監査メタデータ。すべて optional — 既存パッチには存在しない。
// 欠損時は origin='manual-chat' / riskLevel='review' として扱う
// (refineRiskPolicy.effectivePatchOrigin / effectivePatchRiskLevel を参照)。
export type RefineRiskLevel = 'safe' | 'review';
export type RefineEvidenceScope = 'static' | 'accepted' | 'draft' | 'mixed';
export type RefinePatchOrigin = 'manual-chat' | 'manual-scan' | 'auto-scan';

export interface RefinePatch {
  patchId: string;
  createdAt: string;
  // NOTE: どの assistant メッセージから生まれたかを追跡（UI で結び付け表示）。
  sourceMessageId: string;
  summary: string;
  operations: RefinePatchOperation[];
  status: RefinePatchStatus;
  // NOTE: apply 失敗時の理由（アンカー未一致など）。ユーザーに表示する。
  applyError?: string;
  appliedAt?: string;
  origin?: RefinePatchOrigin;
  automationRunId?: string;
  sourceGenerationId?: GenerationId;
  riskLevel?: RefineRiskLevel;
  riskReasons?: string[];
  evidenceScope?: RefineEvidenceScope;
  // NOTE: 自動レビューが safe 判定に使った引用文の原文。retry や 監査UI から
  // 再照合するためにサーバーが保存する（本文自体は sourceGenerationId から解決するので
  // ここでは quote 文字列だけを持つ）。
  evidenceQuote?: string;
  // NOTE: 自動走査では、モデルが自由文で根拠を指し示すのではなく、サーバーが
  // 入力時に発行した sourceRef を保存する。safe 判定はこの参照で解決した本文だけを
  // 対象にするため、後から監査・再検証しても同じ根拠へ戻れる。
  evidenceSourceRef?: string;
  sourceStaticHash?: string;
  sourceStoryStateUpdatedAt?: string | null;
}

export interface RefineSession {
  schemaVersion: 1 | 2 | 3;
  sessionId: string;
  projectId: ProjectId;
  usedModel: { provider: string; modelName: string };
  messages: RefineMessage[];
  patches: RefinePatch[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  // NOTE: schema 3 で追加。schema 1/2 の既存ファイルには存在しないので、読み込み時に
  // 空の notes / dispositions で補完する。
  consultationState?: RefineConsultationState;
}

export interface RefineChatRequest {
  content: string;
  responseMode?: RefineResponseMode;
  target?: RefineConsultationTarget;
}

export interface RefineChatResponse {
  session: RefineSession;
  assistantMessage: RefineMessage;
  newPatches: RefinePatch[];
}

export interface RefineFindingDispositionResponse {
  session: RefineSession;
  disposition: RefineFindingDisposition;
}

export interface RefineApplyResponse {
  session: RefineSession;
  patch: RefinePatch;
}

// ===== 自動設定レビュー（生成後の自動走査・自動適用の監査基盤） =====
//
// NOTE: 本フェーズ (Phase A+B) では、下記の型・保存・ガード・UI は実装するが、
// 生成完了後に実際に走査を自動起動する配線（Phase C）は含めない。そのため
// RefineMaintenanceStatus / RefineAutomationRun は本フェーズの間、テストが
// 直接構築する場合を除き実データが生成されない。
