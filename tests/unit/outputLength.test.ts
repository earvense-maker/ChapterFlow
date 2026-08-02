import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS,
  estimateMaxOutputTokens,
  getApproximateOutputRange,
  resolveNovelMaxOutputTokens,
  resolveMaxOutputTokens,
} from '../../src/server/utils/outputLength';

describe('output length helpers', () => {
  it('uses an approximate range around the configured length', () => {
    expect(getApproximateOutputRange(4000)).toEqual({
      target: 4000,
      tolerance: 800,
      lower: 3200,
      upper: 4800,
    });
  });

  it('uses twenty percent as the prose length tolerance', () => {
    expect(getApproximateOutputRange(3000)).toEqual({
      target: 3000,
      tolerance: 600,
      lower: 2400,
      upper: 3600,
    });
  });

  it('keeps a token cushion above the upper character target', () => {
    expect(estimateMaxOutputTokens(4000, 8192)).toBeGreaterThan(4500);
  });

  it('prefers an explicit token budget and clamps it to the provider cap', () => {
    expect(resolveMaxOutputTokens({ outputLength: 6000, maxOutputTokens: 8192 }, 16_384)).toBe(8192);
    expect(resolveMaxOutputTokens({ outputLength: 6000, maxOutputTokens: 20_000 }, 16_384)).toBe(16_384);
  });

  it('falls back to the output-length estimate when the explicit budget is invalid', () => {
    expect(resolveMaxOutputTokens({ outputLength: 4000, maxOutputTokens: 0 }, 8192)).toBe(
      estimateMaxOutputTokens(4000, 8192)
    );
  });

  it('reserves a fixed 100k budget for DeepSeek V4 Flash prose', () => {
    expect(
      resolveNovelMaxOutputTokens(
        { provider: 'deepseek', modelName: 'deepseek-v4-flash', outputLength: 3000 },
        384_000
      )
    ).toBe(DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS);
  });

  it('keeps the character-based estimate for other novel models', () => {
    expect(
      resolveNovelMaxOutputTokens(
        { provider: 'openai', modelName: 'gpt-4o-mini', outputLength: 3000 },
        16_384
      )
    ).toBe(estimateMaxOutputTokens(3000, 16_384));
  });
});
