// NOTE: プロンプト予算の一次制御（文字数）と二次制御（トークン）の純関数群（設計書 3.1〜3.2、4.1）。
// 保存上限とは別に「1回の生成で採用する量」をここで決める。保存済みデータは書き換えない。
//
// 文字数はすべて UTF-16 code unit（String.length）で数える。表示上の見た目文字数とは
// 一致しないが、切り詰め位置は grapheme 境界へ丸めるため壊れた文字は作らない。

import {
  dropLeadingTextToBoundary,
  trimTrailingTextToSentenceBoundary,
} from '../utils/textBoundary.js';
import type {
  PromptBudgetAction,
  PromptBudgetEntry,
  PromptBudgetReport,
} from '../../shared/types/generation.js';

export type { PromptBudgetAction, PromptBudgetEntry, PromptBudgetReport };

// --- 小説の予算定数（設計書 4.1） ---

/** system + user の絶対一次上限。安全性は二次トークン確認で担保する。 */
export const NOVEL_TOTAL_PROMPT_MAX_CHARS = 80_000;
export const NOVEL_SYSTEM_PROMPT_MAX_CHARS = 24_000;
export const NOVEL_USER_PROMPT_MAX_CHARS = 56_000;

export const NOVEL_BASE_PROMPT_MAX_CHARS = 12_000;
export const NOVEL_BASE_PROMPT_MIN_CHARS = 4_000;
export const NOVEL_CUSTOM_PROMPT_MAX_CHARS = 8_000;
export const NOVEL_CUSTOM_PROMPT_MIN_CHARS = 2_000;
/** 選択された小説プリセット全体の実行時上限。 */
export const NOVEL_PRESET_MAX_CHARS = 4_000;
/** 非空の選択プリセット1件ごとの最低予約（見出し・省略マーカー込み）。 */
export const NOVEL_PRESET_MIN_CHARS = 256;
/** system内の見出し・区切り・改行の予約。 */
export const NOVEL_SYSTEM_SEPARATOR_RESERVE = 512;

export const NOVEL_WORLD_MAX_CHARS = 8_000;
export const NOVEL_KNOWLEDGE_MAX_CHARS = 16_000;
export const NOVEL_KNOWLEDGE_CHUNK_CHARS = 1_600;
export const NOVEL_KNOWLEDGE_CHUNK_OVERLAP_CHARS = 120;
export const NOVEL_KNOWLEDGE_MAX_CHUNKS_PER_FILE = 4;

/** 直近本文は末尾のこの量までは必須節として守る（設計書 4.2）。 */
export const NOVEL_RECENT_CONTEXT_MIN_CHARS = 4_000;

// --- 切り詰め ---

export const PROMPT_OMISSION_MARKER = '…（プロンプト予算のため一部省略）';

// NOTE: 段落・文境界へ寄せた結果が短くなりすぎるなら、境界を諦めて grapheme 境界で切る。
// 「境界優先」で情報量を大きく失う方が、途中で切れるより害が大きいケースがあるため。
const BOUNDARY_KEEP_RATIO = 0.5;

let graphemeSegmenter: Intl.Segmenter | null | undefined;

function getGraphemeSegmenter(): Intl.Segmenter | null {
  if (graphemeSegmenter !== undefined) return graphemeSegmenter;
  graphemeSegmenter =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('ja', { granularity: 'grapheme' })
      : null;
  return graphemeSegmenter;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 先頭から maxChars 以内で grapheme 境界へ丸めて切る。 */
export function sliceHeadByGraphemes(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const segmenter = getGraphemeSegmenter();
  if (!segmenter) {
    // NOTE: Intl.Segmenter が無い環境でも、最低限サロゲートペアだけは割らない。
    const end = isLowSurrogate(text.charCodeAt(maxChars)) ? maxChars - 1 : maxChars;
    return text.slice(0, Math.max(0, end));
  }

  let end = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (end + segment.length > maxChars) break;
    end += segment.length;
  }
  return text.slice(0, end);
}

/** 末尾から maxChars 以内で grapheme 境界へ丸めて切る。 */
export function sliceTailByGraphemes(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;

  const segmenter = getGraphemeSegmenter();
  if (!segmenter) {
    const start = text.length - maxChars;
    const safeStart = isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start;
    return text.slice(safeStart);
  }

  for (const { index } of segmenter.segment(text)) {
    if (text.length - index <= maxChars) return text.slice(index);
  }
  return '';
}

