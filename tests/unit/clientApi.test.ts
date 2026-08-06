import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../src/client/clientApi';
import type { GenerationRecord } from '../../src/shared/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clientApi streaming', () => {
  it('reassembles split SSE chunks and returns the terminal generation record once', async () => {
    const record = generationRecord('完成した本文');
    const payload = [
      `event: chunk\r\ndata: ${JSON.stringify({ text: '特殊文字 😀\n' })}\r\n\r\n`,
      `event: chunk\ndata: ${JSON.stringify({ text: '後半' })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ record })}\n\n`,
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(byteSplitStreamResponse(payload, 7)));
    const chunks: string[] = [];

    const result = await api.generateStream(
      'proj-client-api',
      { wish: '', mode: 'continue' },
      (chunk) => chunks.push(chunk)
    );

    expect(chunks).toEqual(['特殊文字 😀\n', '後半']);
    expect(result).toEqual(record);
  });

  it('reports a retryable error when a generation stream ends without done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([`event: chunk\ndata: ${JSON.stringify({ text: '途中' })}\n\n`])
      )
    );

    await expect(
      api.generateStream('proj-client-api', { wish: '', mode: 'continue' }, () => undefined)
    ).rejects.toMatchObject({
      name: 'ApiError',
      code: 'stream_ended_unexpectedly',
      retryable: true,
    });
  });

  it('preserves API error codes and retryability from a streaming HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'リクエストが多すぎます',
            code: 'rate_limit',
            retryable: true,
          }),
          { status: 429, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const error = await api
      .generateStream('proj-client-api', { wish: '', mode: 'continue' }, () => undefined)
      .catch((err) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'rate_limit', retryable: true, status: 429 });
    expect((error as Error).message).toContain('少し待って再試行できます');
  });

  it('rejects a setup stream that closes without result or error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([`event: delta\ndata: ${JSON.stringify({ text: '途中' })}\n\n`])
      )
    );

    await expect(
      api.sendSetupMessageStream(
        'setup-client-api',
        { message: '相談', revision: 0 },
        {
          onDelta: () => undefined,
          onResult: () => undefined,
          onError: () => undefined,
        }
      )
    ).rejects.toMatchObject({
      code: 'stream_ended_unexpectedly',
      retryable: true,
    });
  });

  it('reports an invalid roleplay done event instead of leaving the UI streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        streamResponse([`event: done\ndata: ${JSON.stringify({})}\n\n`])
      )
    );
    const errors: Array<{ error: string; code?: string; retryable?: boolean }> = [];

    await api.sendRoleplayMessageStream(
      'proj-client-api',
      'session-client-api',
      { message: 'こんにちは', revision: 0 },
      {
        onChunk: () => undefined,
        onDone: () => undefined,
        onError: (error) => errors.push(error),
      }
    );

    expect(errors).toEqual([
      {
        error: 'ロールプレイ応答の完了データが不正です。',
        code: 'invalid_stream_event',
        retryable: true,
      },
    ]);
  });

  // NOTE: 設計書 10.6 / 6.3。postprocessing / replace は保存前の表現調整の通知。
  // onPostprocessing / onReplace は optional で、知らない呼び出し側は素通りして
  // done まで到達する（設計書 7.3 の後方互換）。
  it('delivers postprocessing and replace events and treats done.session as the final text', async () => {
    const session = {
      sessionId: 'session-client-api',
      revision: 3,
      messages: [{ messageId: 'm3', role: 'character', content: '書き換え済みの本文' }],
    };
    const payload = [
      `event: chunk\ndata: ${JSON.stringify({ text: '暫定本文' })}\n\n`,
      `event: postprocessing\ndata: ${JSON.stringify({})}\n\n`,
      `event: replace\ndata: ${JSON.stringify({ text: '書き換え済みの本文' })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ session })}\n\n`,
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([payload])));
    const received: string[] = [];
    let postprocessingCount = 0;
    let doneSession: unknown;
    const chunks: string[] = [];

    await api.sendRoleplayMessageStream(
      'proj-client-api',
      'session-client-api',
      { message: 'こんにちは', revision: 2 },
      {
        onChunk: (text) => chunks.push(text),
        onPostprocessing: () => {
          postprocessingCount += 1;
        },
        onReplace: (text) => received.push(text),
        onDone: (sessionView) => {
          doneSession = sessionView;
        },
        onError: () => undefined,
      }
    );

    expect(chunks).toEqual(['暫定本文']);
    expect(postprocessingCount).toBe(1);
    expect(received).toEqual(['書き換え済みの本文']);
    expect(doneSession).toEqual(session);
  });

  it('ignores unknown SSE events and lets an old handler without replace callbacks reach done', async () => {
    const session = {
      sessionId: 'session-client-api',
      revision: 3,
      messages: [{ messageId: 'm3', role: 'character', content: '最終保存本文' }],
    };
    const payload = [
      `event: unknown-event\ndata: ${JSON.stringify({ text: '無視される' })}\n\n`,
      `event: postprocessing\ndata: ${JSON.stringify({})}\n\n`,
      `event: replace\ndata: ${JSON.stringify({ text: '最終保存本文' })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ session })}\n\n`,
    ].join('');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse([payload])));
    let doneSession: unknown;
    const errors: unknown[] = [];

    // 旧クライアント相当の handler: onPostprocessing / onReplace を持たない。
    await api.sendRoleplayMessageStream(
      'proj-client-api',
      'session-client-api',
      { message: 'こんにちは', revision: 2 },
      {
        onChunk: () => undefined,
        onDone: (sessionView) => {
          doneSession = sessionView;
        },
        onError: (error) => errors.push(error),
      }
    );

    expect(errors).toEqual([]);
    // done.session（または再接続後の GET）が最終保存本文の正（設計書 11-17）。
    expect(doneSession).toEqual(session);
  });
});

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}

function byteSplitStreamResponse(value: string, size: number): Response {
  const bytes = new TextEncoder().encode(value);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += size) {
          controller.enqueue(bytes.slice(index, index + size));
        }
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }
  );
}

function generationRecord(responseText: string): GenerationRecord {
  return {
    generationId: 'gen-client-api',
    episodeId: 'ep-client-api',
    sceneId: 'scene-client-api',
    request: { wish: '', outputLength: 3000, previousContextText: '' },
    responseText,
    usedPresets: { narration: 'third-close' },
    usedModel: { provider: 'openai', modelName: 'gpt-test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-20T00:00:00.000Z',
    parentGenerationId: null,
  };
}
