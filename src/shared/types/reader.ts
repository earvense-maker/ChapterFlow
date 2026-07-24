import type { Project, ProjectState } from './project.js';
import type { Memory } from './memory.js';
import type { KnowledgeListItem } from './knowledge.js';
import type { EpisodeRecord, SceneRecord } from './episode.js';
import type { GenerationRecord } from './generation.js';

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
