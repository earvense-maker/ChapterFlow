import { describe, expect, it } from 'vitest';
import {
  defaultModelForProvider,
  listModelProviders,
  resolveModelTokenLimits,
} from '../../src/server/services/modelInfoService';

describe('modelInfoService', () => {
  it('lists Gemini and DeepSeek providers', () => {
    const providers = listModelProviders();

    expect(providers.map((provider) => provider.name)).toEqual([
      'gemini',
      'deepseek',
      'openai',
    ]);
    expect(defaultModelForProvider('deepseek')).toBe('deepseek-v4-flash');
  });

  it('uses catalog limits for DeepSeek models', async () => {
    const limits = await resolveModelTokenLimits('deepseek', 'deepseek-v4-pro');

    expect(limits.contextWindowTokens).toBe(1_000_000);
    expect(limits.outputTokenLimit).toBe(384_000);
    expect(limits.source).toBe('catalog');
  });
});
