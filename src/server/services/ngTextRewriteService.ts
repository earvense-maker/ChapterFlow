// NOTE: NG表現の局所書き換えのうち、ストレージに依存しない部分（設計書 5.5）。
//
// 小説は GenerationRecord、ロールプレイは RoleplaySession と、保存先も更新規約も違う。
// 共通なのは「一文を取り出す → モデルへ投げる → 決定的に再検証する」だけなので、
// そこだけをこのモジュールへ置き、保存はそれぞれの呼び出し側が持つ。
//
// この設計の前提は「プロンプトで『使うな』と言うだけでは守られない」こと。
// 守られたかどうかは必ず文字列側（findNgMatches / findNearMiss）で確かめる。

import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { extractSentenceSpan } from '../utils/textBoundary.js';
import {
  findNearMiss,
  findNgMatches,
  isUnchangedText,
  type NgExpressionLike,
} from '../../shared/ngDetection.js';
import type { NgExpression } from '../types/index.js';

// NOTE: 書き換えるのは一文だけなので出力枠は小さくてよい。全文再生成に比べて
// 桁違いに安いことがこの設計の前提なので、ここを安易に広げない。
const OUTPUT_LENGTH = 700;
// NOTE: 決定的な再チェックで弾く前提なので、温度は本文生成寄りに保つ。低くしすぎると
// 「一音だけ変える」逃げ方が増える（元の表現からの距離が縮む）。
const TEMPERATURE = 0.8;
const TIMEOUT_MS = 60_000;
// NOTE: 3回で打ち切る。ここで通らない語は代替案の登録か手で直したほうが早く、
// 回数を増やしてもトークンを捨てるだけになる。
export const NG_REWRITE_MAX_ATTEMPTS = 3;
const CONTEXT_CHARS = 300;
// NOTE: 書き換え後の長さが元の一文から大きく外れたら、言い換えではなく話が動いている。
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 2.0;

export class NgTextRewriteError extends Error {
  code: string;
  retryable: boolean;

  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.name = 'NgTextRewriteError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface NgRewriteSpanInput {
  provider: string;
  modelName: string;
  systemInstructions: string;
  text: string;
  expression: NgExpression;
  /** 対象語の位置。呼び出し側で本文と一致することを確かめてから渡す。 */
  start: number;
  end: number;
  allExpressions: readonly NgExpressionLike[];
  abortSignal?: AbortSignal | null;
}

export interface NgRewriteSpanResult {
  text: string;
  before: string;
  after: string;
  attempts: number;
}

/** 一箇所だけを書き換える。保存はしない。 */
export async function rewriteNgSpan(input: NgRewriteSpanInput): Promise<NgRewriteSpanResult> {
  const adapter = adapterMap[input.provider];
  if (!adapter) {
    throw new NgTextRewriteError(
      `対応していないプロバイダーです: ${input.provider}`,
      'unsupported_provider',
      false
    );
  }

  const span = extractSentenceSpan(input.text, input.start, input.end);
  const original = input.text.slice(span.start, span.end);
  const before = input.text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start);
  const after = input.text.slice(span.end, Math.min(input.text.length, span.end + CONTEXT_CHARS));

  let rejection: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= NG_REWRITE_MAX_ATTEMPTS; attempt += 1) {
    if (input.abortSignal?.aborted) {
      throw new NgTextRewriteError('書き換えが中断されました。', 'aborted', false);
    }
    attempts = attempt;
    const candidate = await requestRewrite({
      adapter,
      modelName: input.modelName,
      systemInstructions: input.systemInstructions,
      expression: input.expression,
      original,
      before,
      after,
      rejection,
      abortSignal: input.abortSignal ?? null,
    });

    const verdict = verifyRewrite(candidate, original, input.expression, input.allExpressions);
    if (verdict.ok) {
      return {
        text: input.text.slice(0, span.start) + candidate + input.text.slice(span.end),
        before: original,
        after: candidate,
        attempts,
      };
    }
    rejection = verdict.reason;
  }

  throw new NgTextRewriteError(
    `${NG_REWRITE_MAX_ATTEMPTS}回試しても「${input.expression.text}」を十分に言い換えられませんでした。`,
    'rewrite_not_converged',
    true
  );
}

