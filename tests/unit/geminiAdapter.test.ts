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
  it('uses an explicit maxOutputTokens value in the provider request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '本文' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({ ...baseRequest, maxOutputTokens: 8192 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

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

  it('does not send frequencyPenalty or presencePenalty to Gemini even when set', async () => {
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
    expect(body.generationConfig).not.toHaveProperty('frequencyPenalty');
    expect(body.generationConfig).not.toHaveProperty('presencePenalty');
  });

  it('uses high thinkingLevel without thinkingBudget for Gemini 3.x', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '本文' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({
      ...baseRequest,
      modelName: 'gemini-3.6-flash',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'high',
      includeThoughts: false,
    });
    expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
  });

  it.each([
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-4-flash',
    'gemini-flash-latest',
  ])(
    'omits deprecated sampling parameters for %s',
    async (modelName) => {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      await new GeminiAdapter().generateText({
        ...baseRequest,
        modelName,
        temperature: 0.7,
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);

      expect(body.generationConfig).not.toHaveProperty('temperature');
      expect(body.generationConfig).not.toHaveProperty('topP');
      expect(body.generationConfig).not.toHaveProperty('topK');
    }
  );

  it('keeps temperature for older Gemini models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({
      ...baseRequest,
      modelName: 'gemini-3.5-flash',
      temperature: 0.7,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.generationConfig.temperature).toBe(0.7);
  });

  it('omits thinkingConfig for Gemini 2.5 models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '本文' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({
      ...baseRequest,
      modelName: 'gemini-2.5-flash',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.generationConfig).not.toHaveProperty('thinkingConfig');
  });

  it('sends the feature-specific system instructions without a Gemini preamble', async () => {
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

    expect(systemText).toBe('system');
  });

  it('omits systemInstruction when the feature has no system instructions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new GeminiAdapter().generateText({ ...baseRequest, systemInstructions: '   ' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body).not.toHaveProperty('systemInstruction');
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

  it('reports whether an empty response was blocked at the prompt stage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        promptFeedback: {
          blockReason: 'PROHIBITED_CONTENT',
          safetyRatings: [
            {
              category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
              probability: 'HIGH',
              blocked: true,
            },
          ],
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new GeminiAdapter().generateText(baseRequest);

    expect(result.text).toBe('');
    expect(result.debugInfo).toContain('promptBlockReason=PROHIBITED_CONTENT');
    expect(result.debugInfo).toContain('promptSafety=SEXUALLY_EXPLICIT=HIGH(blocked)');
  });

  it('retains streaming safety diagnostics that arrive before the final event', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          promptFeedback: {
            blockReason: 'PROHIBITED_CONTENT',
            safetyRatings: [
              {
                category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                probability: 'MEDIUM',
                blocked: true,
              },
            ],
          },
        },
        {
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 0,
            totalTokenCount: 12,
          },
        },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of new GeminiAdapter().generateTextStream(baseRequest)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'done', finishReason: 'stop' });
    expect(events[0].type === 'done' ? events[0].debugInfo : undefined).toContain(
      'promptBlockReason=PROHIBITED_CONTENT'
    );
  });

  it('keeps diagnostics when a streamed candidate is stopped by a content filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse([
        {
          candidates: [
            {
              content: { parts: [{ text: '途中まで' }] },
              safetyRatings: [
                {
                  category: 'HARM_CATEGORY_HARASSMENT',
                  probability: 'HIGH',
                  blocked: true,
                },
              ],
            },
          ],
        },
        { candidates: [{ finishReason: 'SAFETY', safetyRatings: [] }] },
      ])
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of new GeminiAdapter().generateTextStream(baseRequest)) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'chunk', text: '途中まで' });
    expect(events[1]).toMatchObject({ type: 'done', finishReason: 'content_filter' });
    expect(events[1].type === 'done' ? events[1].debugInfo : undefined).toContain(
      'candidateSafety=HARASSMENT=HIGH(blocked)'
    );
  });

  it('rejects streamed text when EOF arrives without a finish reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([{ candidates: [{ content: { parts: [{ text: '途中まで' }] } }] }])
      )
    );

    const consume = async () => {
      for await (const event of new GeminiAdapter().generateTextStream(baseRequest)) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'stream_ended_unexpectedly',
      retryable: true,
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

function sseResponse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