export interface TruncateResult {
  text: string;
  action: Extract<PromptBudgetAction, 'full' | 'truncated' | 'omitted'>;
  originalChars: number;
  includedChars: number;
}

/**
 * 先頭から maxChars へ収める。省略マーカーはこの maxChars の内側に収める。
 * 段落境界 → 文境界 → 行境界 → grapheme 境界の順に寄せる。
 */
export function truncateHeadToBudget(body: string, maxChars: number): TruncateResult {
  const originalChars = body.length;
  if (originalChars === 0) {
    return { text: '', action: 'full', originalChars: 0, includedChars: 0 };
  }
  if (originalChars <= maxChars) {
    return { text: body, action: 'full', originalChars, includedChars: originalChars };
  }
  // マーカーすら入らない枠は、断片を残すより省略した方が誤読が少ない。
  if (maxChars <= PROMPT_OMISSION_MARKER.length) {
    return { text: '', action: 'omitted', originalChars, includedChars: 0 };
  }

  const allowance = maxChars - PROMPT_OMISSION_MARKER.length;
  const head = sliceHeadByGraphemes(body, allowance);
  const kept = preferTrailingBoundary(head, allowance);
  const text = `${kept.trimEnd()}${PROMPT_OMISSION_MARKER}`;
  return { text, action: 'truncated', originalChars, includedChars: text.length };
}

/** 末尾優先（直近本文・会話履歴）で maxChars へ収める。 */
export function truncateTailToBudget(body: string, maxChars: number): TruncateResult {
  const originalChars = body.length;
  if (originalChars === 0) {
    return { text: '', action: 'full', originalChars: 0, includedChars: 0 };
  }
  if (originalChars <= maxChars) {
    return { text: body, action: 'full', originalChars, includedChars: originalChars };
  }
  if (maxChars <= PROMPT_OMISSION_MARKER.length) {
    return { text: '', action: 'omitted', originalChars, includedChars: 0 };
  }

  const allowance = maxChars - PROMPT_OMISSION_MARKER.length;
  const tail = sliceTailByGraphemes(body, allowance);
  const kept = dropLeadingTextToBoundary(tail);
  // NOTE: 先頭側を落として文脈の切れ目を作ったことは、末尾ではなく先頭で伝える。
  const text = `${PROMPT_OMISSION_MARKER}\n${kept.trimStart()}`;
  if (text.length > maxChars) {
    const retrimmed = sliceTailByGraphemes(kept.trimStart(), maxChars - PROMPT_OMISSION_MARKER.length - 1);
    const fallback = `${PROMPT_OMISSION_MARKER}\n${retrimmed}`;
    return { text: fallback, action: 'truncated', originalChars, includedChars: fallback.length };
  }
  return { text, action: 'truncated', originalChars, includedChars: text.length };
}

function preferTrailingBoundary(head: string, allowance: number): string {
  const minKeep = Math.floor(allowance * BOUNDARY_KEEP_RATIO);

  const paragraphEnd = head.lastIndexOf('\n\n');
  if (paragraphEnd >= minKeep) return head.slice(0, paragraphEnd);

  const sentence = trimTrailingTextToSentenceBoundary(head);
  if (sentence.length >= minKeep && sentence.length < head.length) return sentence;

  const lineEnd = head.lastIndexOf('\n');
  if (lineEnd >= minKeep) return head.slice(0, lineEnd);

  return head;
}

// --- セクション配分 ---

export interface BudgetSectionInput {
  sectionId: string;
  /** 切り詰め対象の本文。空文字なら配分対象にしない。 */
  body: string;
  /**
   * body を最終ブロックへ整形する（見出し・`<data>` ラッパなど）。
   *
   * 切り詰めは body に対して行い、整形はそのあとに行う。整形済み文字列をそのまま
   * 切ると `</data>` の閉じタグごと落ちて区画が開きっぱなしになり、後続セクションが
   * データとして読まれてしまうため。hardMax / minReserve は整形後の長さで数える。
   */
  render?: (body: string) => string;
  /**
   * 分割不可能な描画済みブロックの並び。指定すると body の文字単位ではなく、
   * 収まらないユニットを末尾から丸ごと落として予算へ合わせる。
   *
   * 複数のデータブロックを持つセクション（参考資料・世界設定）で使う。文字単位で
   * 切ると途中のブロックの `</data>` が落ちて区画が開きっぱなしになるため。
   * units[0] は見出し・但し書きに使う想定で、これが入らなければセクションごと省略する。
   */
  units?: string[];
  /** このセクション単体の実行時上限（整形後ブロック全体の文字数）。 */
  hardMax: number;
  /** 最低予約。hardMax と同値にすると「全文（hardMax まで）」の意味になる。 */
  minReserve: number;
  /** true なら最低予約を外さない。外せない分で総枠を超えたら overflow を返す。 */
  required?: boolean;
  /** 末尾優先で切り詰める（直近本文・会話履歴）。 */
  keepTail?: boolean;
}

