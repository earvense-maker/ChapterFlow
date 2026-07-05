// サーバー・クライアント共通のドメイン型

export type ProjectId = string;
export type EpisodeId = string;
export type SceneId = string;
export type GenerationId = string;
export type MemoryId = string;
export type CharacterId = string;

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
  role: CharacterRole;
  description: string;
  speechStyle?: string;
  relationshipNotes?: string;
  secrets?: string;
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

export interface FrequencyReportItem {
  text: string;
  count: number;
  score: number;
  isNg: boolean;
}

export interface FrequencyReport {
  generatedAt: string;
  analyzedChars: number;
  phrases: FrequencyReportItem[];
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

export interface StoryState {
  schemaVersion: 1;
  currentSituation: string[];
  characterStates: StoryCharacterState[];
  importantEvents: StoryEventRecord[];
  openThreads: StoryThreadRecord[];
  updatedAt: string;
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

export interface UpdateSetupDraftBody {
  draft: SetupDraft;
  revision: number;
  manualEditPaths?: string[];
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

export interface SetupPreviewResponse {
  previewText: string;
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
  worldText?: string;
  characters?: Character[];
  customSystemPrompt?: string;
}

export interface UpdateProjectBody {
  title?: string;
  outputLength?: number;
  streamingEnabled?: boolean;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
  samplingConfig?: Partial<SamplingConfig>;
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
  currentEpisode: EpisodeRecord | null;
  currentScene: SceneRecord | null;
  currentGeneration: GenerationRecord | null;
  memories: Memory[];
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
}

export type TokenLimitSource = 'provider' | 'catalog' | 'inferred';
export type TokenCountSource = 'provider' | 'estimated';

export type SceneNavigationDirection = 'previous' | 'next';

export interface ContextCompressionResult {
  summary: string;
  contextUsage: ContextUsageEstimate | null;
}
