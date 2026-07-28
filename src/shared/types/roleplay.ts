import type { CharacterId, ProjectId } from './ids.js';
import type { Character } from './character.js';

export type RoleplaySessionId = string;
export type RoleplayMessageRole = 'user' | 'character';
export type RoleplaySessionStatus = 'active' | 'archived';

export interface RoleplayMessage {
  messageId: string;
  role: RoleplayMessageRole;
  content: string;
  createdAt: string;
}

// NOTE: 会話開始時に固定するペルソナ・世界観のスナップショット。プロンプト構築の
// system 部の材料。secrets を含むためAPIレスポンスには含めず、RoleplaySessionView
// で除外する。
export interface RoleplayContextSnapshot {
  character: Character;
  otherCharacters: Array<Pick<Character, 'characterId' | 'name' | 'description'>>;
  worldDigest: string;
  // NOTE: 編集済み基本プロンプト。旧セッションでは選択プリセットも結合して保存されている
  // （現在は stylePresetPrompt に分離）。旧セッションでは未指定のため optional。
  projectSystemPrompt?: string;
  // NOTE: ロールプレイ用作風プリセットのレンダリング結果。見出し込みで保存する。
  stylePresetPrompt?: string;
  // NOTE: 作風設定「応答の形」(rpResponseStyle) の本文。ロールプレイ規則へ直接埋め込む。
  // 未指定の旧セッションは DEFAULT_ROLEPLAY_RESPONSE_STYLE_INSTRUCTION で従来通りに動く。
  responseStyleInstruction?: string;
  customSystemPrompt: string;
  capturedAt: string;
}

export interface RoleplaySession {
  schemaVersion: 1;
  sessionId: RoleplaySessionId;
  projectId: ProjectId;
  characterId: CharacterId;
  scenario?: string;
  contextSnapshot: RoleplayContextSnapshot;
  status: RoleplaySessionStatus;
  messages: RoleplayMessage[];
  conversationSummary?: string;
  // NOTE: 要約カーソル。この messageId までが conversationSummary に畳まれている。
  summaryThroughMessageId?: string;
  // NOTE: 派生データ更新の時刻。会話の updatedAt とは分離し、要約完了で
  // 一覧順やユーザー向け revision を進めない。
  summaryUpdatedAt?: string;
  model: { provider: string; modelName: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

// NOTE: APIレスポンス用。contextSnapshot を除外して secrets を漏らさない。
// characterName はサーバー側で snapshot から取り出して付与する。
export type RoleplaySessionView = Omit<RoleplaySession, 'contextSnapshot'> & {
  characterName: string;
};

export interface RoleplaySessionSummary {
  sessionId: RoleplaySessionId;
  characterId: CharacterId;
  characterName: string;
  scenario?: string;
  status: RoleplaySessionStatus;
  messageCount: number;
  lastExcerpt: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleplaySessionBody {
  characterId: string;
  scenario?: string;
}

export interface SendRoleplayMessageBody {
  message: string;
  revision: number;
  // NOTE: 停止後の訂正送信用。指定時は、現在末尾にある未応答の user 発言と
  // messageId が一致する場合だけ内容を置き換えて応答生成を再開する。
  replacePendingMessageId?: string;
}

export interface RegenerateRoleplayBody {
  revision: number;
}

export interface ArchiveRoleplaySessionBody {
  revision: number;
}

export interface RoleplaySessionResponse {
  session: RoleplaySessionView;
}

export interface RoleplaySessionListResponse {
  sessions: RoleplaySessionSummary[];
}
