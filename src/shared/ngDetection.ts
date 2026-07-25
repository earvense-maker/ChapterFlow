// NOTE: NG表現は生成プロンプトへ注入しない。注入すると語そのものが文脈に乗って
// 「〜ではなく」のような否定形で本文へ漏れるため。代わりに出力後の文字列一致で
// 検出し、当たった箇所だけを局所リライトする。したがって検出規則はここが唯一の
// 正本で、Reader のハイライトとサーバーのリライト再チェックが同じ関数を共有する。

export interface NgExpressionLike {
  id: string;
  text: string;
  alternatives?: string[];
}

export interface NgMatch {
  expressionId: string;
  expressionText: string;
  alternatives: string[];
  /** 元テキスト上の開始位置（この位置の文字を含む） */
  start: number;
  /** 元テキスト上の終了位置（この位置の文字は含まない） */
  end: number;
}

export interface NormalizedNgText {
  normalized: string;
  /** normalized[i] の由来となった元テキストの開始位置 */
  starts: number[];
  /** normalized[i] の由来となった元テキストの終了位置 */
  ends: number[];
}

// NOTE: 空白・約物・記号は落とす。「瞳を、揺らす」を「瞳を揺らす」で拾いたいため。
const IGNORED_CHAR_RE = /^[\s\p{P}\p{S}]$/u;

// NOTE: 文字単位で NFKC する。文字列全体を一括正規化すると長さが変わって元本文の
// 位置と対応づけられず、ハイライト範囲も置換範囲も出せなくなる。半角カナ＋濁点の
// ような結合列だけは一括正規化と結果が変わるが、本文が日本語小説である前提で許容する。
export function normalizeForNgMatch(text: string): NormalizedNgText {
  let normalized = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;

  for (const char of text) {
    const start = index;
    index += char.length;
    const folded = char.normalize('NFKC').toLocaleLowerCase();
    for (const piece of folded) {
      if (IGNORED_CHAR_RE.test(piece)) continue;
      normalized += piece;
      starts.push(start);
      ends.push(index);
    }
  }

  return { normalized, starts, ends };
}

export function normalizeNgPhrase(text: string): string {
  return normalizeForNgMatch(text).normalized;
}

export function findNgMatches(
  text: string,
  expressions: readonly NgExpressionLike[]
): NgMatch[] {
  if (!text || expressions.length === 0) return [];
  const { normalized, starts, ends } = normalizeForNgMatch(text);
  if (!normalized) return [];

  const candidates: NgMatch[] = [];
  for (const expression of expressions) {
    const needle = normalizeNgPhrase(expression.text);
    if (!needle) continue;
    let from = 0;
    for (;;) {
      const hit = normalized.indexOf(needle, from);
      if (hit < 0) break;
      candidates.push({
        expressionId: expression.id,
        expressionText: expression.text,
        alternatives: expression.alternatives ?? [],
        start: starts[hit],
        end: ends[hit + needle.length - 1],
      });
      // NOTE: +1 で進めるのは重なった出現も一度は候補に入れるため。実際に採用する
      // かどうかは後段の重なり解決で決める。
      from = hit + 1;
    }
  }

  // NOTE: 同じ箇所に複数の登録語が当たったら長い方だけを残す。短い語のハイライトが
  // 長い語のハイライトを分断すると、どの登録語に当たったのか画面から読めなくなる。
  candidates.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));

  const resolved: NgMatch[] = [];
  for (const match of candidates) {
    const previous = resolved[resolved.length - 1];
    if (previous && match.start < previous.end) continue;
    resolved.push(match);
  }
  return resolved;
}

export function hasNgMatch(text: string, expressions: readonly NgExpressionLike[]): boolean {
  return findNgMatches(text, expressions).length > 0;
}

export interface NgNearMiss {
  expressionText: string;
  /** 元テキストのうち、登録語とほぼ同じだと判定された部分 */
  matchedText: string;
  distance: number;
}

// NOTE: 「瞳が揺れる」を「瞳が揺れた」にするような、一音だけ変えて実質同じ表現を
// 残す逃げ方を弾くための閾値。短い語ほど1文字の違いが本当の別語である確率が高い
// ので、絶対長で段階を分ける。0 を返した語は近似判定の対象外（完全一致だけを見る）。
export function nearMissThreshold(phraseLength: number): number {
  if (phraseLength <= 2) return 0;
  if (phraseLength <= 3) return 1;
  return Math.max(1, Math.floor(phraseLength * 0.25));
}

// NOTE: 完全一致は findNgMatches が捕まえるので、ここは distance > 0 の帯だけを見る。
// 「ほぼ同じだが完全一致ではない」表現を検出する。
export function findNearMiss(
  text: string,
  expressions: readonly NgExpressionLike[]
): NgNearMiss | null {
  if (!text || expressions.length === 0) return null;
  const { normalized, starts, ends } = normalizeForNgMatch(text);
  if (!normalized) return null;

  let best: NgNearMiss | null = null;

  for (const expression of expressions) {
    const needle = normalizeNgPhrase(expression.text);
    if (!needle) continue;
    const threshold = nearMissThreshold(needle.length);
    if (threshold < 1) continue;

    const minWindow = Math.max(1, needle.length - threshold);
    const maxWindow = needle.length + threshold;

    for (let start = 0; start < normalized.length; start++) {
      for (let size = minWindow; size <= maxWindow; size++) {
        const end = start + size;
        if (end > normalized.length) break;
        const distance = boundedLevenshtein(needle, normalized.slice(start, end), threshold);
        if (distance <= 0 || distance > threshold) continue;
        if (best && best.distance <= distance) continue;
        best = {
          expressionText: expression.text,
          matchedText: text.slice(starts[start], ends[end - 1]),
          distance,
        };
      }
    }
  }

  return best;
}

export function isUnchangedText(before: string, after: string): boolean {
  return normalizeNgPhrase(before) === normalizeNgPhrase(after);
}

// NOTE: limit を超えた時点で打ち切る。近似判定は窓を総当たりするので、
// 見込みのない窓を最後まで計算しないことが効いてくる。
function boundedLevenshtein(a: string, b: string, limit: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      if (current[j] < rowMin) rowMin = current[j];
    }
    if (rowMin > limit) return limit + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length];
}
