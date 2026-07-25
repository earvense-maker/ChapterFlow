import { describe, expect, it } from 'vitest';
import {
  findNearMiss,
  findNgMatches,
  isUnchangedText,
  nearMissThreshold,
  normalizeNgPhrase,
} from '../../src/shared/ngDetection';

const expression = (id: string, text: string, alternatives?: string[]) => ({
  id,
  text,
  ...(alternatives ? { alternatives } : {}),
});

describe('ngDetection: findNgMatches', () => {
  it('returns offsets into the original text, not the normalized one', () => {
    const text = 'そこで彼は、瞳を、揺らす。';
    const [match] = findNgMatches(text, [expression('a', '瞳を揺らす')]);

    // NOTE: 検出は約物を落とした形で行うが、返す位置は必ず元本文のものでないと
    // ハイライトも置換もできない。読点をまたいだ範囲がそのまま返ることを見る。
    expect(text.slice(match.start, match.end)).toBe('瞳を、揺らす');
  });

  it('matches across punctuation, quotes and full/half width differences', () => {
    expect(findNgMatches('「息を、呑んだ」', [expression('a', '息を呑んだ')])).toHaveLength(1);
    expect(findNgMatches('ＡＢＣ を言った', [expression('a', 'abc')])).toHaveLength(1);
  });

  it('finds every occurrence of the same expression', () => {
    const matches = findNgMatches('息を呑んだ。彼女も息を呑んだ。', [expression('a', '息を呑んだ')]);
    expect(matches).toHaveLength(2);
    expect(matches[0].start).toBeLessThan(matches[1].start);
  });

  it('keeps the longer expression when two registered words overlap', () => {
    const matches = findNgMatches('静かに息を呑んだ。', [
      expression('short', '息を'),
      expression('long', '息を呑んだ'),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0].expressionId).toBe('long');
  });

  it('carries alternatives through so the rewrite prompt can use them', () => {
    const [match] = findNgMatches('瞳を揺らす。', [
      expression('a', '瞳を揺らす', ['視線が泳ぐ']),
    ]);
    expect(match.alternatives).toEqual(['視線が泳ぐ']);
  });

  it('returns nothing for empty text or empty expressions', () => {
    expect(findNgMatches('', [expression('a', '瞳')])).toEqual([]);
    expect(findNgMatches('本文', [])).toEqual([]);
    expect(findNgMatches('本文', [expression('a', '  ')])).toEqual([]);
  });

  it('normalizes phrases the same way on both sides', () => {
    expect(normalizeNgPhrase(' 息を、呑んだ！ ')).toBe(normalizeNgPhrase('息を呑んだ'));
  });
});

describe('ngDetection: findNearMiss', () => {
  it('flags a rewrite that only changed one character', () => {
    const nearMiss = findNearMiss('彼女は瞳を揺らした。', [expression('a', '瞳を揺らす')]);
    expect(nearMiss).not.toBeNull();
    expect(nearMiss?.expressionText).toBe('瞳を揺らす');
  });

  it('accepts a rewrite that replaced the word itself', () => {
    expect(findNearMiss('彼女は視線を泳がせた。', [expression('a', '瞳を揺らす')])).toBeNull();
  });

  it('does not flag very short expressions, where one character means a different word', () => {
    // NOTE: 2文字以下は閾値0。「瞳」と「眸」を近似扱いすると誤検出だらけになる。
    expect(nearMissThreshold(2)).toBe(0);
    expect(findNearMiss('眸が揺れた。', [expression('a', '瞳')])).toBeNull();
  });

  it('scales the tolerance with the length of the expression', () => {
    expect(nearMissThreshold(3)).toBe(1);
    expect(nearMissThreshold(8)).toBe(2);
    expect(nearMissThreshold(12)).toBe(3);
  });

  it('reports the closest match when several windows are near', () => {
    const nearMiss = findNearMiss('息を呑んでいた。息を呑んだ。', [expression('a', '息を呑んだ')]);
    // NOTE: 完全一致は findNgMatches の担当なので、ここでは距離0を返さない。
    expect(nearMiss?.distance).toBeGreaterThan(0);
  });
});

describe('ngDetection: isUnchangedText', () => {
  it('treats punctuation-only differences as unchanged', () => {
    expect(isUnchangedText('息を呑んだ。', '息を、呑んだ')).toBe(true);
    expect(isUnchangedText('息を呑んだ。', '息を止めた。')).toBe(false);
  });
});
