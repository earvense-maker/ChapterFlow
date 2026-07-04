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

describe('OpenAIAdapter', () => {
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
});