// NOTE: render('') は空本文でブロックごと省略する実装があるため overhead 計測に使えない。
// 1文字だけ渡して差分を取る。
function renderOverhead(section: BudgetSectionInput): number {
  if (!section.render) return 0;
  return Math.max(0, section.render('x').length - 1);
}

function renderSection(section: BudgetSectionInput, body: string): string {
  return section.render ? section.render(body) : body;
}

// NOTE: 引用描画は行ごとに `> ` を足すので、本文を N 字に切っても整形後は N + 2×行数 になる。
// 固定の overhead を引くだけでは足りないため、整形後の超過分を本文枠から引いて収束させる。
// render は任意の関数なので、行数を数える式ではなく実測で詰める。
const RENDER_FIT_ATTEMPTS = 8;

const UNIT_SEPARATOR = '\n\n';

/** ユニット単位で予算へ合わせる。文字の途中でも、ブロックの途中でも切らない。 */
function fitUnitsToBudget(units: string[], budget: number): TruncateResult {
  const full = units.join(UNIT_SEPARATOR);
  const originalChars = full.length;
  if (originalChars <= budget) {
    return { text: full, action: 'full', originalChars, includedChars: originalChars };
  }

  // 省略した事実は必ず残す。マーカーぶんを先に確保してからユニットを積む。
  const reserve = PROMPT_OMISSION_MARKER.length + UNIT_SEPARATOR.length;
  const kept: string[] = [];
  let used = 0;
  for (const unit of units) {
    const cost = kept.length === 0 ? unit.length : unit.length + UNIT_SEPARATOR.length;
    if (used + cost + reserve > budget) break;
    kept.push(unit);
    used += cost;
  }

  // 見出しすら入らないなら、断片を残すより省略した方が誤読が少ない。
  if (kept.length === 0) {
    return { text: '', action: 'omitted', originalChars, includedChars: 0 };
  }
  const text = `${kept.join(UNIT_SEPARATOR)}${UNIT_SEPARATOR}${PROMPT_OMISSION_MARKER}`;
  return { text, action: 'truncated', originalChars, includedChars: text.length };
}

function truncateWithinRenderedBudget(
  section: BudgetSectionInput,
  renderedBudget: number
): TruncateResult {
  if (section.units) return fitUnitsToBudget(section.units, renderedBudget);
  const truncate = section.keepTail ? truncateTailToBudget : truncateHeadToBudget;
  let bodyBudget = renderedBudget - renderOverhead(section);
  let result = truncate(section.body, bodyBudget);

  for (let attempt = 0; attempt < RENDER_FIT_ATTEMPTS; attempt += 1) {
    const rendered = result.text ? renderSection(section, result.text) : '';
    const over = rendered.length - renderedBudget;
    if (over <= 0) return result;
    bodyBudget -= over;
    if (bodyBudget <= 0) {
      return { ...result, text: '', action: 'omitted', includedChars: 0 };
    }
    result = truncate(section.body, bodyBudget);
  }
  return result;
}

export interface AllocatedSection {
  sectionId: string;
  text: string;
  entry: PromptBudgetEntry;
}

export interface AllocateSectionBudgetResult {
  sections: AllocatedSection[];
  entries: PromptBudgetEntry[];
  assembledChars: number;
  /** 必須節の最低予約だけで totalMax を超えた分。0 なら収まっている。 */
  overflowByChars: number;
  /**
   * sectionId ごとに配分した文字枠。省略されたセクションは含まない。
   * グループへ配った枠を、さらにその内側で再配分する（プリセット等）ために公開する。
   */
  allocations: Map<string, number>;
  /**
   * 必須節の最低予約合計。呼び出し側が「これ以上は縮められない下限」として使う。
   * トークン超過時の再縮小で、無意味に小さい予算を試し続けないための歯止め。
   */
  requiredChars: number;
}

