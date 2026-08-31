import { describe, expect, it } from 'vitest';
import { applyJsonTaskPolicy } from '../../src/server/services/jsonTaskPolicy';
import type { AdapterGenerateRequest } from '../../src/shared/types/model';

function baseRequest(overrides: Partial<AdapterGenerateRequest> = {}): AdapterGenerateRequest {
  return {
    systemInstructions: 'system',
    userPrompt: 'user',
    outputLength: 1200,
    temperature: 0.5,
    timeoutMs: 30_000,
    modelName: 'test-model',
    ...overrides,
  };
}

describe('applyJsonTaskPolicy', () => {
  it('sets responseMimeType to application/json', () => {
    const result = applyJsonTaskPolicy(baseRequest(), { reasoningMode: 'disabled' });
    expect(result.responseMimeType).toBe('application/json');
  });

  it('passes through the specified reasoningMode', () => {
    const disabled = applyJsonTaskPolicy(baseRequest(), { reasoningMode: 'disabled' });
    expect(disabled.reasoningMode).toBe('disabled');
    const enabled = applyJsonTaskPolicy(baseRequest(), { reasoningMode: 'enabled' });
    expect(enabled.reasoningMode).toBe('enabled');
  });

  it('defaults maxOutputTokens to 40000 when not specified', () => {
    const result = applyJsonTaskPolicy(baseRequest(), { reasoningMode: 'disabled' });
    expect(result.maxOutputTokens).toBe(40_000);
  });

  it('preserves explicit maxOutputTokens when provided', () => {
    const result = applyJsonTaskPolicy(baseRequest(), {
      reasoningMode: 'disabled',
      maxOutputTokens: 8192,
    });
    expect(result.maxOutputTokens).toBe(8192);
  });

  it('does not change systemInstructions, userPrompt, temperature, timeout, or modelName', () => {
    const input = baseRequest({
      systemInstructions: 'custom-system',
      userPrompt: 'custom-user',
      temperature: 0.9,
      timeoutMs: 90_000,
      modelName: 'deepseek-v4-flash',
    });
    const result = applyJsonTaskPolicy(input, { reasoningMode: 'disabled' });
    expect(result.systemInstructions).toBe('custom-system');
    expect(result.userPrompt).toBe('custom-user');
    expect(result.temperature).toBe(0.9);
    expect(result.timeoutMs).toBe(90_000);
    expect(result.modelName).toBe('deepseek-v4-flash');
  });

  it('does not change outputLength', () => {
    const result = applyJsonTaskPolicy(baseRequest({ outputLength: 5000 }), {
      reasoningMode: 'disabled',
    });
    expect(result.outputLength).toBe(5000);
  });

  it('preserves abortSignal if present', () => {
    const controller = new AbortController();
    const result = applyJsonTaskPolicy(
      baseRequest({ abortSignal: controller.signal }),
      { reasoningMode: 'disabled' }
    );
    expect(result.abortSignal).toBe(controller.signal);
  });
});
