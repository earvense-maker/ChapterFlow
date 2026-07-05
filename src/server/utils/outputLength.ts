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

export function estimateMaxOutputTokens(outputLength: number, maxTokens: number): number {
  // NOTE: 日本語は1文字≒1.5〜2.5トークン、加えて Gemini 2.5系 は thinking で
  // 出力枠を消費するため、指定字数×3 + 2048 の余裕を持たせないと本文が途中
  // どころか完全空応答（finishReason=MAX_TOKENS）で返ることがある。
  const { upper } = getApproximateOutputRange(outputLength);
  const estimated = Math.ceil(upper * 3) + 2048;
  return Math.min(maxTokens, Math.max(4096, estimated));
}

function normalizeOutputLength(outputLength: number): number {
  if (!Number.isFinite(outputLength) || outputLength <= 0) return DEFAULT_OUTPUT_LENGTH;
  return Math.round(outputLength);
}
