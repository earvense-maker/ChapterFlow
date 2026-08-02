import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/server/adapters/openaiAdapter';
import type { AdapterGenerateRequest } from '../../src/shared/types';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'test-openai-key'),
}));

const baseRequest: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 500,
  temperature: 0.7,
  timeoutMs: 1000,
  modelName: 'gpt-4o-mini',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// NOTE: 実fetchはabort時にbodyストリームをAbortErrorで落とすので、モックでも
// init.signal を配線して同じ挙動を再現する。これが無いとタイムアウト検証ができない。
function sseResponse(blocks: string[], gapMs: number, signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let errored = false;
      const onAbort = () => {
        errored = true;
        controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      for (const block of blocks) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        if (errored || signal?.aborted) return;
        controller.enqueue(encoder.encode(block));
      }
      signal?.removeEventListener('abort', onAbort);
      if (!errored) controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function sseChunkBlock(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function sseReasoningBlock(text: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n\n`;
}

describe('OpenAIAdapter', () => {
  it('uses an explicit maxOutputTokens value in the provider request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '本文' }, finish_reason: 'stop' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAIAdapter().generateText({ ...baseRequest, maxOutputTokens: 8192 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(8192);
  });

  it('reports non-streaming reasoning aggregates and forwards reasoning only through the diagnostic callback', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: { content: '本文', reasoning_content: '内部推論' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 25,
            total_tokens: 125,
            completion_tokens_details: { reasoning_tokens: 20 },
          },
        })
      )
    );

    const reasoningChunks: string[] = [];
    const result = await new OpenAIAdapter().generateText({
      ...baseRequest,
      onReasoningChunk: (chunk) => reasoningChunks.push(chunk),
    });

    expect(result).toMatchObject({
      text: '本文',
      reasoningStats: { chars: 4, chunks: 1 },
      rawUsage: {
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 125,
        reasoningTokens: 20,
      },
    });
    expect(reasoningChunks).toEqual(['内部推論']);
    expect(result).not.toHaveProperty('reasoningText');
    expect(JSON.stringify(result)).not.toContain(reasoningChunks[0]);
  });

  it('sends frequency_penalty and presence_penalty when set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '本文' }, finish_reason: 'stop' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAIAdapter().generateText({
      ...baseRequest,
      frequencyPenalty: 0.5,
      presencePenalty: 0.3,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(0.3);
  });

  it('does not send penalty fields when they are 0 or undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: '本文' }, finish_reason: 'stop' }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await new OpenAIAdapter().generateText({ ...baseRequest, frequencyPenalty: 0 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('frequency_penalty');
    expect(body).not.toHaveProperty('presence_penalty');
  });

  it('does not time out while chunks keep flowing, even past timeoutMs in total', async () => {
    // timeoutMs=200 に対し 120ms 間隔×4 チャンク（総時間 480ms超）。
    // 旧実装（総時間タイムアウト）ならここで落ちる。無通信タイムアウトなら成功する。
    const blocks = [
      sseChunkBlock('あ'),
      sseChunkBlock('い'),
      sseChunkBlock('う'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(sseResponse(blocks, 120, init.signal ?? undefined))
    );
    vi.stubGlobal('fetch', fetchMock);

    const received: string[] = [];
    let finishReason: string | undefined;
    for await (const event of new OpenAIAdapter().generateTextStream({
      ...baseRequest,
      timeoutMs: 200,
    })) {
      if (event.type === 'chunk') received.push(event.text);
      if (event.type === 'done') finishReason = event.finishReason;
    }

    expect(received.join('')).toBe('あいう');
    expect(finishReason).toBe('stop');
  });

  it('reports reasoning timing aggregates and forwards stream reasoning only through the diagnostic callback', async () => {
    const blocks = [
      sseReasoningBlock('内部推論A'),
      sseReasoningBlock('内部推論B'),
      sseChunkBlock('本文'),
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 45,
          total_tokens: 165,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(sseResponse(blocks, 0, init.signal ?? undefined))
      )
    );

    const events = [];
    const reasoningChunks: string[] = [];
    for await (const event of new OpenAIAdapter().generateTextStream({
      ...baseRequest,
      onReasoningChunk: (chunk) => reasoningChunks.push(chunk),
    })) {
      events.push(event);
    }
    const done = events.find((event) => event.type === 'done');

    expect(done).toMatchObject({
      type: 'done',
      rawUsage: {
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 40,
        reasoningTokens: 30,
      },
      streamMetrics: {
        reasoningChars: 10,
        reasoningChunks: 2,
        contentChars: 2,
        contentChunks: 1,
      },
    });
    expect(reasoningChunks).toHaveLength(2);
    expect(reasoningChunks.join('')).toHaveLength(10);
    expect(done).not.toHaveProperty('streamMetrics.reasoningText');
    for (const chunk of reasoningChunks) {
      expect(JSON.stringify(events)).not.toContain(chunk);
    }
  });

  it('times out when no stream events arrive within timeoutMs', async () => {
    const blocks = [sseChunkBlock('遅すぎる')];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(sseResponse(blocks, 500, init.signal ?? undefined))
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const event of new OpenAIAdapter().generateTextStream({
        ...baseRequest,
        timeoutMs: 100,
      })) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects a clean EOF that arrives before a finish reason or DONE marker', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) =>
      Promise.resolve(sseResponse([sseChunkBlock('途中まで')], 0, init.signal ?? undefined))
    );
    vi.stubGlobal('fetch', fetchMock);

    const consume = async () => {
      for await (const event of new OpenAIAdapter().generateTextStream(baseRequest)) {
        void event;
      }
    };

    await expect(consume()).rejects.toMatchObject({
      code: 'stream_ended_unexpectedly',
      retryable: true,
    });
  });
});
