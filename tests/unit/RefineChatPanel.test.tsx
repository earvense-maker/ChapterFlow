import { describe, expect, it } from 'vitest';
import { formatCharacterPatchValue } from '../../src/client/components/RefineChatPanel';

describe('formatCharacterPatchValue', () => {
  it('formats trait arrays and indents continuation lines', () => {
    expect(
      formatCharacterPatchValue([
        { label: 'こだわり', text: '一行目\n二行目' },
        { label: '動機', text: '故郷へ帰る' },
      ])
    ).toBe('こだわり: 一行目\n  二行目\n動機: 故郷へ帰る');
  });

  it('shows an explicit empty marker for clearing traits', () => {
    expect(formatCharacterPatchValue([])).toBe('（なし）');
  });
});
