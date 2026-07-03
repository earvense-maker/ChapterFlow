import { baseInstruction } from './baseInstruction.js';
import { renderPresets } from './presetParts.js';
import type { ActivePresets } from '../types/index.js';

export interface SystemPromptResult {
  systemPrompt: string;
  generatedSystemPrompt: string;
  customSystemPrompt: string;
  isCustomized: boolean;
}

export async function buildGeneratedSystemPrompt(activePresets: ActivePresets): Promise<string> {
  const presetInstructions = await renderPresets(activePresets);
  return [baseInstruction(), presetInstructions].filter(Boolean).join('\n\n---\n\n');
}

export async function resolveSystemPrompt(
  activePresets: ActivePresets,
  customSystemPrompt?: string | null
): Promise<SystemPromptResult> {
  const generatedSystemPrompt = await buildGeneratedSystemPrompt(activePresets);
  const custom = customSystemPrompt ?? '';
  const isCustomized = custom.trim().length > 0;

  return {
    systemPrompt: isCustomized ? custom : generatedSystemPrompt,
    generatedSystemPrompt,
    customSystemPrompt: custom,
    isCustomized,
  };
}
