export const ANALYZE_MAX_CHARS = 50_000;
const MIN_COUNT = 3;
const MAX_REPORT_ITEMS = 30;
const MIN_N = 4;
const MAX_N = 10;
const SEGMENT_DELIMITER_RE = /[。、・「」『』！？\n]+/;
const WHITESPACE_RE = /\s+/g;

export interface PhraseFrequencyItem {
  text: string;
  count: number;
  score: number;
}

export function extractFrequentPhrases(text: string): PhraseFrequencyItem[] {
  const trimmed = text.slice(-ANALYZE_MAX_CHARS);
  const segments = trimmed
    .split(SEGMENT_DELIMITER_RE)
    .map((s) => s.replace(WHITESPACE_RE, ' ').trim())
    .filter((s) => s.length >= MIN_N);

  const counts = new Map<string, number>();

  for (const segment of segments) {
    const len = segment.length;
    for (let n = MIN_N; n <= MAX_N && n <= len; n++) {
      for (let i = 0; i <= len - n; i++) {
        const phrase = segment.slice(i, i + n);
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
      }
    }
  }

  const candidates: PhraseFrequencyItem[] = [];
  for (const [phrase, count] of counts.entries()) {
    if (count < MIN_COUNT) continue;
    if (isHiraganaOnly(phrase) && phrase.length < 5) continue;
    if (isSymbolOrAsciiOnly(phrase)) continue;
    candidates.push({ text: phrase, count, score: count * (phrase.length - 2) });
  }

  const maximized = candidates.filter((candidate) => {
    for (const other of candidates) {
      if (other === candidate) continue;
      if (other.count !== candidate.count) continue;
      if (other.text.length <= candidate.text.length) continue;
      if (other.text.includes(candidate.text)) return false;
    }
    return true;
  });

  maximized.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.count !== a.count) return b.count - a.count;
    return b.text.length - a.text.length;
  });

  return maximized.slice(0, MAX_REPORT_ITEMS);
}

function isHiraganaOnly(text: string): boolean {
  return /^\p{Script=Hiragana}+$/u.test(text);
}

function isSymbolOrAsciiOnly(text: string): boolean {
  // 数字・英字・記号・空白のみで構成される表現は、本文表現としての価値が低いため除外
  return /^[0-9A-Za-z０-９ａ-ｚＡ-Ｚ\s\p{P}\p{S}]+$/u.test(text);
}
