import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import { extractSentenceSpan } from '../utils/textBoundary.js';
import {
  findNearMiss,
  findNgMatches,
  isUnchangedText,
  normalizeNgPhrase,
  type NgExpressionLike,
} from '../../shared/ngDetection.js';
import * as storage from './storageService.js';
import * as expressionService from './expressionService.js';
import { reloadCredentials } from './credentialService.js';
import { withProjectWriteLock } from './projectLock.js';
import { rebuildEpisodeMarkdownForAcceptedGeneration } from './generationService.js';
import type { NgExpression, NgRewriteResult } from '../types/index.js';

// NOTE: 書き換えるのは一文だけなので出力枠は小さくてよい。全文再生成に比べて
// 桁違いに安いことがこの設計の前提なので、ここを安易に広げない。
const OUTPUT_LENGTH = 700;
// NOTE: 決定的な再チェックで弾く前提なので、温度は本文生成寄りに保つ。低くしすぎると
// 「一音だけ変える」逃げ方が増える（元の表現からの距離が縮む）。
const TEMPERATURE = 0.8;
const TIMEOUT_MS = 60_000;
// NOTE: 3回で打ち切る。ここで通らない語は代替案の登録か手で直したほうが早く、
// 回数を増やしてもトークンを捨てるだけになる。
const MAX_ATTEMPTS = 3;
const CONTEXT_CHARS = 300;
// NOTE: 書き換え後の長さが元の一文から大きく外れたら、言い換えではなく話が動いている。
const MIN_LENGTH_RATIO = 0.5;
const MAX_LENGTH_RATIO = 2.0;

export class NgRewriteError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(message: string, code: string, retryable: boolean, status = 500) {
    super(message);
    this.name = 'NgRewriteError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export interface RewriteNgOccurrenceInput {
  projectId: string;
  generationId: string;
  expressionId: string;
  start: number;
  end: number;
}

export async function rewriteNgOccurrence(
  input: RewriteNgOccurrenceInput
): Promise<NgRewriteResult> {
  return withProjectWriteLock(input.projectId, () => rewriteNgOccurrenceUnlocked(input));
}

async function rewriteNgOccurrenceUnlocked(
  input: RewriteNgOccurrenceInput
): Promise<NgRewriteResult> {
  await reloadCredentials();

  const { projectId, generationId, expressionId, start, end } = input;
  const [project, presets, record, expressions] = await Promise.all([
    storage.readProject(projectId),
    storage.readPresets(projectId),
    storage.findGenerationRecord(projectId, generationId),
    expressionService.resolveActiveNgExpressions(projectId),
  ]);

  if (!project) {
    throw new NgRewriteError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  if (!record) {
    throw new NgRewriteError('対象の本文が見つかりません。', 'generation_not_found', false, 404);
  }

  const expression = expressions.find((candidate) => candidate.id === expressionId);
  if (!expression) {
    throw new NgRewriteError(
      'そのNG表現は登録されていません。',
      'expression_not_found',
      false,
      404
    );
  }

  const storedText = await storage.readGenerationMarkdown(projectId, generationId);
  const text = storedText || record.responseText;

  // NOTE: クライアントが持っている位置は本文が変わると簡単にずれる。範囲の中身が
  // 本当にその登録語かをここで検算し、ずれていたら書き換えずに再読込を促す。
  // 位置がずれたまま書き換えると無関係な一文を壊す。
  if (start < 0 || end > text.length || start >= end) {
    throw new NgRewriteError(
      '本文が更新されています。画面を再読み込みしてから操作してください。',
      'stale_offset',
      false,
      409
    );
  }
  if (normalizeNgPhrase(text.slice(start, end)) !== normalizeNgPhrase(expression.text)) {
    throw new NgRewriteError(
      '本文が更新されています。画面を再読み込みしてから操作してください。',
      'stale_offset',
      false,
      409
    );
  }

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) {
    throw new NgRewriteError(
      `対応していないプロバイダーです: ${project.activeModelProvider}`,
      'unsupported_provider',
      false,
      400
    );
  }

  const span = extractSentenceSpan(text, start, end);
  const original = text.slice(span.start, span.end);
  const before = text.slice(Math.max(0, span.start - CONTEXT_CHARS), span.start);
  const after = text.slice(span.end, Math.min(text.length, span.end + CONTEXT_CHARS));

  const systemPromptResolution = await resolveSystemPrompt(
    project.activePresetIds,
    presets?.customSystemPrompt ?? null,
    presets?.baseSystemPrompt
  );

  let rejection: string | null = null;
  let accepted: string | null = null;
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    const candidate = await requestRewrite({
      adapter,
      modelName: project.activeModelName,
      systemInstructions: systemPromptResolution.systemPrompt,
      expression,
      original,
      before,
      after,
      rejection,
    });

    const verdict = verifyRewrite(candidate, original, expression, expressions);
    if (verdict.ok) {
      accepted = candidate;
      break;
    }
    rejection = verdict.reason;
  }

  if (accepted === null) {
    throw new NgRewriteError(
      `${MAX_ATTEMPTS}回試しても「${expression.text}」を十分に言い換えられませんでした。代替案を登録するか、手で直してください。`,
      'rewrite_not_converged',
      true,
      422
    );
  }

  const nextText = text.slice(0, span.start) + accepted + text.slice(span.end);
  await storage.writeGenerationMarkdown(projectId, generationId, nextText);
  await storage.appendGenerationTextRevisionLog(projectId, generationId, nextText, {
    reason: `ng-rewrite:${expression.id}`,
    before: original,
    after: accepted,
  });
  if (record.status === 'accepted') {
    await rebuildEpisodeMarkdownForAcceptedGeneration(projectId, generationId);
  }

  return {
    generationId,
    text: nextText,
    expressionText: expression.text,
    before: original,
    after: accepted,
    attempts,
  };
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
      systemInstructions: input.systemInstructions,
      userPrompt: parts.join('\n\n---\n\n'),
      outputLength: OUTPUT_LENGTH,
      temperature: TEMPERATURE,
      timeoutMs: TIMEOUT_MS,
      modelName: input.modelName,
    });
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new NgRewriteError(
        `モデル呼び出しに失敗しました: ${err.message}`,
        err.code,
        err.retryable,
        503
      );
    }
    throw err;
  }

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    throw new NgRewriteError(
      result.errorMessage || 'モデルからの応答が得られませんでした。',
      result.errorCode || 'model_error',
      result.retryable,
      503
    );
  }

  return cleanupRewrite(result.text, input.original);
}

interface RewriteVerdict {
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
