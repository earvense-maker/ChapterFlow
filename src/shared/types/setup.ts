import type { ProjectId } from './ids.js';
import type { ActivePresets, ProjectType, WorldContent } from './project.js';
import type { Character, CharacterRole, CharacterTrait } from './character.js';
import type { Memory } from './memory.js';
import type { RoleplayUserPersona } from './roleplay.js';
import type { StoryState } from './storyState.js';

export type SetupSessionId = string;
export type SetupSessionStatus = 'active' | 'committed' | 'abandoned';
export type SetupMessageRole = 'user' | 'assistant';
export type SetupDraftItemStatus = 'active' | 'archived';
export type SetupDraftItemSource = 'user' | 'llm' | 'manual';
// NOTE: 'novel' は連載小説の設定づくり、'roleplay' はロールプレイ会話向けの
// キャラ設定づくり。保存データでは optional、API 境界では 'novel' に正規化。
export type SetupPurpose = 'novel' | 'roleplay';

export interface SetupModelSelection {
  provider: string;
  modelName: string;
}

export interface SetupProjectSettings {
  title?: string;
  outputLength: number;
  streamingEnabled: boolean;
  activePresetIds: Partial<ActivePresets>;
}

export interface SetupMessage {
  messageId: string;
  role: SetupMessageRole;
  content: string;
  createdAt: string;
}

