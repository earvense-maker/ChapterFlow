import type { EpisodeId, GenerationId, MemoryId, SceneId } from './ids.js';
import type { GenerationStyleProfile } from './style.js';
import type { ActivePresets } from './project.js';
import type { FinishReason } from './model.js';

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
  // NOTE: 'length' の場合は本文を失わず下書きとして残しつつ、UIで上限到達を通知する。
  finishReason?: FinishReason;
  styleProfile?: GenerationStyleProfile;
}

export interface GenerateRequestBody {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
}
