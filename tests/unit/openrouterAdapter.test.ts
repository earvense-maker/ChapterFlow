import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterAdapter } from '../../src/server/adapters/openrouterAdapter';
import type { AdapterGenerateRequest, ModelConfig } from '../../src/shared/types';
import { getCredential } from '../../src/server/services/credentialService';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'test-openrouter-key'),
}));

const request: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 1000,
  temperature: 0.8,
  timeoutMs: 1000,
  modelName: 'openrouter/free',
  frequencyPenalty: 0.5,
  presencePenalty: 0.3,
  responseMimeType: 'application/json',
};

const modelConfig: ModelConfig = {
  provider: 'openrouter',
  modelName: 'openrouter/free',
  timeoutMs: 1000,
  defaultTemperature: 0.7,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('OpenRouterAdapter', () => {
  it('uses the OpenRouter endpoint, attribution headers, and free router model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: 'qwen/qwen3-free-test',
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OpenRouterAdapter().generateText(request);

    expect(getCredential).toHaveBeenCalledWith('openrouter');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-openrouter-key',
      'HTTP-Referer': 'https://github.com/earvense-maker/ChapterFlow',
      'X-Title': 'ChapterFlow',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'openrouter/free',
      temperature: 0.8,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(result.text).toBe('{"ok":true}');
    expect(result.resolvedModelName).toBe('qwen/qwen3-free-test');
  });

  it('validates the API key through the authenticated key endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { is_free_tier: true } }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await new OpenRouterAdapter().validateConnection({
      ...modelConfig,
      apiKey: 'provided-openrouter-key',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/key');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer provided-openrouter-key' });
    expect(status).toEqual({ ok: true, message: '接続できました' });
  });

  it('rejects an invalid OpenRouter API key during validation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const status = await new OpenRouterAdapter().validateConnection({
      ...modelConfig,
      apiKey: 'invalid-key',
    });

    expect(status).toMatchObject({ ok: false, errorCode: 'invalid_api_key' });
  });

  it('maps insufficient-credit responses to payment_required', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 402,
              message: 'Insufficient credits',
              metadata: { error_type: 'payment_required' },
            },
          }),
          { status: 402, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    const result = await new OpenRouterAdapter().generateText(request);

    expect(result).toMatchObject({
      finishReason: 'error',
      errorCode: 'payment_required',
      retryable: false,
    });
  });

  it('surfaces a rate-limit error delivered inside an HTTP 200 stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse({
        error: {
          code: 429,
          message: 'Rate limit exceeded',
          metadata: { error_type: 'rate_limit_exceeded' },
        },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const event of new OpenRouterAdapter().generateTextStream(request)) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'rate_limit',
      retryable: true,
      message: 'Rate limit exceeded',
    });
  });

  it('maps numeric provider codes without metadata to the matching error code', async () => {
    // NOTE: OpenRouterはmetadata.error_typeを付けずに数値codeだけを返すことがある。
    const fetchMock = vi.fn().mockResolvedValue(
      sseResponse({
        error: { code: 429, message: 'Rate limit exceeded' },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const event of new OpenRouterAdapter().generateTextStream(request)) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'rate_limit',
      retryable: true,
      message: 'Rate limit exceeded',
    });
  });

  it('treats OpenRouter SSE processing comments as connection activity', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(heartbeatSseResponse(init.signal ?? undefined))
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of new OpenRouterAdapter().generateTextStream({
      ...request,
      timeoutMs: 100,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'chunk', text: '本文' },
      {
        type: 'done',
        finishReason: 'stop',
        rawUsage: undefined,
        resolvedModelName: 'qwen/qwen3-free-test',
      },
    ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sseResponse(event: unknown): Response {
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function heartbeatSseResponse(signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (aborted) return;
        controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n\n'));
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      if (aborted) return;
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({
            model: 'qwen/qwen3-free-test',
            choices: [{ delta: { content: '本文' }, finish_reason: 'stop' }],
          })}\n\n`
        )
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      signal?.removeEventListener('abort', onAbort);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