export interface RewriteAllNgInput {
  provider: string;
  modelName: string;
  systemInstructions: string;
  text: string;
  expressions: NgExpression[];
  /** この生成で許す書き換え回数の上限。 */
  maxRewrites: number;
  abortSignal?: AbortSignal | null;
}

export interface RewriteAllNgResult {
  text: string;
  changed: boolean;
  rewrites: Array<{ expressionId: string; before: string; after: string; attempts: number }>;
  /** 上限超過・収束失敗で残ったNG表現。warning へはIDだけを載せる。 */
  unresolvedExpressionIds: string[];
}

/**
 * 本文に含まれるNG表現を、上限まで順に局所リライトする。
 *
 * 1件書き換えるたびに位置がずれるので、毎回検出をやり直す。古い offset を
 * 使い回すと無関係な一文を壊す。
 */
export async function rewriteAllNgOccurrences(
  input: RewriteAllNgInput
): Promise<RewriteAllNgResult> {
  const rewrites: RewriteAllNgResult['rewrites'] = [];
  let text = input.text;
  let changed = false;

  for (let done = 0; done < input.maxRewrites; done += 1) {
    if (input.abortSignal?.aborted) break;
    const matches = findNgMatches(text, input.expressions);
    if (matches.length === 0) break;

    const match = matches[0];
    const expression = input.expressions.find((item) => item.id === match.expressionId);
    if (!expression) break;

    try {
      const result = await rewriteNgSpan({
        provider: input.provider,
        modelName: input.modelName,
        systemInstructions: input.systemInstructions,
        text,
        expression,
        start: match.start,
        end: match.end,
        allExpressions: input.expressions,
        abortSignal: input.abortSignal ?? null,
      });
      text = result.text;
      changed = true;
      rewrites.push({
        expressionId: expression.id,
        before: result.before,
        after: result.after,
        attempts: result.attempts,
      });
    } catch (err) {
      // NOTE: 収束しなかった1語のために応答全体を捨てない。残りは warning で伝える。
      if (err instanceof NgTextRewriteError) break;
      throw err;
    }
  }

  // 書き換え後の本文をもう一度同じ一覧で検証する（設計書 5.5 の手順3）。
  const remaining = findNgMatches(text, input.expressions);
  const unresolvedExpressionIds = Array.from(
    new Set(remaining.map((match) => match.expressionId))
  );

  return { text, changed, rewrites, unresolvedExpressionIds };
}

interface RequestRewriteInput {
  adapter: (typeof adapterMap)[keyof typeof adapterMap];
  modelName: string;
  systemInstructions: string;
  expression: NgExpression;
  original: string;
  before: string;
  after: string;
  rejection: string | null;
  abortSignal: AbortSignal | null;
}

async function requestRewrite(input: RequestRewriteInput): Promise<string> {
  const { adapter, expression } = input;

  const alternatives = expression.alternatives ?? [];
  const alternativeLine =
    alternatives.length > 0
      ? `置き換え先の候補: ${alternatives.map((item) => `「${item}」`).join(' / ')}\nこの候補が文脈に合わないなら、別の言い方を自分で選んでよい。`
      : '置き換え先は文脈に合う言い方を自分で選ぶ。';

  // NOTE: ここでは登録語をプロンプトに載せる。本文生成では否定形での漏れを招くので
  // 載せないが、この呼び出しは (1) 対象が一文だけ (2) 出力を文字列一致で再チェック
  // できる (3) 対象語が1個だけ、という条件が揃っているため、指示が通りやすく、
  // 万一漏れても検出して弾ける。
  const parts = [
    `【周辺の本文】\nこれは文脈の参考であり、書き換え対象ではない。\n\n${input.before}【ここが対象】${input.after}`,
    `【書き換える一文】\n${input.original}`,
    [
      '【指示】',
      `上の一文だけを書き直す。「${expression.text}」という表現を使わずに、同じ出来事・同じ情報量・同じくらいの長さで書く。`,
      alternativeLine,
      '語尾や一音だけを変えた実質同じ表現は不可。語そのものを別の言葉に置き換える。',
      '前後の本文と自然につながるようにし、話を先に進めたり新しい事実を足したりしない。',
      '書き直した一文だけを出力する。説明・前置き・引用符・記号は付けない。',
    ].join('\n'),
  ];

  if (input.rejection) {
    parts.push(`【前回の出力が不採用になった理由】\n${input.rejection}\n同じ失敗を繰り返さないこと。`);
  }

  let result;
  try {
    result = await adapter.generateText({
      debugLabel: 'ng.rewrite',
      systemInstructions: input.systemInstructions,
      userPrompt: parts.join('\n\n---\n\n'),
      outputLength: OUTPUT_LENGTH,
      temperature: TEMPERATURE,
      timeoutMs: TIMEOUT_MS,
      modelName: input.modelName,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    });
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new NgTextRewriteError(
        `モデル呼び出しに失敗しました: ${err.message}`,
        err.code,
        err.retryable
      );
    }
    throw err;
  }

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    throw new NgTextRewriteError(
      result.errorMessage || 'モデルからの応答が得られませんでした。',
      result.errorCode || 'model_error',
      result.retryable
    );
  }

  return cleanupRewrite(result.text, input.original);
}

