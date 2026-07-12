// サーバー・クライアント共通のドメイン型

export type ProjectId = string;
export type EpisodeId = string;
export type SceneId = string;
export type GenerationId = string;
export type MemoryId = string;
export type CharacterId = string;
export type KnowledgeId = string;

export const KNOWLEDGE_WARN_CHARS = 16_000;

export interface ActivePresets {
  genre: string;
  style: string;
  pov: string;
  distance?: string;
  pacing: string;
  density: string;
  conversation?: string;
  relationshipPacing?: string;
  constraint?: string;
}

export interface SamplingConfig {
  frequencyPenalty: number;
  presencePenalty: number;
  // NOTE: 未指定なら生成サービス側の TEMPERATURE_DEFAULT (0.7) を使う。variate モードは
  // ここで指定した値に +0.15 を上乗せ（上限 1.5）する。
  temperature?: number;
}

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

export type CharacterRole = 'protagonist' | 'deuteragonist' | 'supporting' | 'other';

export interface Character {
  characterId: CharacterId;
  name: string;
  aliases?: string[];
  role: CharacterRole;
  description: string;
  speechStyle?: string;
  relationshipNotes?: string;
  secrets?: string;
  want?: string;
  fear?: string;
  currentState?: string;
}

export type MemoryType = 'storyFact' | 'preference' | 'negative';
export type MemoryImportance = 'high' | 'medium' | 'low';
export type MemoryStatus = 'active' | 'archived' | 'rejected';
export type MemorySource = 'manual' | 'generatedCandidate' | 'textSelection';
export type StoryItemStatus = 'active' | 'resolved' | 'archived';

export interface Memory {
  memoryId: MemoryId;
  type: MemoryType;
  content: string;
  importance: MemoryImportance;
  relatedCharacters: CharacterId[];
  relatedEpisodes: EpisodeId[];
  createdAt: string;
  updatedAt: string;
  sourceSceneId: SceneId | null;
  status: MemoryStatus;
  source: MemorySource;
}

export type KnowledgeExtension = 'md' | 'txt';
export type KnowledgeContentStatus = 'ok' | 'missing' | 'empty';

