import type { CharacterId } from './ids.js';

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
