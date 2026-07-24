import type { CharacterId, GenerationId, SceneId } from './ids.js';
import type { MemoryImportance, StoryItemStatus } from './memory.js';

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
  // NOTE: 出来事の主体（発話者・行為者・宣言者）と受け手（宣告された相手・
  // 告白された相手など）。差分パッチにおける挙動:
  //  - キー不在: 既存値を保持（hasField 判定）
  //  - 明示 null: 既存値を null に上書き（主体不明への訂正）
  //  - characterId: 上書き。人物一覧に無い ID は正規化時に null に落とす
  // knownBy / explicitlyUnknownBy とは独立に抽出・保存する。「actor は必ず
  // knownBy に含まれる」といった自動包含はしない（背後からの攻撃・催眠中の
  // 宣告などで recipient が actor を認識していないケースがあるため）。
  actor?: CharacterId | null;
  recipient?: CharacterId | null;
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
