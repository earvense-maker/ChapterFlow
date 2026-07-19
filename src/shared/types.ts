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
  // NOTE: 未指定なら生成サービス側の TEMPERATURE_DEFAULT (0.7) を使う。variate モードは
  // ここで指定した値に +0.15 を上乗せ（上限 1.5）する。
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

export interface CharacterTrait {
  label: string;
  text: string;
}

export interface Character {
  characterId: CharacterId;
  name: string;
  aliases?: string[];
  role: CharacterRole;
  description: string;
  speechStyle?: string;
  relationshipNotes?: string;
  secrets?: string;
  traits?: CharacterTrait[];
  // NOTE: novel では物語開始時点、roleplay では会話開始時点の状態。
  // 進行中の状態は StoryState.characterStates で管理する。
  currentState?: string;
  // NOTE: ロールプレイモード用。会話開始時にキャラが最初に発するメッセージ。
  greeting?: string;
  // NOTE: ロールプレイモード用。口調の few-shot 例。1件=1発話、上限は projectService の正規化で丸める。
  dialogueExamples?: string[];
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
  // NOTE: 自動更新の直前に保存されていた StoryState.updatedAt。
  // L5 の鮮度判定で、手動編集を挟んだ更新連鎖を検出するために使う。
  previousUpdatedAt?: string;
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

export type SetupSuggestedActionIntent = 'preview' | 'commit';

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
  // OpenRouterのようなルーターが実際に選択したモデル。通常の直結APIでは未指定。
  resolvedModelName?: string;
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
  userCustomPromptParts: string[];
  // NOTE: 未指定の旧データはアプリ既定の基本プロンプトを使う。空文字は、
  // 利用者が基本プロンプトを意図的に空にした状態として扱う。
  baseSystemPrompt?: string;
  customSystemPrompt?: string;
}

export interface StyleSamplePreset {
  id: string;
  label: string;
  description: string;
  text: string;
}

export const SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS = 80;
export const SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS = 100_000;

export interface SystemPromptPreset {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemPromptPresetsFile {
  schemaVersion: 1;
  items: SystemPromptPreset[];
}

export interface SystemPromptPreview {
  systemPrompt: string;
  generatedSystemPrompt: string;
  baseSystemPrompt: string;
  defaultBaseSystemPrompt: string;
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
  // NOTE: サマリーでは undefined を返さず 'novel' に正規化。UI 一覧のバッジ・遷移振分けに使う。
  projectType: ProjectType;
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
      resolvedModelName?: string;
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
  schemaVersion: 1 | 2;
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

// ===== ロールプレイモード =====
//
// 会話ランタイム。相談モードで作った roleplay 型プロジェクトを開くと、この
// セッション単位で会話が保存される。設計書 3.1 のデータ整合性方針:
//  - 保存済みセッションが正、ストリーミング中の暫定表示はコミット点に達するまで
//    未保存として扱う。
//  - 全変更操作は sessionId 単位の in-memory mutex + revision 検査を通す。
//  - contextSnapshot は作成時のペルソナ・世界観をスナップショットし、後日の
//    キャラ編集で既存会話が変質しないようにする。

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
  // NOTE: 編集済み基本プロンプトと明示選択プリセットを、会話開始時に固定する。
  // 旧セッションでは未指定のため optional。
  projectSystemPrompt?: string;
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
