import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type { AdapterGenerateRequest } from '../../src/shared/types';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'test-gemini-key'),
}));

const baseRequest: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 500,
  temperature: 0.7,
  timeoutMs: 1000,
  modelName: 'gemini-test',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GeminiAdapter', () => {
  it('sends generate requests with the API key header instead of a URL query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: '本文' }] },
            finishReason: 'STOP',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiAdapter().generateText(baseRequest);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(result.text).toBe('本文');
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent'
    );
    expect(url).not.toContain('key=');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': 'test-gemini-key',
    });
  });

  it('validates connections with the API key header instead of a URL query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ models: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await new GeminiAdapter().validateConnection({
      provider: 'gemini',
      modelName: 'gemini-test',
      apiKey: 'provided-key',
      timeoutMs: 1000,
      defaultTemperature: 0.7,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(status.ok).toBe(true);
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(url).not.toContain('key=');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': 'provided-key',
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
