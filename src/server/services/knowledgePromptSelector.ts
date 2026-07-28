// NOTE: 参考資料・世界設定を「毎回全量」ではなく「今回の文脈に関連する断片」で注入する
// ための、外部APIに依存しないローカル選択器（設計書 4.3）。
//
// ベクトル検索を使わないのは、外部APIへ作品データを出さないこと、オフラインで動くこと、
// 同じ入力から必ず同じ順序が出る（テストできる）ことを優先したため。取りこぼしは
// 「正スコアが無ければ各ファイル先頭チャンクを round-robin」で緩和する。
//
// この module は純関数のみで、共有可変キャッシュを持たない。並行生成でも順序と
// report が揺れないことを保証するため（設計書 10.1）。

import {
  NOVEL_KNOWLEDGE_CHUNK_CHARS,
  NOVEL_KNOWLEDGE_CHUNK_OVERLAP_CHARS,
  NOVEL_KNOWLEDGE_MAX_CHARS,
  NOVEL_KNOWLEDGE_MAX_CHUNKS_PER_FILE,
  NOVEL_WORLD_MAX_CHARS,
  sliceTailByGraphemes,
} from '../prompts/promptBudget.js';
import { splitWorldByConvention } from '../utils/worldMd.js';

export type PromptChunkSource = 'knowledge' | 'world';

export interface PromptChunk {
  source: PromptChunkSource;
  /** knowledgeId、または world の segment 種別。 */
  sourceId: string;
  sourceTitle: string;
  /** 元ファイル内の表示順（ファイル間の tie-break に使う）。 */
  sourceOrder: number;
  /** 直近の Markdown 見出し。無ければ空文字。 */
  heading: string;
  /** ファイル内でのチャンク順。 */
  order: number;
  text: string;
  /** text 先頭のうち、直前チャンクと重複している文字数。 */
  overlapChars: number;
}

export interface PromptChunkQuery {
  /** 人物名・別名など、完全一致を最優先する固有語。 */
  terms: string[];
  /** 今回の希望・作品の核・現在状況・直近本文末尾などの自由文。 */
  text: string;
}

// NOTE: 見出し・タイトルの一致を本文一致より重くする（設計書 4.3）。資料は
// 「見出しで引く辞書」として書かれることが多く、本文の偶然の共起より信頼できる。
const SCORE_TERM_IN_LABEL = 25;
const SCORE_TERM_IN_BODY = 10;
const SCORE_BIGRAM_IN_LABEL = 3;
const SCORE_BIGRAM_IN_BODY = 1;
const SCORE_WORD_IN_LABEL = 5;
const SCORE_WORD_IN_BODY = 2;
// NOTE: 長いチャンクが 2-gram の総当たりで上位を独占しないよう、補助スコアは頭打ちにする。
const MAX_BIGRAM_SCORE = 60;

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(\S.*)$/;
const SENTENCE_SPLIT_RE = /(?<=[。！？][」』）〕］】〉》]*)/;

// --- チャンク化 ---

export function chunkTextForPrompt(input: {
  source: PromptChunkSource;
  sourceId: string;
  sourceTitle: string;
  sourceOrder: number;
  text: string;
  maxChunkChars?: number;
  overlapChars?: number;
}): PromptChunk[] {
  const maxChunkChars = input.maxChunkChars ?? NOVEL_KNOWLEDGE_CHUNK_CHARS;
  const overlapChars = input.overlapChars ?? NOVEL_KNOWLEDGE_CHUNK_OVERLAP_CHARS;
  const normalized = input.text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const units = splitIntoUnits(normalized, maxChunkChars);
  const chunks: PromptChunk[] = [];

  let buffer: string[] = [];
  let bufferChars = 0;
  let bufferHeading = '';
  let pendingOverlap = '';

  const flush = () => {
    if (buffer.length === 0) return;
    const body = buffer.join('\n\n').trim();
    buffer = [];
    bufferChars = 0;
    if (!body) return;
    const text = pendingOverlap ? `${pendingOverlap}\n\n${body}` : body;
    chunks.push({
      source: input.source,
      sourceId: input.sourceId,
      sourceTitle: input.sourceTitle,
      sourceOrder: input.sourceOrder,
      heading: bufferHeading,
      order: chunks.length,
      text,
      overlapChars: pendingOverlap ? pendingOverlap.length + 2 : 0,
    });
    pendingOverlap = overlapChars > 0 ? sliceTailByGraphemes(body, overlapChars) : '';
  };

  for (const unit of units) {
    // 見出しは最優先の境界。見出しをまたいだチャンクは意味の切れ目を壊す。
    if (unit.startsSection && buffer.length > 0) flush();
    if (bufferChars > 0 && bufferChars + unit.text.length + 2 > maxChunkChars) flush();
    if (buffer.length === 0) bufferHeading = unit.heading;
    buffer.push(unit.text);
    bufferChars += unit.text.length + 2;
  }
  flush();

  return chunks;
}

