import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/server/adapters/deepseekAdapter';
import type { AdapterGenerateRequest } from '../../src/shared/types';

vi.mock('../../src/server/services/credentialService', () => ({
  getCredential: vi.fn(() => 'sk-test-deepseek-key'),
}));

const baseRequest: AdapterGenerateRequest = {
  systemInstructions: 'system',
  userPrompt: 'user',
  outputLength: 2200,
  temperature: 0.35,
  timeoutMs: 1000,
  modelName: 'deepseek-v4-flash',
};

function mockJsonResponse(message: Record<string, unknown>, finishReason = 'stop') {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message, finish_reason: finishReason }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DeepSeekAdapter', () => {
  it('turns thinking off for JSON requests', async () => {
    // NOTE: v4 系は思考が既定で有効で、JSON 出力と併用すると最終回答まで
    // reasoning_content 側へ入り content が空になる。JSON 用途では思考を切る。
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      responseMimeType: 'application/json',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('keeps thinking enabled for prose generation', async () => {
    const fetchMock = mockJsonResponse({ content: '本文。' });

    await new DeepSeekAdapter().generateText(baseRequest);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('thinking');
  });

  it('reports when the answer landed in reasoning_content instead of content', async () => {
    // NOTE: この診断が無かったために、空応答の原因が「枠不足」なのか「本文欄に
    // 入らなかった」なのか切り分けられなかった。
    mockJsonResponse({ content: '', reasoning_content: 'ここに答えを書いてしまった' });

    const result = await new DeepSeekAdapter().generateText({
      ...baseRequest,
      responseMimeType: 'application/json',
    });

    expect(result.text).toBe('');
    expect(result.debugInfo).toContain('content=empty');
    expect(result.debugInfo).toContain('reasoning_content=');
  });

  it('does not add diagnostics when content is present', async () => {
    mockJsonResponse({ content: '{"ok":true}', reasoning_content: '考えた' });

    const result = await new DeepSeekAdapter().generateText(baseRequest);

    expect(result.text).toBe('{"ok":true}');
    expect(result.debugInfo).toBeUndefined();
  });
});
