import type { EpisodeId, GenerationId, SceneId } from './ids.js';

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
