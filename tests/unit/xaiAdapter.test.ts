import { afterEach, describe, expect, it, vi } from 'vitest';
import { XAIAdapter } from '../../src/server/adapters/xaiAdapter';
import type { AdapterGenerateRequest } from '../../src/shared/types';
import { getCredential } from '../../src/server/services/credentialService';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'test-xai-key'),
}));

const request: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 1000,
  temperature: 0.8,
  timeoutMs: 1000,
  modelName: 'grok-4.3',
  frequencyPenalty: 0.5,
  presencePenalty: 0.3,
  responseMimeType: 'application/json',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('XAIAdapter', () => {
  it('uses the xAI OpenAI-compatible endpoint and omits unsupported penalties', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new XAIAdapter().generateText(request);

    expect(getCredential).toHaveBeenCalledWith('xai');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-xai-key' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'grok-4.3',
      temperature: 0.8,
      response_format: { type: 'json_object' },
    });
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(result.text).toBe('{"ok":true}');
  });

  it('uses the xAI provider name in fallback API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })
    ));

    const result = await new XAIAdapter().generateText(request);

    expect(result).toMatchObject({
      finishReason: 'error',
      errorMessage: 'xAI API error: 503',
      retryable: true,
    });
  });

  it('requests usage and omits unsupported penalties when streaming', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: '本文' } }] })}\n\n`
        ));
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          })}\n\n`
        ));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const events = [];
    for await (const event of new XAIAdapter().generateTextStream(request)) events.push(event);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('presence_penalty');
    expect(events).toEqual([
      { type: 'chunk', text: '本文' },
      {
        type: 'done',
        finishReason: 'stop',
        rawUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      },
    ]);
  });
});
