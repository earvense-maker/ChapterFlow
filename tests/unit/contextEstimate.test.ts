import { describe, expect, it } from 'vitest';
import { estimateContextUsage } from '../../src/server/utils/contextEstimate';

describe('estimateContextUsage', () => {
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