export interface KnowledgeFile {
  knowledgeId: KnowledgeId;
  title: string;
  originalFileName: string;
  extension: KnowledgeExtension;
  enabled: boolean;
  order: number;
  charCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeIndexFile {
  schemaVersion: 1;
  files: KnowledgeFile[];
}

export type KnowledgeListItem = KnowledgeFile & {
  contentStatus: KnowledgeContentStatus;
};

export interface CreateKnowledgeBody {
  fileName: string;
  content: string;
}

export interface UpdateKnowledgeBody {
  title?: string;
  content?: string;
  enabled?: boolean;
  order?: number;
}

export interface KnowledgeContentResponse {
  meta: KnowledgeFile;
  content: string;
}

export type NgExpressionSource = 'manual' | 'report' | 'selection';
export type NgExpressionStatus = 'active' | 'archived';

export interface NgExpression {
  id: string;
  text: string;
  source: NgExpressionSource;
  status: NgExpressionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExpressionsFile {
  schemaVersion: 1;
  ngExpressions: NgExpression[];
}

export interface NgExpressionsResponse {
  ngExpressions: NgExpression[];
}

export interface StoryCharacterState {
  characterId: CharacterId | null;
  name: string;
  currentState: string;
  knowledge: string[];
  relationships: string[];
  updatedAt: string;
}

export interface StoryEventRecord {
  eventId: string;
  sceneId: SceneId | null;
  summary: string;
  characters: string[];
  visibility: string;
  knownBy?: CharacterId[];
  explicitlyUnknownBy?: CharacterId[];
  importance: MemoryImportance;
  status: StoryItemStatus;
  updatedAt: string;
}

export interface StoryThreadRecord {
  threadId: string;
  summary: string;
  relatedCharacters: string[];
  importance: MemoryImportance;
  status: StoryItemStatus;
  updatedAt: string;
}

export interface StoryAuthorUndecidedRecord {
  id: string;
  text: string;
  reason?: string;
  status: StoryItemStatus;
  updatedAt: string;
}

export interface StoryClock {
  day: number;
  timeOfDay?: string;
  note?: string;
}

export interface StoryState {
  schemaVersion: 1;
  currentSituation: string[];
  characterStates: StoryCharacterState[];
  importantEvents: StoryEventRecord[];
  openThreads: StoryThreadRecord[];
  authorUndecided?: StoryAuthorUndecidedRecord[];
  clock?: StoryClock;
  processedGenerationIds?: GenerationId[];
  updatedAt: string;
}

export interface StoryStateDiffSummary {
  addedEvents: string[];
  updatedEvents: string[];
  addedThreads: string[];
  resolvedThreads: string[];
  updatedCharacters: string[];
  clockChanged: boolean;
}

export interface StoryStateDiffRecord {
  diffId: string;
  generationId: GenerationId;
  sceneId: SceneId;
  appliedAt: string;
  summary: StoryStateDiffSummary;
  beforeState?: StoryState;
  resultUpdatedAt: string;
  reverted: boolean;
}

export type SetupSessionId = string;
export type SetupSessionStatus = 'active' | 'committed' | 'abandoned';
export type SetupMessageRole = 'user' | 'assistant';
export type SetupDraftItemStatus = 'active' | 'archived';
export type SetupDraftItemSource = 'user' | 'llm' | 'manual';

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
  want?: string;
  fear?: string;
  secret?: string;
  lockedFields?: string[];
  source: SetupDraftItemSource;
  status: SetupDraftItemStatus;
  locked?: boolean;
  createdAt: string;
  updatedAt: string;
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
  schemaVersion: 1;
  sessionId: SetupSessionId;
  projectId: ProjectId | null;
  committedProjectId?: ProjectId;
  status: SetupSessionStatus;
  revision: number;
  model: SetupModelSelection;
  projectSettings: SetupProjectSettings;
  messages: SetupMessage[];
  draft: SetupDraft;
  locks: SetupLock[];
  lastError: SetupSessionError | null;
  previews?: SetupPreviewRecord[];
  conversationSummary?: string;
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
}

export interface SetupSuggestedAction {
  label: string;
  message: string;
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
  archiveIds?: string[];
}

export interface CreateSetupSessionBody {
  initialMessage?: string;
  projectSettings?: Partial<SetupProjectSettings>;
  model?: Partial<SetupModelSelection>;
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
  revision: number;
}

export interface PatchSetupSettingsResponse {
  session: SetupSession;
  revision: number;
}

export interface SetupSessionResponse {
  sessionId: SetupSessionId;
  session: SetupSession;
  assistantMessage?: SetupMessage;
  suggestedActions: SetupSuggestedAction[];
}

export interface SetupMessageResponse {
  session: SetupSession;
  assistantMessage?: SetupMessage;
  draft: SetupDraft;
  suggestedActions: SetupSuggestedAction[];
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
  };
  coreConcept?: string;
  firstWishSuggestion?: string;
  styleSample?: string;
  worldText: string;
  characters: Character[];
  memories: Memory[];
  storyState: StoryState;
  customSystemPrompt: string;
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

export interface CreateMemoryBody {
  type: MemoryType;
  content: string;
  importance?: MemoryImportance;
  relatedCharacters?: CharacterId[];
  relatedEpisodes?: EpisodeId[];
}

export interface Episode {
  episodeId: EpisodeId;
  title: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Scene {
  sceneId: SceneId;
  episodeId: EpisodeId;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface SceneRecord extends Scene {
  acceptedGenerationId: GenerationId | null;
  draftGenerationIds: GenerationId[];
}

export interface EpisodeRecord extends Episode {
  scenes: SceneRecord[];
}

export interface GenerationRequest {
  wish: string;
  outputLength: number;
  previousContextText: string;
  previousContextFilePath?: string;
  previousContextChars?: number;
  situationMemo?: string;
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
}

export interface ModelConfig {
  provider: string;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  defaultTemperature: number;
}

export interface ModelProviderInfo {
  name: string;
  label: string;
  defaultModel: string;
  apiKeyPlaceholder: string;
  apiKeyHelp: string;
  hasApiKey?: boolean;
}

export interface AppModelSettings {
  provider: string;
  modelName: string;
}

export interface AdapterGenerateRequest {
  systemInstructions: string;
  userPrompt: string;
  outputLength: number;
  temperature: number;
  timeoutMs: number;
  modelName: string;
  abortSignal?: AbortSignal;
  frequencyPenalty?: number;
  presencePenalty?: number;
  // NOTE: 'application/json' を指定するとプロバイダー側で構造化 JSON 出力を
  // 有効化する（Gemini: responseMimeType、OpenAI/DeepSeek: response_format）。
  // これで前置き文やコードフェンスが混ざる事故を減らせる。JSON.parse で直接
  // 読める応答になる想定だが、モデルが flag を無視することもあるため
  // 呼び出し側は fenced fallback パーサも用意しておく。
  responseMimeType?: 'application/json';
}

export type FinishReason = 'stop' | 'length' | 'timeout' | 'error' | 'content_filter';

export interface AdapterGenerateResult {
  text: string;
  finishReason: FinishReason;
  rawUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
  // NOTE: 空応答時の切り分け用に、adapter 側で拾えた診断情報（候補数・パート種別・
  // blockReason・safetyRatings 要約など）を短い文字列で残す。ユーザーには
  // エラー詳細としてそのまま見せる。
  debugInfo?: string;
}

export interface ConnectionStatus {
  ok: boolean;
  message?: string;
  errorCode?: string;
}

export interface PresetsFile {
  genrePreset: string;
  stylePreset: string;
  povPreset: string;
  pacingPreset: string;
  densityPreset: string;
  conversationPreset?: string;
  relationshipPacingPreset?: string;
  distancePreset?: string;
  constraintPreset?: string;
  userCustomPromptParts: string[];
  customSystemPrompt?: string;
}

export interface SystemPromptPreview {
  systemPrompt: string;
  generatedSystemPrompt: string;
  customSystemPrompt: string;
  isCustomized: boolean;
}

export interface ProjectSummary {
  projectId: ProjectId;
  title: string;
  updatedAt: string;
  lastOpenedAt: string;
  activePresetIds: ActivePresets;
  lastExcerpt: string;
}

export interface GenerateRequestBody {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
}

export interface CreateProjectBody {
  title?: string;
  outputLength?: number;
  streamingEnabled?: boolean;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
  samplingConfig?: Partial<SamplingConfig>;
  duplicateFrom?: ProjectId;
  coreConcept?: string;
  firstWishSuggestion?: string;
  styleSample?: string;
  worldText?: string;
  characters?: Character[];
  customSystemPrompt?: string;
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
}

export type RuntimeKind = 'electron' | 'server';

export interface SystemVersionInfo {
  version: string;
  runtime: RuntimeKind;
}

export interface DataDirInfo {
  current: string;
  defaultPath: string;
  isUsingDefault: boolean;
  pendingCleanup?: string | null;
}

export interface DataDirPreview {
  resolvedPath: string;
  targetIsEmpty: boolean;
  hasFreeSpace: boolean;
  estimatedSize: number;
  sameAsCurrentDir: boolean;
  invalidReason?: string;
}

export interface DataDirApplyResponse {
  ok: true;
  dataDir: string;
  pendingCleanup: string;
  restartScheduled: boolean;
}

export interface DataDirSelectResponse {
  path: string | null;
}

export type AdapterGenerateStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      finishReason: FinishReason;
      rawUsage?: AdapterGenerateResult['rawUsage'];
      debugInfo?: string;
    };

export interface ReaderState {
  project: Project;
  state: ProjectState;
  storyStateBacklogCount?: number;
  currentEpisode: EpisodeRecord | null;
  currentScene: SceneRecord | null;
  currentGeneration: GenerationRecord | null;
  memories: Memory[];
  knowledgeFiles: KnowledgeListItem[];
  navigation: ReaderNavigationState;
  contextUsage: ContextUsageEstimate | null;
  contextSummaryExcerpt: string;
}

export interface ReaderNavigationState {
  currentSceneOrder: number | null;
  totalScenes: number;
  hasPreviousScene: boolean;
  hasNextScene: boolean;
}

export interface ContextUsageEstimate {
  contextWindowTokens: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  tokenLimitSource: TokenLimitSource;
  estimatedPromptTokens: number;
  promptTokenSource: TokenCountSource;
  estimatedMaxOutputTokens: number;
  estimatedAvailableTokens: number;
  usageRatio: number;
  summaryChars: number;
  recentContextChars: number;
  knowledgeChars: number;
}

export type TokenLimitSource = 'provider' | 'catalog' | 'inferred';
export type TokenCountSource = 'provider' | 'estimated';

export type SceneNavigationDirection = 'previous' | 'next';

export interface ContextCompressionResult {
  summary: string;
  contextUsage: ContextUsageEstimate | null;
}

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

export interface RefineFinding {
  id: string;
  kind: RefineFindingKind;
  target: RefineFindingTarget;
  message: string;
  detail?: string;
  // NOTE: Phase 3 でチャット雛形の初期値として使う。Phase 2 では表示のみ。
  suggestedFix?: string;
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
}

// NOTE: Phase 3 の作品設定チャット。setup と違い「既存の world / characters
// への差分パッチ」を扱う。system prompt はチャット対象に含めない（サイレント
// デタッチ回避のため、明示的にインライン編集で書く方針）。
export type RefineMessageRole = 'user' | 'assistant' | 'system';

export interface RefineMessage {
  messageId: string;
  role: RefineMessageRole;
  content: string;
  createdAt: string;
  // NOTE: assistant メッセージがパッチを提案した場合、この配列にパッチ ID を
  // 記録。UI 側で対応するパッチカードを描画する。
  patchIds?: string[];
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
  currentState?: string;
}

export type RefinePatchOperation =
  | { kind: 'world-replace'; op: WorldReplaceOp }
  | { kind: 'world-append'; op: WorldAppendOp }
  | { kind: 'character-update'; characterId: CharacterId; fields: CharacterFieldPatch }
  | { kind: 'character-add'; character: Character }
  | { kind: 'character-remove'; characterId: CharacterId };

export type RefinePatchStatus = 'pending' | 'applied' | 'rejected' | 'stale';

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
}

export interface RefineSession {
  schemaVersion: 1;
  sessionId: string;
  projectId: ProjectId;
  usedModel: { provider: string; modelName: string };
  messages: RefineMessage[];
  patches: RefinePatch[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

export interface RefineChatResponse {
  session: RefineSession;
  assistantMessage: RefineMessage;
  newPatches: RefinePatch[];
}

export interface RefineApplyResponse {
  session: RefineSession;
  patch: RefinePatch;
}
