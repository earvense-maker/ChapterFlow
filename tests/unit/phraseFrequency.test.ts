import { describe, expect, it } from 'vitest';
import { extractFrequentPhrases, ANALYZE_MAX_CHARS } from '../../src/server/utils/phraseFrequency';

describe('extractFrequentPhrases', () => {
  it('counts repeated phrases', () => {
    const text = '彼女は息を呑んだ。彼女は息を呑んだ。彼女は息を呑んだ。';
    const phrases = extractFrequentPhrases(text);
    const found = phrases.find((p) => p.text === '彼女は息を呑んだ');
    expect(found).toBeDefined();
    expect(found!.count).toBe(3);
  });

  it('does not count phrases across segment boundaries', () => {
    const text = '文章の一部。bbbb。文章の一部。bbbb。文章の一部。bbbb。';
    const phrases = extractFrequentPhrases(text);
    // '文章の一部' appears 3 times and should be kept
    expect(phrases.some((p) => p.text === '文章の一部')).toBe(true);
    // cross-segment combination never appears
    expect(phrases.some((p) => p.text === '文章の一部bbbb')).toBe(false);
  });

  it('filters short hiragana-only phrases', () => {
    const text =
      'これは常識である。これは常識である。これは常識である。';
    const phrases = extractFrequentPhrases(text);
    expect(phrases.some((p) => p.text === 'という')).toBe(false);
    expect(phrases.some((p) => p.text === 'これは常識である')).toBe(true);
  });

  it('keeps longer hiragana phrases', () => {
    const text =
      'まるで夢のように。まるで夢のように。まるで夢のように。';
    const phrases = extractFrequentPhrases(text);
    expect(phrases.some((p) => p.text === 'まるで夢のように')).toBe(true);
  });

  it('filters digit/ascii-only phrases', () => {
    const text = '1234 1234 1234 1234';
    const phrases = extractFrequentPhrases(text);
    expect(phrases).toHaveLength(0);
  });

  it('absorbs shorter phrases into longer ones with same count', () => {
    const text = '息を呑んだ。息を呑んだ。息を呑んだ。';
    const phrases = extractFrequentPhrases(text);
    expect(phrases.some((p) => p.text === '息を呑んだ')).toBe(true);
    expect(phrases.some((p) => p.text === '息を呑ん')).toBe(false);
  });

  it('sorts by score descending', () => {
    const text =
      '長い表現の繰り返し。長い表現の繰り返し。長い表現の繰り返し。' +
      '短文です。短文です。短文です。短文です。短文です。';
    const phrases = extractFrequentPhrases(text);
    expect(phrases[0].text).toBe('長い表現の繰り返し');
  });

  it('limits to 30 items', () => {
    let text = '';
    for (let i = 0; i < 40; i++) {
      text += `${'a'.repeat(4 + i)} `.repeat(3);
    }
    const phrases = extractFrequentPhrases(text);
    expect(phrases.length).toBeLessThanOrEqual(30);
  });

  it('analyzes only the trailing ANALYZE_MAX_CHARS', () => {
    const repeated = '繰り返しフレーズ。'.repeat(3);
    const filler = 'a'.repeat(ANALYZE_MAX_CHARS);
    const text = filler + repeated;
    const phrases = extractFrequentPhrases(text);
    expect(phrases.some((p) => p.text.includes('a'))).toBe(false);
    expect(phrases.some((p) => p.text === '繰り返しフレーズ')).toBe(true);
  });
});
