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

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      maxOutputTokens: 100_000,
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_tokens).toBe(100_000);
  });

  it('lets the caller lower the reasoning effort for interactive turns', async () => {
    // NOTE: 送信値は従来どおり低く渡せる。ただし公式仕様では V4 側が low / medium を
    // high として扱うため、実効値は high になる。AI 相談の期待値として low を使わない。
    const fetchMock = mockJsonResponse({ content: '返答。' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      reasoningEffort: 'low',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('low');
  });

  it('enables thinking for JSON requests when reasoningMode is enabled on V4 Flash', async () => {
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      responseMimeType: 'application/json',
      reasoningMode: 'enabled',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('enables thinking for JSON requests on V4 Pro too', async () => {
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      modelName: 'deepseek-v4-pro',
      responseMimeType: 'application/json',
      reasoningMode: 'enabled',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('normalizes low/medium reasoningEffort to high on the explicit enabled path', async () => {
    // NOTE: V4 は low / medium を high として扱うため、明示 enabled 経路では送信値を
    // high に正規化してリクエストと実効値を一致させる（設計書 5.2）。
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      responseMimeType: 'application/json',
      reasoningMode: 'enabled',
      reasoningEffort: 'low',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'enabled' });
    expect(body.reasoning_effort).toBe('high');
  });

  it('turns thinking off when reasoningMode is disabled even for JSON', async () => {
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      responseMimeType: 'application/json',
      reasoningMode: 'disabled',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('keeps JSON requests thinking-disabled for non-V4 models even with reasoningMode enabled', async () => {
    // NOTE: 未知・旧モデルへ未確認パラメータを強制しない（設計書 5.2 case 3）。
    const fetchMock = mockJsonResponse({ content: '{"ok":true}' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      modelName: 'deepseek-chat',
      responseMimeType: 'application/json',
      reasoningMode: 'enabled',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('does not force thinking fields onto non-V4 models in non-JSON requests', async () => {
    const fetchMock = mockJsonResponse({ content: '本文。' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      modelName: 'deepseek-chat',
      reasoningMode: 'enabled',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('does not force V4 Flash thinking fields onto other DeepSeek models', async () => {
    const fetchMock = mockJsonResponse({ content: '本文。' });

    await new DeepSeekAdapter().generateText({
      ...baseRequest,
      modelName: 'deepseek-v4-pro',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('reasoning_effort');
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
