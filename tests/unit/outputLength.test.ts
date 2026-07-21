import { describe, expect, it } from 'vitest';
import {
  estimateMaxOutputTokens,
  getApproximateOutputRange,
  resolveMaxOutputTokens,
} from '../../src/server/utils/outputLength';

describe('output length helpers', () => {
  it('uses an approximate range around the configured length', () => {
    expect(getApproximateOutputRange(4000)).toEqual({
      target: 4000,
      tolerance: 500,
      lower: 3500,
      upper: 4500,
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
});