/**
 * 「最低予約を先に確保 → 残りを優先順に hard max まで拡張」で配分する（設計書 4.1 / 5.1）。
 *
 * serial append + break と違い、高優先項目が長くても後続セクションが無言で全消失しない。
 * 予約を外す順は reserveOrder の後ろから。拡張順は expandOrder（省略時は reserveOrder）。
 */
export function allocateSectionBudget(input: {
  sections: BudgetSectionInput[];
  totalMax: number;
  reserveOrder?: readonly string[];
  expandOrder?: readonly string[];
}): AllocateSectionBudgetResult {
  const present = input.sections.filter((section) => section.body.length > 0);
  const byId = new Map(present.map((section) => [section.sectionId, section]));
  const reserveOrder = orderSections(present, input.reserveOrder);
  const expandOrder = orderSections(present, input.expandOrder ?? input.reserveOrder);

  // 整形後の長さで予算を数える。overhead（見出し・タグ）は必ず確保する。
  const fullLengthOf = (section: BudgetSectionInput) =>
    section.units
      ? section.units.join(UNIT_SEPARATOR).length
      : renderSection(section, section.body).length;
  const capOf = (section: BudgetSectionInput) =>
    Math.min(fullLengthOf(section), section.hardMax);
  const minOf = (section: BudgetSectionInput) => Math.min(section.minReserve, capOf(section));

  const allocations = new Map<string, number>();
  let requiredTotal = 0;
  for (const section of present) {
    if (!section.required) continue;
    const min = minOf(section);
    allocations.set(section.sectionId, min);
    requiredTotal += min;
  }

  if (requiredTotal > input.totalMax) {
    return {
      sections: [],
      entries: [],
      assembledChars: 0,
      overflowByChars: requiredTotal - input.totalMax,
      allocations: new Map(),
      requiredChars: requiredTotal,
    };
  }

  // 最低予約が収まらない場合は、優先順位の低い側から予約ごと外す。
  const optional = reserveOrder.filter((id) => !byId.get(id)!.required);
  const kept: string[] = [...optional];
  let optionalTotal = optional.reduce((sum, id) => sum + minOf(byId.get(id)!), 0);
  while (kept.length > 0 && requiredTotal + optionalTotal > input.totalMax) {
    const dropped = kept.pop()!;
    optionalTotal -= minOf(byId.get(dropped)!);
  }
  const keptSet = new Set(kept);
  for (const id of kept) allocations.set(id, minOf(byId.get(id)!));

  let remaining = input.totalMax - requiredTotal - optionalTotal;
  for (const id of expandOrder) {
    if (remaining <= 0) break;
    const section = byId.get(id)!;
    if (!section.required && !keptSet.has(id)) continue;
    const current = allocations.get(id) ?? 0;
    const grow = Math.min(capOf(section) - current, remaining);
    if (grow <= 0) continue;
    allocations.set(id, current + grow);
    remaining -= grow;
  }

  const sections: AllocatedSection[] = [];
  const entries: PromptBudgetEntry[] = [];
  let assembledChars = 0;

  // 描画順（入力順）で結果を返す。予約・拡張の優先順は配分だけに使う。
  for (const section of present) {
    const allocated = allocations.get(section.sectionId);
    if (allocated === undefined) {
      entries.push({
        sectionId: section.sectionId,
        originalChars: section.body.length,
        includedChars: 0,
        action: 'omitted',
      });
      continue;
    }
    const truncated = truncateWithinRenderedBudget(section, allocated);
    // units は描画済みなので再整形しない。
    const text =
      truncated.text && !section.units ? renderSection(section, truncated.text) : truncated.text;
    entries.push({
      sectionId: section.sectionId,
      originalChars: fullLengthOf(section),
      includedChars: text.length,
      action: truncated.action,
    });
    if (!text) continue;
    sections.push({ sectionId: section.sectionId, text, entry: entries[entries.length - 1] });
    assembledChars += text.length;
  }

  return {
    sections,
    entries,
    assembledChars,
    overflowByChars: 0,
    allocations,
    requiredChars: requiredTotal,
  };
}

function orderSections(
  sections: BudgetSectionInput[],
  order: readonly string[] | undefined
): string[] {
  if (!order) return sections.map((section) => section.sectionId);
  const present = new Set(sections.map((section) => section.sectionId));
  const ordered = order.filter((id) => present.has(id));
  const seen = new Set(ordered);
  for (const section of sections) {
    if (!seen.has(section.sectionId)) ordered.push(section.sectionId);
  }
  return ordered;
}

