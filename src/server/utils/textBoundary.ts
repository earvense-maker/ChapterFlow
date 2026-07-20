const SENTENCE_BOUNDARY_RE = /[。！？][」』）〕］】〉》]*/g;

// NOTE: 末尾から切り出した本文の冒頭にある、途中で始まった文をプロンプトへ渡さない。
// 段落境界を優先することで、短い文末より自然な文脈の始まりを残す。
export function dropLeadingTextToBoundary(text: string): string {
  const paragraphBoundary = text.indexOf('\n');
  if (paragraphBoundary >= 0) {
    const afterParagraph = text.slice(paragraphBoundary + 1);
    if (afterParagraph.trim()) return afterParagraph;
  }

  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  const sentenceBoundary = SENTENCE_BOUNDARY_RE.exec(text);
  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  if (sentenceBoundary) {
    const afterSentence = text.slice(sentenceBoundary.index + sentenceBoundary[0].length);
    if (afterSentence.trim()) return afterSentence;
  }

  return text;
}

// NOTE: 文体見本を上限で切る場合、文の途中で終わらせない。境界がなければ情報を捨てない。
export function trimTrailingTextToSentenceBoundary(text: string): string {
  let lastBoundaryEnd = 0;
  let match: RegExpExecArray | null;

  SENTENCE_BOUNDARY_RE.lastIndex = 0;
  while ((match = SENTENCE_BOUNDARY_RE.exec(text)) !== null) {
    lastBoundaryEnd = match.index + match[0].length;
  }
  SENTENCE_BOUNDARY_RE.lastIndex = 0;

  return lastBoundaryEnd > 0 ? text.slice(0, lastBoundaryEnd) : text;
}
