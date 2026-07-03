import { describe, expect, it } from 'vitest';
import {
  estimateMaxOutputTokens,
  getApproximateOutputRange,
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
});
