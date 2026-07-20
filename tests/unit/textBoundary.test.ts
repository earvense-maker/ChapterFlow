import { describe, expect, it } from 'vitest';
import {
  dropLeadingTextToBoundary,
  trimTrailingTextToSentenceBoundary,
} from '../../src/server/utils/textBoundary';

describe('dropLeadingTextToBoundary', () => {
  it('prefers the first paragraph boundary over an earlier sentence boundary', () => {
    expect(dropLeadingTextToBoundary('途中の文。まだ同じ段落。\n次の段落から。')).toBe('次の段落から。');
  });

  it('drops through the first sentence boundary and closing quote when no paragraph exists', () => {
    expect(dropLeadingTextToBoundary('途中の発話。」次の文。')).toBe('次の文。');
  });

  it('keeps text unchanged when no usable boundary exists', () => {
    expect(dropLeadingTextToBoundary('境界のない短文')).toBe('境界のない短文');
    expect(dropLeadingTextToBoundary('\n')).toBe('\n');
  });
});

describe('trimTrailingTextToSentenceBoundary', () => {
  it('keeps text through its last complete sentence boundary', () => {
    expect(trimTrailingTextToSentenceBoundary('最初の文。二つ目の文！途中')).toBe('最初の文。二つ目の文！');
  });

  it('keeps short or boundary-free text unchanged', () => {
    expect(trimTrailingTextToSentenceBoundary('短い文。')).toBe('短い文。');
    expect(trimTrailingTextToSentenceBoundary('途中')).toBe('途中');
  });
});