interface TextUnit {
  text: string;
  heading: string;
  startsSection: boolean;
}

function splitIntoUnits(text: string, maxChunkChars: number): TextUnit[] {
  const units: TextUnit[] = [];
  let heading = '';
  let nextStartsSection = false;

  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split('\n');
    const headingMatch = lines[0].match(HEADING_RE);
    if (headingMatch) {
      heading = headingMatch[2].trim();
      nextStartsSection = true;
    }

    for (const piece of splitOversizedBlock(trimmed, maxChunkChars)) {
      units.push({ text: piece, heading, startsSection: nextStartsSection });
      nextStartsSection = false;
    }
  }

  return units;
}

// NOTE: 単一段落が上限を超える場合だけ文境界で割る。文境界も無ければ最後は
// 機械的に切るが、ここへ来るのは句読点の無い長大な塊だけ。
function splitOversizedBlock(block: string, maxChunkChars: number): string[] {
  if (block.length <= maxChunkChars) return [block];

  const pieces: string[] = [];
  let current = '';
  for (const sentence of block.split(SENTENCE_SPLIT_RE)) {
    if (!sentence) continue;
    if (current && current.length + sentence.length > maxChunkChars) {
      pieces.push(current);
      current = '';
    }
    if (sentence.length > maxChunkChars) {
      if (current) {
        pieces.push(current);
        current = '';
      }
      for (let i = 0; i < sentence.length; i += maxChunkChars) {
        pieces.push(sentence.slice(i, i + maxChunkChars));
      }
      continue;
    }
    current += sentence;
  }
  if (current) pieces.push(current);
  return pieces;
}

// --- スコアリング ---

function normalizeForMatch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase();
}

function extractBigrams(value: string): Set<string> {
  const compact = normalizeForMatch(value).replace(/[\s\p{P}\p{S}]+/gu, '');
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < compact.length; i += 1) {
    bigrams.add(compact.slice(i, i + 2));
  }
  return bigrams;
}

function extractAsciiWords(value: string): Set<string> {
  const words = new Set<string>();
  for (const match of normalizeForMatch(value).matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    words.add(match[0]);
  }
  return words;
}

interface CompiledQuery {
  terms: string[];
  bigrams: Set<string>;
  words: Set<string>;
  isEmpty: boolean;
}

export function compilePromptChunkQuery(query: PromptChunkQuery): CompiledQuery {
  const terms = Array.from(
    new Set(
      query.terms
        .map((term) => normalizeForMatch(term).trim())
        .filter((term) => term.length > 0)
    )
  );
  const bigrams = extractBigrams(query.text);
  const words = extractAsciiWords(query.text);
  return {
    terms,
    bigrams,
    words,
    isEmpty: terms.length === 0 && bigrams.size === 0 && words.size === 0,
  };
}

function scoreChunk(chunk: PromptChunk, query: CompiledQuery): number {
  const label = normalizeForMatch(`${chunk.sourceTitle}\n${chunk.heading}`);
  const body = normalizeForMatch(chunk.text);

  let score = 0;
  for (const term of query.terms) {
    if (label.includes(term)) score += SCORE_TERM_IN_LABEL;
    if (body.includes(term)) score += SCORE_TERM_IN_BODY;
  }

  let bigramScore = 0;
  const labelBigrams = extractBigrams(label);
  const bodyBigrams = extractBigrams(body);
  for (const bigram of query.bigrams) {
    if (labelBigrams.has(bigram)) bigramScore += SCORE_BIGRAM_IN_LABEL;
    else if (bodyBigrams.has(bigram)) bigramScore += SCORE_BIGRAM_IN_BODY;
  }
  score += Math.min(bigramScore, MAX_BIGRAM_SCORE);

  const labelWords = extractAsciiWords(label);
  const bodyWords = extractAsciiWords(body);
  for (const word of query.words) {
    if (labelWords.has(word)) score += SCORE_WORD_IN_LABEL;
    else if (bodyWords.has(word)) score += SCORE_WORD_IN_BODY;
  }

  return score;
}

