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

const SENTENCE_TERMINATORS = new Set(['。', '！', '？']);
const CLOSING_BRACKETS = new Set(['」', '』', '）', '〕', '］', '】', '〉', '》']);
// NOTE: 局所リライトに投げる一文の上限。これを超える「一文」は句読点が無いだけの
// 長い塊なので、そのまま投げると書き換え幅が大きくなりすぎて再チェックの意味が薄れる。
const MAX_SPAN_LENGTH = 400;
const FALLBACK_MARGIN = 120;
const SOFT_BOUNDARIES = new Set(['、', '，', '　', ' ']);

export interface TextSpan {
  start: number;
  end: number;
}

// NOTE: NG表現が当たった位置を含む一文を取り出す。局所リライトの単位を段落ではなく
// 一文にしているのは、書き換え範囲が広いほど「NGは消えたが別物になった」失敗が増え、
// 決定的な再チェックで弾いても直しどころが定まらなくなるため。
export function extractSentenceSpan(text: string, start: number, end: number): TextSpan {
  let spanStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    const char = text[i];
    if (char === '\n') {
      spanStart = i + 1;
      break;
    }
    if (SENTENCE_TERMINATORS.has(char)) {
      let j = i + 1;
      while (j < start && CLOSING_BRACKETS.has(text[j])) j++;
      spanStart = j;
      break;
    }
  }

  let spanEnd = text.length;
  for (let i = end; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      spanEnd = i;
      break;
    }
    if (SENTENCE_TERMINATORS.has(char)) {
      let j = i + 1;
      while (j < text.length && CLOSING_BRACKETS.has(text[j])) j++;
      spanEnd = j;
      break;
    }
  }

  if (spanEnd - spanStart <= MAX_SPAN_LENGTH) return { start: spanStart, end: spanEnd };
  return narrowSpan(text, { start: spanStart, end: spanEnd }, start, end);
}

// NOTE: 長すぎる一文は当該箇所の前後だけに縮める。読点などの弱い区切りまで
// 寄せてから切ることで、語の途中で切れた断片をモデルに渡さないようにする。
function narrowSpan(text: string, sentence: TextSpan, start: number, end: number): TextSpan {
  let left = Math.max(sentence.start, start - FALLBACK_MARGIN);
  let right = Math.min(sentence.end, end + FALLBACK_MARGIN);

  for (let i = left; i < start; i++) {
    if (SOFT_BOUNDARIES.has(text[i])) {
      left = i + 1;
      break;
    }
  }
  for (let i = right - 1; i >= end; i--) {
    if (SOFT_BOUNDARIES.has(text[i])) {
      right = i + 1;
      break;
    }
  }

  return { start: left, end: right };
}
