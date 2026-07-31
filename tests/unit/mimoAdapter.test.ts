import { afterEach, describe, expect, it, vi } from 'vitest';
import { MimoAdapter } from '../../src/server/adapters/mimoAdapter';
import type { AdapterGenerateRequest } from '../../src/shared/types';
import { getCredential } from '../../src/server/services/credentialService';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'sk-test-mimo-key'),
}));

const request: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 1000,
  temperature: 0.8,
  timeoutMs: 1000,
  modelName: 'mimo-v2.5',
  frequencyPenalty: 0.5,
  presencePenalty: 0.3,
  responseMimeType: 'application/json',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MimoAdapter', () => {
  it('posts to the MiMo endpoint with both auth headers and the documented field names', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new MimoAdapter().generateText(request);

    expect(getCredential).toHaveBeenCalledWith('mimo');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xiaomimimo.com/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer sk-test-mimo-key',
      'api-key': 'sk-test-mimo-key',
    });

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'mimo-v2.5',
      temperature: 0.8,
      // ペナルティは公式ドキュメントに記載があるのでそのまま送る。
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
    });
    // 出力上限は新しいフィールド名で送り、旧名は送らない。
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('max_tokens');
    // 未記載の JSON モードは送らない（400 で生成ごと止まるのを避ける）。
    expect(body).not.toHaveProperty('response_format');
    expect(result.text).toBe('{"ok":true}');
  });

  it('uses the MiMo label in fallback API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } })
    ));

    const result = await new MimoAdapter().generateText(request);

    expect(result).toMatchObject({
      finishReason: 'error',
      errorMessage: 'Xiaomi MiMo API error: 503',
      retryable: true,
    });
  });

  it('streams without stream_options and still reports usage when the API sends it', async () => {
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
    for await (const event of new MimoAdapter().generateTextStream(request)) events.push(event);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('stream_options');
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    expect(events).toEqual([
      { type: 'chunk', text: '本文' },
      {
        type: 'done',
        finishReason: 'stop',
        rawUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      },
    ]);
  });

  it('reads reasoning-style responses from content only', async () => {
    // NOTE: MiMo は思考を reasoning_content に分けて返す。本文欄だけを読むことで、
    // 思考文が作品本文に混ざらないことを固定する。
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { reasoning_content: '考え中の独り言', content: '本文だけ' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    ));

    const result = await new MimoAdapter().generateText(request);

    expect(result.text).toBe('本文だけ');
  });
});
