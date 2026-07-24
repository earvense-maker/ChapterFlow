export interface PresetsFile {
  userCustomPromptParts: string[];
  // NOTE: 未指定の旧データはアプリ既定の基本プロンプトを使う。空文字は、
  // 利用者が基本プロンプトを意図的に空にした状態として扱う。
  baseSystemPrompt?: string;
  customSystemPrompt?: string;
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
