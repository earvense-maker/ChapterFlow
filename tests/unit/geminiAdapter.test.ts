import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { GEMINI_FICTION_SAFETY_PREAMBLE } from '../../src/server/prompts/geminiSystemPreamble';
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

  it('includes frequencyPenalty and presencePenalty in generationConfig when set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '本文' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({
      ...baseRequest,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.frequencyPenalty).toBe(0.5);
    expect(body.generationConfig.presencePenalty).toBe(0.3);
  });

  it('prepends the Gemini fiction safety preamble to system instructions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText(baseRequest);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    const systemText = body.systemInstruction.parts[0].text;

    expect(systemText).toBe(`${GEMINI_FICTION_SAFETY_PREAMBLE}\n\nsystem`);
    expect(systemText.indexOf(GEMINI_FICTION_SAFETY_PREAMBLE)).toBeLessThan(
      systemText.indexOf('system')
    );
  });

  it('does not include penalty fields when they are 0 or undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '本文' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({ ...baseRequest, frequencyPenalty: 0 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig).not.toHaveProperty('frequencyPenalty');
    expect(body.generationConfig).not.toHaveProperty('presencePenalty');
  });

  it('maps Gemini 400 invalid argument responses to invalid_request_error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad request' },
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiAdapter().generateText(baseRequest);
    expect(result.finishReason).toBe('error');
    expect(result.errorCode).toBe('invalid_request_error');
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