export interface SetupDraftTextItem {
  id: string;
  text: string;
  source: SetupDraftItemSource;
  status: SetupDraftItemStatus;
  locked?: boolean;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetupDraftCandidate {
  id: string;
  title: string;
  summary: string;
  source: SetupDraftItemSource;
  status: SetupDraftItemStatus;
  locked?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SetupDraftUndecided {
  id: string;
  text: string;
  reason?: string;
  source: SetupDraftItemSource;
  status: SetupDraftItemStatus;
  locked?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SetupDraftCharacter {
  id: string;
  role: CharacterRole;
  name: string;
  label: string;
  description: string;
  speechStyle?: string;
  relationshipNotes?: string;
  traits?: CharacterTrait[];
  secrets?: string;
  // NOTE: ロールプレイ用途で相談中に組み立てる開幕メッセージと会話例。
  greeting?: string;
  dialogueExamples?: string[];
  lockedFields?: string[];
  source: SetupDraftItemSource;
  status: SetupDraftItemStatus;
  locked?: boolean;
  createdAt: string;
  updatedAt: string;
}

// NOTE: ロールプレイ相談で決める「あなた（ユーザー）が誰として話すか」。作品化時に
// Project.defaultUserPersona へ昇格する。actionPolicy は相談では扱わず、会話開始時の
// 選択に任せるため持たない（相談で決めるのは人物像だけ）。
export interface SetupDraftUserPersona {
  name?: string;
  relationship?: string;
  preferredAddress?: string;
  knownFacts?: string;
}

export interface SetupDraft {
  coreConcept: string;
  confirmed: SetupDraftTextItem[];
  candidates: SetupDraftCandidate[];
  undecided: SetupDraftUndecided[];
  characters: SetupDraftCharacter[];
  relationshipSeeds: string[];
  world: string[];
  tone: string[];
  ng: string[];
  openingSeeds: string[];
  // NOTE: ロールプレイ用途の会話舞台候補。novel 用途では常に空配列。
  scenarioSeeds: string[];
  // NOTE: ロールプレイ用途のみ。novel 用途では常に undefined。
  userPersona?: SetupDraftUserPersona;
}

export interface SetupLock {
  lockId: string;
  path: string;
  reason: 'user_locked' | 'manual_edit';
  createdAt: string;
}

export interface SetupSessionError {
  code: string;
  message: string;
  retryable: boolean;
  createdAt: string;
}

export interface SetupSession {
  schemaVersion: 1 | 2;
  sessionId: SetupSessionId;
  projectId: ProjectId | null;
  committedProjectId?: ProjectId;
  status: SetupSessionStatus;
  revision: number;
  // NOTE: 相談の用途。undefined は後方互換で 'novel'。サービス境界では必ず normalize する。
  purpose?: SetupPurpose;
  model: SetupModelSelection;
  projectSettings: SetupProjectSettings;
  messages: SetupMessage[];
  draft: SetupDraft;
  locks: SetupLock[];
  lastError: SetupSessionError | null;
  previews?: SetupPreviewRecord[];
  conversationSummary?: string;
  // NOTE: 最後に設定草案へまとめた時点のメッセージ数。「まとめてから会話が進んだか」の
  // 判定だけに使う。時刻ではなく件数なのは、草案の各項目が個別の updatedAt を持ち、
  // 文字列配列の項目には時刻が無いため、草案側からは横断的に比較できないから。
  // 未設定（旧セッション）は0扱いで、初回は必ず促される。
  draftWrittenUpMessageCount?: number;
  commitPlan?: { plan: SetupCommitPlan; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SetupSessionSummary {
  sessionId: SetupSessionId;
  status: SetupSessionStatus;
  revision: number;
  updatedAt: string;
  createdAt: string;
  messageCount: number;
  draftExcerpt: string;
  committedProjectId?: ProjectId;
  // NOTE: サマリーでは undefined を返さず 'novel' に正規化して渡す。
  purpose: SetupPurpose;
}

// NOTE: 'draft' は「今の相談を草案にまとめる」。相談ターンが設定草案を更新しなくなったので、
// 書き起こしを利用者が任意のタイミングで実行するための操作。
export type SetupSuggestedActionIntent = 'preview' | 'commit' | 'draft';

export interface SetupSuggestedAction {
  label: string;
  message: string;
  /** Omit for a normal chat follow-up; set only for a direct workspace action. */
  intent?: SetupSuggestedActionIntent;
}

export interface SetupDraftPatch {
  coreConcept?: string;
  confirmedAdd?: Array<Partial<SetupDraftTextItem> & { text?: string }>;
  candidatesAdd?: Array<Partial<SetupDraftCandidate> & { title?: string; summary?: string }>;
  undecidedAdd?: Array<Partial<SetupDraftUndecided> & { text?: string; reason?: string }>;
  charactersAdd?: Array<Partial<SetupDraftCharacter>>;
  charactersUpdate?: Array<Partial<SetupDraftCharacter> & { id: string }>;
  relationshipSeedsAdd?: string[];
  worldAdd?: string[];
  toneAdd?: string[];
  ngAdd?: string[];
  openingSeedsAdd?: string[];
  // NOTE: ロールプレイ用途。会話の舞台候補を追加する。
  scenarioSeedsAdd?: string[];
  // NOTE: ロールプレイ用途。ユーザー側の立ち位置は1件だけなので add ではなく差分更新。
  // 指定したフィールドだけ上書きし、空文字を渡したフィールドは消す。
  userPersonaUpdate?: SetupDraftUserPersona;
  archiveIds?: string[];
}

// NOTE: 旧 setup セッション/LLM 応答の互換入力。正規化後の draft には旧キーを残さない。
export type LegacySetupDraftCharacterInput = Partial<SetupDraftCharacter> & {
  want?: unknown;
  fear?: unknown;
  secret?: unknown;
};

export type LegacySetupDraftPatchInput = Omit<
  SetupDraftPatch,
  'charactersAdd' | 'charactersUpdate'
> & {
  charactersAdd?: LegacySetupDraftCharacterInput[];
  charactersUpdate?: Array<LegacySetupDraftCharacterInput & { id: string }>;
};

export interface CreateSetupSessionBody {
  initialMessage?: string;
  projectSettings?: Partial<SetupProjectSettings>;
  model?: Partial<SetupModelSelection>;
  // NOTE: 用途。省略時は 'novel' として扱う。'novel' / 'roleplay' 以外は 400。
  purpose?: SetupPurpose;
}

export interface SendSetupMessageBody {
  message: string;
  revision: number;
}

export interface RetrySetupMessageBody {
  revision?: number;
}

export interface UpdateSetupDraftBody {
  draft: SetupDraft;
  revision: number;
  manualEditPaths?: string[];
}

export interface SetLockStateBody {
  path: string;
  locked: boolean;
  revision: number;
}

export interface SetupLockStateResponse {
  session: SetupSession;
  revision: number;
}

export interface PatchSetupSettingsBody {
  model?: {
    provider: string;
    modelName?: string;
  };
  activePresetIds?: ActivePresets;
  revision: number;
}

export interface PatchSetupSettingsResponse {
  session: SetupSession;
  revision: number;
}

// NOTE: 次の一歩の選択肢はモデルに毎ターン考えさせず、クライアント側の固定ボタンに
// した。相談の返答が平文だけになったので、選択肢を運ぶ経路自体が無くなっている。
export interface SetupSessionResponse {
  sessionId: SetupSessionId;
  session: SetupSession;
  assistantMessage?: SetupMessage;
}

export interface SetupMessageResponse {
  session: SetupSession;
  assistantMessage?: SetupMessage;
  draft: SetupDraft;
  revision: number;
}

export interface SetupDraftResponse {
  session: SetupSession;
  draft: SetupDraft;
  revision: number;
}

export interface SetupPreviewRecord {
  previewId: string;
  text: string;
  createdAt: string;
}

export interface SetupPreviewResponse {
  previewText: string;
  session: SetupSession;
  revision: number;
}

export interface SetupCommitPlan {
  project: {
    title: string;
    outputLength: number;
    activePresetIds: Partial<ActivePresets>;
    // NOTE: roleplay 用途では 'roleplay' を必ず設定。novel 用途/後方互換は 'novel'。
    projectType?: ProjectType;
  };
  coreConcept?: string;
  // NOTE: roleplay 用途では常に未設定。novel 用途のみ表示・保存する。
  firstWishSuggestion?: string;
  styleSample?: string;
  world: WorldContent;
  characters: Character[];
  memories: Memory[];
  storyState: StoryState;
  customSystemPrompt: string;
  // NOTE: ロールプレイ用途の会話舞台候補。novel 用途では常に空配列。
  scenarioSeeds?: string[];
  // NOTE: ロールプレイ用途の「あなた」の既定像。novel 用途では常に未設定。
  defaultUserPersona?: RoleplayUserPersona;
}

export interface SetupCommitPlanResponse {
  plan: SetupCommitPlan;
  session: SetupSession;
  revision: number;
}

export interface CommitSetupBody {
  plan: SetupCommitPlan;
  revision: number;
}

export interface SetupCommitResponse {
  projectId: ProjectId;
  session: SetupSession;
}