// --- 二次トークン確認（設計書 3.1） ---

/**
 * 予算判定専用の保守的推定。ASCII を 1 token/3 chars、非ASCII を 2.5 tokens/char で数える。
 *
 * 画面表示用の estimateTokensFromText（非ASCII 0.8 token/char）とは意図的に別関数にしている。
 * 表示用は「だいたいの使用率」を出すためのもので、これを安全判定に使うと日本語で大幅に
 * 過小評価する（設計書 13.1 の Codex 指摘）。
 */
export function estimatePromptTokensForBudget(text: string): number {
  let asciiChars = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) <= 0x7f) asciiChars += 1;
  }
  const nonAsciiChars = text.length - asciiChars;
  return Math.ceil(asciiChars / 3 + nonAsciiChars * 2.5);
}

export function promptSafetyMarginTokens(contextWindowTokens: number): number {
  return Math.max(4_096, Math.floor(contextWindowTokens * 0.1));
}

export interface PromptTokenBudgetInput {
  systemInstructions: string;
  userPrompt: string;
  contextWindowTokens: number;
  inputTokenLimit?: number;
  estimatedMaxOutputTokens: number;
  /** provider 実測値。null / undefined なら保守的推定へフォールバックする。 */
  providerTokens?: number | null;
}

export interface PromptTokenBudgetResult {
  tokenCheck: NonNullable<PromptBudgetReport['tokenCheck']>;
  withinInputLimit: boolean;
  withinContextWindow: boolean;
  ok: boolean;
  /** 超過トークン数。ok なら 0。 */
  overByTokens: number;
}

export function checkPromptTokenBudget(input: PromptTokenBudgetInput): PromptTokenBudgetResult {
  const providerTokens =
    typeof input.providerTokens === 'number' && Number.isFinite(input.providerTokens)
      ? input.providerTokens
      : null;
  const promptTokens =
    providerTokens ??
    estimatePromptTokensForBudget(`${input.systemInstructions}\n\n${input.userPrompt}`);
  const safetyMarginTokens = promptSafetyMarginTokens(input.contextWindowTokens);

  const withinInputLimit =
    input.inputTokenLimit === undefined || promptTokens <= input.inputTokenLimit;
  const contextTotal = promptTokens + input.estimatedMaxOutputTokens + safetyMarginTokens;
  const withinContextWindow = contextTotal <= input.contextWindowTokens;

  const inputOver =
    input.inputTokenLimit === undefined ? 0 : Math.max(0, promptTokens - input.inputTokenLimit);
  const contextOver = Math.max(0, contextTotal - input.contextWindowTokens);

  return {
    tokenCheck: {
      promptTokens,
      source: providerTokens === null ? 'conservative' : 'provider',
      ...(input.inputTokenLimit === undefined ? {} : { inputTokenLimit: input.inputTokenLimit }),
      contextWindowTokens: input.contextWindowTokens,
      estimatedMaxOutputTokens: input.estimatedMaxOutputTokens,
      safetyMarginTokens,
    },
    withinInputLimit,
    withinContextWindow,
    ok: withinInputLimit && withinContextWindow,
    overByTokens: Math.max(inputOver, contextOver),
  };
}

// NOTE: ASCII は 1 token / 3 chars なので、1トークン削るのに最大3文字必要になる。
// sample が無いときはこの最悪値で見積もる（少なく見積もると縮小が進まない）。
const MAX_CHARS_PER_TOKEN = 3;

/**
 * 超過トークン量から、削るべきおおよその文字数を出す。
 *
 * 固定係数（日本語の 2.5 tokens/char の逆算）だけで割ると、ASCII 中心の本文で
 * 必要削減量を最大 7.5 倍過小評価し、縮小が進まないまま「収まらない」と誤判定する。
 * sample を渡すと、その本文の実効 chars/token 比から逆算する。
 */
export function tokensToReducibleChars(overByTokens: number, sample?: string): number {
  if (overByTokens <= 0) return 0;

  if (sample && sample.length > 0) {
    const sampleTokens = estimatePromptTokensForBudget(sample);
    if (sampleTokens > 0) {
      const charsPerToken = sample.length / sampleTokens;
      return Math.ceil(overByTokens * charsPerToken);
    }
  }
  return Math.ceil(overByTokens * MAX_CHARS_PER_TOKEN);
}
