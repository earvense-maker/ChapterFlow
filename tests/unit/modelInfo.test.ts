import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultModelForProvider,
  listModelProviders,
  listModelProvidersWithKeyInfo,
  resolveModelTokenLimits,
} from '../../src/server/services/modelInfoService';

vi.mock('../../src/server/services/credentialService', () => ({
  loadCredentials: vi.fn(async () => ({ gemini: 'test-gemini-key' })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('modelInfoService', () => {
  it('lists Gemini, DeepSeek, OpenAI and xAI providers', () => {
    const providers = listModelProviders();

    expect(providers.map((provider) => provider.name)).toEqual([
      'gemini',
      'deepseek',
      'openai',
      'xai',
    ]);
    expect(defaultModelForProvider('deepseek')).toBe('deepseek-v4-pro');
    expect(defaultModelForProvider('xai')).toBe('grok-4.3');
  });

  it('uses catalog limits for current Grok models', async () => {
    const grok43 = await resolveModelTokenLimits('xai', 'grok-4.3');
    const grok45 = await resolveModelTokenLimits('xai', 'grok-4.5');

    expect(grok43).toMatchObject({ contextWindowTokens: 1_000_000, source: 'catalog' });
    expect(grok45).toMatchObject({ contextWindowTokens: 500_000, source: 'catalog' });
  });

  it('uses catalog limits for DeepSeek models', async () => {
    const limits = await resolveModelTokenLimits('deepseek', 'deepseek-v4-pro');

    expect(limits.contextWindowTokens).toBe(1_000_000);
    expect(limits.outputTokenLimit).toBe(384_000);
    expect(limits.source).toBe('catalog');
  });

  it('marks providers with stored API keys', async () => {
    const providers = await listModelProvidersWithKeyInfo();

    expect(providers.find((p) => p.name === 'gemini')?.hasApiKey).toBe(true);
    expect(providers.find((p) => p.name === 'deepseek')?.hasApiKey).toBe(false);
    expect(providers.find((p) => p.name === 'openai')?.hasApiKey).toBe(false);
    expect(providers.find((p) => p.name === 'xai')?.hasApiKey).toBe(false);
  });
});
