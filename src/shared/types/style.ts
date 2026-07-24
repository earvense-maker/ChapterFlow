import type { GenerationId } from './ids.js';
import type { AdapterGenerateResult } from './model.js';

export type StyleAxis =
  | 'visual'
  | 'auditory'
  | 'somatic'
  | 'introspective'
  | 'kinetic'
  | 'dialogic'
  | 'temporal';

export type StyleVariationIntensity = 'subtle' | 'balanced';

export interface StyleVariationSettings {
  enabled: boolean;
  intensity: StyleVariationIntensity;
  axisWeights: Partial<Record<StyleAxis, number>>;
  surfaceDecayEnabled: boolean;
  patternDecayEnabled: boolean;
  // NOTE: 反復自体が作品モチーフや人物性である語句・型は、減衰候補から除外する。
  // UI では1行1項目で編集し、保存時に空行・重複を除く。
  motifExclusions: string[];
}

export const STYLE_PROFILE_SCHEMA_VERSION = 1;

export interface GenerationStyleProfile {
  schemaVersion: 1;
  seed: string;
  primaryAxis: StyleAxis;
  secondaryAxis?: StyleAxis;
  entryChannel?: 'visual' | 'pressure' | 'temperature' | 'sound' | 'distance';
  attenuatedPatterns: string[];
  intensity: StyleVariationIntensity;
}

export interface GenerationStyleTrace {
  generationId: GenerationId;
  openingChannel?: string;
  dominantAxes: StyleAxis[];
  endingPattern?: string;
  metaphorCores: string[];
  reactionPatterns: string[];
  rhythmSummary?: string;
  createdAt: string;
}

export interface StyleTraceAnalysisRecord {
  generationId: GenerationId;
  status: 'completed' | 'failed';
  usedModel: {
    provider: string;
    modelName: string;
  };
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usage?: AdapterGenerateResult['rawUsage'];
  // NOTE: 必須6カテゴリのうち、妥当な値を抽出できた割合。モデルやprompt変更後の
  // 品質比較に使う監査値であり、本文の自動採否には使わない。
  qualityScore?: number;
  errorMessage?: string;
}

export interface GenerationStyleTraceStore {
  schemaVersion: 1;
  traces: GenerationStyleTrace[];
  analyses: StyleTraceAnalysisRecord[];
}
