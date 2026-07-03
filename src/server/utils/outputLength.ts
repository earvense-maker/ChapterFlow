const MIN_TOLERANCE = 100;
const MAX_TOLERANCE = 500;
const DEFAULT_OUTPUT_LENGTH = 3000;

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
  const { upper } = getApproximateOutputRange(outputLength);
  const estimated = Math.ceil(upper * 1.25) + 512;
  return Math.min(maxTokens, Math.max(1024, estimated));
}

function normalizeOutputLength(outputLength: number): number {
  if (!Number.isFinite(outputLength) || outputLength <= 0) return DEFAULT_OUTPUT_LENGTH;
  return Math.round(outputLength);
}
