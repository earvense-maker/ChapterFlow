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
}

export interface ProjectState {
  lastOpenedAt: string;
  currentEpisodeId: EpisodeId | null;
  currentSceneId: SceneId | null;
  selectedDraftGenerationId: GenerationId | null;
  lastAcceptedGenerationId: GenerationId | null;
  pendingMemoryCandidateIds: MemoryId[];
  uiState: {
    readingPosition: number;
    fontSize: number;
  };
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
}

export interface ModelConfig {
  provider: string;
  modelName: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs: number;
  defaultTemperature: number;
}

export interface AdapterGenerateRequest {
  systemInstructions: string;
  userPrompt: string;
  outputLength: number;
  temperature: number;
  timeoutMs: number;
  modelName: string;
  abortSignal?: AbortSignal;
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
  retryable: boolean;
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
  activePresetIds?: Partial<ActivePresets>;
  duplicateFrom?: ProjectId;
}

export interface UpdateProjectBody {
  title?: string;
  outputLength?: number;
  streamingEnabled?: boolean;
  activeModelProvider?: string;
  activeModelName?: string;
  activePresetIds?: Partial<ActivePresets>;
}

export type AdapterGenerateStreamEvent =
  | { type: 'chunk'; text: string }
  | {
      type: 'done';
      finishReason: FinishReason;
      rawUsage?: AdapterGenerateResult['rawUsage'];
    };

export interface ReaderState {
  project: Project;
  state: ProjectState;
  currentEpisode: EpisodeRecord | null;
  currentScene: SceneRecord | null;
  currentGeneration: GenerationRecord | null;
  memories: Memory[];
}
