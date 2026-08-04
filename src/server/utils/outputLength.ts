const OUTPUT_TOLERANCE_RATE = 0.2;
const OUTPUT_TOLERANCE_ROUNDING = 50;
const DEFAULT_OUTPUT_LENGTH = 6000;

export const DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS = 100_000;

export interface ApproximateOutputRange {
  target: number;
  tolerance: number;
  lower: number;
  upper: number;
}

export function getApproximateOutputRange(outputLength: number): ApproximateOutputRange {
  const target = normalizeOutputLength(outputLength);
  const tolerance = Math.max(
    1,
    Math.round((target * OUTPUT_TOLERANCE_RATE) / OUTPUT_TOLERANCE_ROUNDING) *
      OUTPUT_TOLERANCE_ROUNDING
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

// NOTE: 相談チャット・試し書きのような対話用の枠。JSON タスク用と分けているのは、
// こちらは待ち時間がそのまま体験に効くため、上限を抑えて「延々と考え続ける」より
// 早めに打ち切らせたいから。1,800字の返答なら本文は数千トークンで足り、残りは
// 思考の余裕になる。
//
// この枠だけでは事故は防げない。実測では outputLength 由来の 8,498 枠を
// deepseek-v4-flash が reasoning_effort=high で使い切り、本文0字のまま2ターン
// 連続で停止した。枠を広げても思考は止まらず待ち時間が伸びるだけなので、
// 対話経路は reasoningEffort を併せて落とすこと。ここは取りこぼしの保険。
export const INTERACTIVE_TASK_MAX_OUTPUT_TOKENS = 16_000;

export function estimateMaxOutputTokens(outputLength: number, maxTokens: number): number {
  // NOTE: 日本語は1文字≒1.5〜2.5トークン、加えて Gemini 2.5系 は thinking で
  // 出力枠を消費するため、指定字数×3 + 2048 の余裕を持たせないと本文が途中
  // どころか完全空応答（finishReason=MAX_TOKENS）で返ることがある。
  const { upper } = getApproximateOutputRange(outputLength);
  const estimated = Math.ceil(upper * 3) + 2048;
  return Math.min(maxTokens, Math.max(4096, estimated));
}

export function resolveNovelMaxOutputTokens(
  input: { provider: string; modelName: string; outputLength: number },
  providerCap: number
): number {
  const provider = input.provider.trim().toLowerCase();
  const modelName = input.modelName.trim().toLowerCase();

  // NOTE: DeepSeek V4 Flash は本文の前に reasoning_content を生成し、その分も
  // max_tokens を消費する。字数ベースの推定では本文へ移る前に枠を使い切ったため、
  // 小説本文だけは思考と本文を合わせた固定枠を確保する。事前文脈計算とAPI送信で
  // この戻り値を共有し、予約値と実際の上限が食い違わないようにする。
  if (provider === 'deepseek' && modelName === 'deepseek-v4-flash') {
    return Math.min(providerCap, DEEPSEEK_V4_FLASH_NOVEL_MAX_OUTPUT_TOKENS);
  }

  return estimateMaxOutputTokens(input.outputLength, providerCap);
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
