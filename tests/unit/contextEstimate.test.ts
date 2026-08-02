import { describe, expect, it } from 'vitest';
import { estimateContextUsage } from '../../src/server/utils/contextEstimate';
import { DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS } from '../../src/server/utils/outputLength';

describe('estimateContextUsage', () => {
  it('reports the same 100k output reservation used by DeepSeek V4 Flash prose', () => {
    const result = estimateContextUsage({
      provider: 'deepseek',
      modelName: 'deepseek-v4-flash',
      systemInstructions: 'system',
      userPrompt: 'user',
      outputLength: 3000,
      summaryText: '',
      recentContextText: '',
      modelLimits: {
        contextWindowTokens: 1_000_000,
        outputTokenLimit: 384_000,
        source: 'catalog',
      },
      promptTokenCount: { tokens: 1000, source: 'provider' },
    });

    expect(result.estimatedMaxOutputTokens).toBe(
      DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS
    );
    expect(result.estimatedAvailableTokens).toBe(899_000);
  });

  it('reports knowledgeChars without adding knowledge text to token totals twice', () => {
    const base = estimateContextUsage({
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      systemInstructions: 'system',
      userPrompt: 'user prompt with knowledge already included',
      outputLength: 1000,
      summaryText: 'summary',
      recentContextText: 'recent',
      modelLimits: {
        contextWindowTokens: 128_000,
        outputTokenLimit: 16_384,
        source: 'catalog',
      },
      promptTokenCount: { tokens: 1234, source: 'provider' },
    });
    const withKnowledge = estimateContextUsage({
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      systemInstructions: 'system',
      userPrompt: 'user prompt with knowledge already included',
      outputLength: 1000,
      summaryText: 'summary',
      recentContextText: 'recent',
      knowledgeText: '資料本文',
      modelLimits: {
        contextWindowTokens: 128_000,
        outputTokenLimit: 16_384,
        source: 'catalog',
      },
      promptTokenCount: { tokens: 1234, source: 'provider' },
    });

    expect(withKnowledge.knowledgeChars).toBe('資料本文'.length);
    expect(withKnowledge.estimatedPromptTokens).toBe(base.estimatedPromptTokens);
    expect(withKnowledge.usageRatio).toBe(base.usageRatio);
  });
});