export interface RankedChunk {
  chunk: PromptChunk;
  score: number;
}

/**
 * 参考資料・世界設定で共有するランキング。source 種別ごとの重みは priorityBonus で外から渡す。
 * 同点は「ファイル表示順 → チャンク元順」で安定化する（設計書 4.3）。
 */
export function rankPromptChunks(
  chunks: PromptChunk[],
  query: PromptChunkQuery,
  options: { priorityBonus?: (chunk: PromptChunk) => number } = {}
): RankedChunk[] {
  const compiled = compilePromptChunkQuery(query);
  const bonus = options.priorityBonus ?? (() => 0);
  return chunks
    .map((chunk) => ({
      chunk,
      score: (compiled.isEmpty ? 0 : scoreChunk(chunk, compiled)) + bonus(chunk),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.sourceOrder - b.chunk.sourceOrder ||
        a.chunk.order - b.chunk.order
    );
}

// --- 選択 ---

export interface ChunkSelectionResult {
  selected: PromptChunk[];
  /** 選択されなかったチャンク数。report へは件数だけ載せる。 */
  omittedCount: number;
  totalCount: number;
  selectedChars: number;
}

const chunkKey = (chunk: PromptChunk) => `${chunk.sourceId}#${chunk.order}`;

/** 描画時に実際に出力される文字数。overlap は直前チャンクも採用済みのときだけ落ちる。 */
function renderedCost(chunk: PromptChunk, selectedKeys: Set<string>): number {
  const predecessorSelected = selectedKeys.has(`${chunk.sourceId}#${chunk.order - 1}`);
  return predecessorSelected ? chunk.text.length - chunk.overlapChars : chunk.text.length;
}

function selectRanked(
  ranked: RankedChunk[],
  options: { maxChars: number; maxPerSource: number; requirePositiveScore: boolean }
): PromptChunk[] {
  const perSource = new Map<string, number>();
  const selectedKeys = new Set<string>();
  const selected: PromptChunk[] = [];
  let total = 0;

  for (const { chunk, score } of ranked) {
    if (options.requirePositiveScore && score <= 0) continue;
    const used = perSource.get(chunk.sourceId) ?? 0;
    if (used >= options.maxPerSource) continue;
    // NOTE: overlap を無条件に引くと、非隣接チャンクを選んだときに実描画より
    // 小さく見積もって上限を超える（レビュー指摘 P2-4）。直前チャンクが既に
    // 採用済みのときだけ引く。あとから直前チャンクが加わる場合は実描画が
    // 縮むだけなので、この見積もりが上限を割ることはない。
    const cost = renderedCost(chunk, selectedKeys);
    if (total + cost > options.maxChars) continue;
    selected.push(chunk);
    selectedKeys.add(chunkKey(chunk));
    perSource.set(chunk.sourceId, used + 1);
    total += cost;
  }

  return selected;
}

/** 採用結果を描画したときの実文字数。report の selectedChars はこれを使う。 */
function renderedTotalChars(chunks: PromptChunk[]): number {
  const keys = new Set(chunks.map(chunkKey));
  return chunks.reduce((sum, chunk) => sum + renderedCost(chunk, keys), 0);
}

function sortForRender(chunks: PromptChunk[]): PromptChunk[] {
  return [...chunks].sort(
    (a, b) => a.sourceOrder - b.sourceOrder || a.order - b.order
  );
}

export function selectKnowledgeChunksForPrompt(
  files: Array<{ knowledgeId?: string; title: string; content: string }>,
  query: PromptChunkQuery,
  options: { maxChars?: number; maxChunksPerFile?: number } = {}
): ChunkSelectionResult {
  const maxChars = options.maxChars ?? NOVEL_KNOWLEDGE_MAX_CHARS;
  const maxPerSource = options.maxChunksPerFile ?? NOVEL_KNOWLEDGE_MAX_CHUNKS_PER_FILE;

  const chunks = files.flatMap((file, index) =>
    chunkTextForPrompt({
      source: 'knowledge',
      sourceId: file.knowledgeId ?? `kb-index-${index}`,
      sourceTitle: file.title,
      sourceOrder: index,
      text: file.content,
    })
  );
  if (chunks.length === 0) {
    return { selected: [], omittedCount: 0, totalCount: 0, selectedChars: 0 };
  }

  const ranked = rankPromptChunks(chunks, query);
  let selected = selectRanked(ranked, {
    maxChars,
    maxPerSource,
    requirePositiveScore: true,
  });

  // NOTE: 一致ゼロで全資料が消えると「使用中にしたのに何も入らない」状態になる。
  // 各ファイルの先頭チャンクを round-robin で拾い、最低限の存在は残す。
  if (selected.length === 0) {
    selected = selectRanked(
      chunks
        .filter((chunk) => chunk.order === 0)
        .map((chunk) => ({ chunk, score: 0 }))
        .sort((a, b) => a.chunk.sourceOrder - b.chunk.sourceOrder),
      { maxChars, maxPerSource: 1, requirePositiveScore: false }
    );
  }

  return {
    selected: sortForRender(selected),
    omittedCount: chunks.length - selected.length,
    totalCount: chunks.length,
    selectedChars: renderedTotalChars(selected),
  };
}

/**
 * 世界設定は参考資料と同じファイル単位では扱わない。splitWorldByConvention の
 * 「世界の土台 / 開始時点の状況」を正本とし、長い segment だけ内部チャンク化する（設計書 4.3）。
 */
export function selectWorldChunksForPrompt(
  worldText: string,
  query: PromptChunkQuery,
  options: { maxChars?: number } = {}
): ChunkSelectionResult {
  const maxChars = options.maxChars ?? NOVEL_WORLD_MAX_CHARS;
  const segments = splitWorldByConvention(worldText);
  if (segments.length === 0) {
    return { selected: [], omittedCount: 0, totalCount: 0, selectedChars: 0 };
  }

  const chunks = segments.flatMap((segment, index) =>
    chunkTextForPrompt({
      source: 'world',
      sourceId: segment.kind === 'initial' ? 'world-initial' : 'world-foundation',
      sourceTitle: segment.kind === 'initial' ? '開始時点の状況' : '世界の土台',
      sourceOrder: index,
      text: segment.content,
    })
  );
  if (chunks.length === 0) {
    return { selected: [], omittedCount: 0, totalCount: 0, selectedChars: 0 };
  }

  // NOTE: 「世界の土台」は作品の核に近い恒常設定なので高優先。「開始時点の状況」は
  // 採用済み本文・現在状態と競合し得るため一段低く扱う（設計書 4.3）。
  const ranked = rankPromptChunks(chunks, query, {
    priorityBonus: (chunk) => (chunk.sourceId === 'world-foundation' ? 8 : 0),
  });
  const selected = selectRanked(ranked, {
    maxChars,
    maxPerSource: Number.POSITIVE_INFINITY,
    requirePositiveScore: false,
  });

  return {
    selected: sortForRender(selected),
    omittedCount: chunks.length - selected.length,
    totalCount: chunks.length,
    selectedChars: renderedTotalChars(selected),
  };
}

/**
 * 隣接する2チャンクを両方採用した場合だけ、後続チャンク先頭の既知 overlap を除いて描画する。
 * 非隣接チャンクや別ファイル間で曖昧な類似判定はしない（設計書 4.3）。
 */
export function renderChunkBody(chunk: PromptChunk, previous: PromptChunk | null): string {
  const isAdjacent =
    previous !== null &&
    previous.sourceId === chunk.sourceId &&
    previous.order === chunk.order - 1;
  if (!isAdjacent || chunk.overlapChars <= 0) return chunk.text;
  return chunk.text.slice(chunk.overlapChars);
}
