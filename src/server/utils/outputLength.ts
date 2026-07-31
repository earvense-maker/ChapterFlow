const MIN_TOLERANCE = 100;
const MAX_TOLERANCE = 500;
const DEFAULT_OUTPUT_LENGTH = 6000;

export interface ApproximateOutputRange {
  target: number;
  tolerance: number;
  lower: number;
  upper: number;
}

export function getApproximateOutputRange(outputLength: number): ApproximateOutputRange {
  const target = normalizeOutputLength(outputLength);
  const tolerance = Math.min(
    MAX_TOLERANCE,
    Math.max(MIN_TOLERANCE, Math.round((target * 0.125) / 50) * 50)
  );

  return {
    target,
    tolerance,
    lower: Math.max(1, target - tolerance),
    upper: target + tolerance,
  };
}

// NOTE: JSON を返させるタスク共通の出力枠。本文向けの estimateMaxOutputTokens は
// 「目標字数 × 3 + 2048」で、+2048 の思考マージンは Gemini 2.5 世代を想定した値。
// 実測では deepseek-v4-flash が本文ゼロのまま思考だけで 12,248 トークン使い切り、
// 走査の枠（約10,898）を上回って finishReason=length の空応答になった。JSON 自体は
// 数千トークンで足りるので、超過分はすべて思考の余裕として渡す。
// プロバイダーのハードキャップは resolveMaxOutputTokens が clamp するため、
// キャップの小さい OpenAI 系（16,384）へ渡しても不正な値にはならない。
export const JSON_TASK_MAX_OUTPUT_TOKENS = 40_000;

export function estimateMaxOutputTokens(outputLength: number, maxTokens: number): number {
  // NOTE: 日本語は1文字≒1.5〜2.5トークン、加えて Gemini 2.5系 は thinking で
  // 出力枠を消費するため、指定字数×3 + 2048 の余裕を持たせないと本文が途中
  // どころか完全空応答（finishReason=MAX_TOKENS）で返ることがある。
  const { upper } = getApproximateOutputRange(outputLength);
  const estimated = Math.ceil(upper * 3) + 2048;
  return Math.min(maxTokens, Math.max(4096, estimated));
}

// NOTE: 呼び出し側が明示的な max_tokens を渡したらそれを優先する。指定なしなら
// 従来通り outputLength から推定する。いずれもプロバイダーのハードキャップで
// clamp する。JSON 抽出の initial/retry のように「本文向けの推定式だとキャップに
// 張り付いて retry の headroom が消える」ケースの回避口。
export function resolveMaxOutputTokens(
  request: { outputLength: number; maxOutputTokens?: number },
  providerCap: number
): number {
  const explicit = request.maxOutputTokens;
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.min(providerCap, Math.max(1, Math.floor(explicit)));
  }
  return estimateMaxOutputTokens(request.outputLength, providerCap);
}

function normalizeOutputLength(outputLength: number): number {
  if (!Number.isFinite(outputLength) || outputLength <= 0) return DEFAULT_OUTPUT_LENGTH;
  return Math.round(outputLength);
}