export interface RewriteVerdict {
  ok: boolean;
  reason: string;
}

// NOTE: この関数がこの機能の要。プロンプトで「使うな」と言うだけでは守られないという
// 前提に立っているので、守られたかどうかは必ず文字列側で確かめる。
export function verifyRewrite(
  candidate: string,
  original: string,
  target: NgExpressionLike,
  allExpressions: readonly NgExpressionLike[]
): RewriteVerdict {
  if (!candidate.trim()) {
    return { ok: false, reason: '出力が空だった。書き直した一文を必ず出すこと。' };
  }

  if (isUnchangedText(candidate, original)) {
    return { ok: false, reason: '元の一文とまったく同じだった。必ず書き換えること。' };
  }

  const length = candidate.length;
  if (
    length < original.length * MIN_LENGTH_RATIO ||
    length > original.length * MAX_LENGTH_RATIO
  ) {
    return {
      ok: false,
      reason: `長さが元の一文（${original.length}字）から離れすぎている。同じくらいの長さで書くこと。`,
    };
  }

  // NOTE: 対象語以外のNGは「元の一文に無かったのに出てきた」場合だけ弾く。元から
  // 同居していた別のNG語まで消させると、2語入った一文はどちらを狙っても収束せず、
  // 3回×2語ぶんのモデル呼び出しを捨てて両方ハイライトのまま残る。そちらの語は
  // その語自身のリライトで直す（自動書き換えループが次の順番で拾う）。
  const preexisting = new Set(
    findNgMatches(original, allExpressions)
      .map((match) => match.expressionId)
      .filter((id) => id !== target.id)
  );
  const hit = findNgMatches(candidate, allExpressions).find(
    (match) => match.expressionId === target.id || !preexisting.has(match.expressionId)
  );
  if (hit) {
    return {
      ok: false,
      reason: `「${hit.expressionText}」がまだ残っている。この語は使わずに書くこと。`,
    };
  }

  // NOTE: ユーザーからの要望で入れた判定。「瞳が揺れる」を「瞳が揺れた」にするような、
  // 一音だけ変えて実質同じ表現を残す逃げ方を弾く。完全一致は上の検出で捕まるので、
  // ここは「ほぼ同じだが完全一致ではない」帯だけを見ている。
  const nearMiss = findNearMiss(candidate, [target]);
  if (nearMiss) {
    return {
      ok: false,
      reason: `「${nearMiss.matchedText}」は「${nearMiss.expressionText}」を一部だけ変えた実質同じ表現。語そのものを別の言葉に置き換えること。`,
    };
  }

  return { ok: true, reason: '' };
}

// NOTE: モデルは指示しても引用符や「書き直した一文:」のような前置きを付けることが
// ある。元の一文が括弧で始まっていない場合に限って外側の括弧を剥がす（会話文の
// 書き換えでは括弧が正しい出力なので、そこまで剥がすと本文を壊す）。
function cleanupRewrite(raw: string, original: string): string {
  let text = raw.trim();

  const fence = text.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) text = fence[1].trim();

  text = text.replace(/^(?:書き直した一文|書き換え後|出力)\s*[:：]\s*/, '').trim();

  const originalStart = original.trim()[0];
  const pairs: Array<[string, string]> = [
    ['「', '」'],
    ['『', '』'],
    ['"', '"'],
    ["'", "'"],
  ];
  for (const [open, close] of pairs) {
    if (originalStart === open) break;
    if (text.startsWith(open) && text.endsWith(close) && text.length > 1) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }

  return text;
}
