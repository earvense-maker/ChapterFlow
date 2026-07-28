export interface PresetsFile {
  userCustomPromptParts: string[];
  // NOTE: 未指定の旧データはアプリ既定の基本プロンプトを使う。空文字は、
  // 利用者が基本プロンプトを意図的に空にした状態として扱う。
  baseSystemPrompt?: string;
  customSystemPrompt?: string;
  // NOTE: 「未編集の既定文か、利用者が書いた文か」を保存側にも持つ（設計書 5.4）。
  // 本文 hash 照合だけでも判定できるが、既定文を改訂するたびに旧版hashを登録し続ける
  // 必要がある。新規作成・リセット時にここへ記録しておけば、以後の判定は照合に頼らない。
  // 欠損した既存データは hash 照合へフォールバックする。
  baseSystemPromptSource?: 'default' | 'custom';
  baseSystemPromptVersion?: number;
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
