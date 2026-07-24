import type { CharacterId, EpisodeId, MemoryId, SceneId } from './ids.js';

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

export interface CreateMemoryBody {
  type: MemoryType;
  content: string;
  importance?: MemoryImportance;
  relatedCharacters?: CharacterId[];
  relatedEpisodes?: EpisodeId[];
}
