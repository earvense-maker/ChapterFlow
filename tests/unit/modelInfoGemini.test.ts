import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  countPromptTokens,
  resolveModelTokenLimits,
} from '../../src/server/services/modelInfoService';

vi.mock('../../src/server/services/credentialService', () => ({
  loadCredentials: vi.fn(async () => ({ gemini: 'test-gemini-key' })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('modelInfoService Gemini API calls', () => {
  it('counts prompt tokens with the API key header instead of a URL query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ totalTokens: 42 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await countPromptTokens('gemini', 'gemini-test', 'system', 'user');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(result).toEqual({ tokens: 42, source: 'provider' });
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:countTokens'
    );
    expect(url).not.toContain('key=');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': 'test-gemini-key',
    });
    const body = JSON.parse(init.body as string);
    expect(body.generateContentRequest.systemInstruction.parts[0].text).toBe('system');
  });

  it('omits systemInstruction from token counting when it is empty', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ totalTokens: 10 }));
    vi.stubGlobal('fetch', fetchMock);

    await countPromptTokens('gemini', 'gemini-test', '  ', 'user');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.generateContentRequest).not.toHaveProperty('systemInstruction');
  });

  it('fetches Gemini model limits with the API key header instead of a URL query', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        inputTokenLimit: 1000,
        outputTokenLimit: 200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const limits = await resolveModelTokenLimits('gemini', 'gemini-test-limits');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(limits).toMatchObject({
      contextWindowTokens: 1000,
      inputTokenLimit: 1000,
      outputTokenLimit: 200,
      source: 'provider',
    });
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-test-limits'
    );
    expect(url).not.toContain('key=');
    expect(init.headers).toMatchObject({
      'x-goog-api-key': 'test-gemini-key',
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
