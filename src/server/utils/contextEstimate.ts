import { estimateMaxOutputTokens } from './outputLength.js';
import type { TokenCountSource, TokenLimitSource } from '../types/index.js';

export interface ContextUsageEstimateInput {
  modelName: string;
  provider: string;
  systemInstructions: string;
  userPrompt: string;
  outputLength: number;
  summaryText: string;
  recentContextText: string;
  modelLimits?: {
    contextWindowTokens: number;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    source: TokenLimitSource;
  };
  promptTokenCount?: {
    tokens: number;
    source: TokenCountSource;
  } | null;
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
}

export function estimateContextUsage(input: ContextUsageEstimateInput): ContextUsageEstimate {
  const modelLimits = input.modelLimits ?? inferContextWindowTokens(input.provider, input.modelName);
  const contextWindowTokens = modelLimits.contextWindowTokens;
  const estimatedPromptTokens = estimateTokensFromText(
    `${input.systemInstructions}\n\n${input.userPrompt}`
  );
  const promptTokens = input.promptTokenCount?.tokens ?? estimatedPromptTokens;
  const outputTokenLimit = modelLimits.outputTokenLimit ?? Math.min(contextWindowTokens, 16_384);
  const estimatedMaxOutputTokens = estimateMaxOutputTokens(
    input.outputLength,
    Math.min(contextWindowTokens, outputTokenLimit)
  );
  const estimatedAvailableTokens = Math.max(
    0,
    contextWindowTokens - promptTokens - estimatedMaxOutputTokens
  );

  return {
    contextWindowTokens,
    inputTokenLimit: modelLimits.inputTokenLimit,
    outputTokenLimit: modelLimits.outputTokenLimit,
    tokenLimitSource: modelLimits.source,
    estimatedPromptTokens: promptTokens,
    promptTokenSource: input.promptTokenCount?.source ?? 'estimated',
    estimatedMaxOutputTokens,
    estimatedAvailableTokens,
    usageRatio: Math.min(
      1,
      (promptTokens + estimatedMaxOutputTokens) / contextWindowTokens
    ),
    summaryChars: input.summaryText.length,
    recentContextChars: input.recentContextText.length,
  };
}

export function estimateTokensFromText(text: string): number {
  const asciiChars = [...text].filter((char) => char.charCodeAt(0) <= 0x7f).length;
  const nonAsciiChars = text.length - asciiChars;
  return Math.ceil(asciiChars / 4 + nonAsciiChars * 0.8);
}

function inferContextWindowTokens(
  provider: string,
  modelName: string
): {
  contextWindowTokens: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  source: TokenLimitSource;
} {
  const model = modelName.toLowerCase();
  if (provider === 'gemini' || model.includes('gemini')) {
    return {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 65_536,
      source: 'inferred',
    };
  }
  if (model.includes('gpt-5') || model.includes('gpt-4.1')) {
    return {
      contextWindowTokens: 1_000_000,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 32_768,
      source: 'inferred',
    };
  }
  if (model.includes('gpt-4o')) {
    return {
      contextWindowTokens: 128_000,
      inputTokenLimit: 128_000,
      outputTokenLimit: 16_384,
      source: 'inferred',
    };
  }
  return {
    contextWindowTokens: 128_000,
    inputTokenLimit: 128_000,
    outputTokenLimit: 16_384,
    source: 'inferred',
  };
}
