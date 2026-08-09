// NOTE: hard creative contract の生成後検証と最大1回の局所修復（設計書 6.2・7.1）。
// 検証の入力は契約・必要な正史・生成本文だけ。未関連の潜在設定は渡さない。
// verifier / 再検証は active model・30秒、局所修復は active model・120秒に固定する。
import { findNgMatches, type NgExpressionLike } from '../../shared/ngDetection.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  CreativeContract,
  GenerationContractValidation,
  LatentCanonItem,
  Project,
} from '../types/index.js';

export const CONTRACT_VERIFICATION_LIMITS = {
  verifierTimeoutMs: 30_000,
  repairTimeoutMs: 120_000,
  verifierOutputLength: 2_500,
  repairOutputLength: 2_000,
} as const;

export interface ContractVerificationResult {
  validation: GenerationContractValidation;
  /** 検証・修復後の最終本文 */
  finalText: string;
  reviewRequired: boolean;
}

export interface ContractVerificationInput {
  project: Project;
  adapter: ModelAdapter;
  contract: CreativeContract | null;
  revealedCanon: LatentCanonItem[];
  text: string;
  ngExpressions: NgExpressionLike[];
  /** 検証中に利用者が生成を停止した場合、追加のモデル呼び出しも中断する。 */
  abortSignal?: AbortSignal;
  /** strictモードの進捗通知（設計書 4.4）: verifying / repairing / rechecking */
  onPhase?: (phase: 'verifying' | 'repairing' | 'rechecking') => void;
}

export interface ContractCheckResult {
  checkedContractIds: string[];
  failedContractIds: string[];
  uncertainContractIds: string[];
  /** 違反の説明（修復プロンプト用・本文抜粋は含まない） */
  failureDetails: string[];
}

// NOTE: hard契約が無い場合はsemantic verifierを呼ばない（設計書 10.7）。
export function shouldRunVerification(contract: CreativeContract | null): boolean {
  return (contract?.items ?? []).some(
    (item) => item.strength === 'hard' && item.status === 'active'
  );
}

export async function verifyGeneratedText(
  input: ContractVerificationInput
): Promise<ContractVerificationResult> {
  if (!shouldRunVerification(input.contract)) {
    return {
      validation: buildValidation({
        status: 'skipped',
        checkedContractIds: [],
        failedContractIds: [],
        uncertainContractIds: [],
        verifierCalls: 0,
        repairCalls: 0,
      }),
      finalText: input.text,
      reviewRequired: false,
    };
  }

  const activeContracts = (input.contract?.items ?? []).filter(
    (item) => item.strength === 'hard' && item.status === 'active'
  );
  const checkedContractIds = activeContracts.map((item) => item.contractId);

  // 1. 決定的検査（既存NG表現・明示語句）
  const ngMatches = findNgMatches(input.text, input.ngExpressions);
  let hasNgViolation = ngMatches.length > 0;
  let failures: string[] = hasNgViolation
    ? [`NG表現が検出されました: ${ngMatches.map((match) => match.expressionText).join('、')}`]
    : [];
  let text = input.text;
  let verifierCalls = 0;
  let repairCalls = 0;

  // 2. semantic verifier（hard契約 + revealed canon）
  input.onPhase?.('verifying');
  verifierCalls += 1;
  const firstCheck = await runSemanticCheck(input, text, activeContracts);
  failures = [...failures, ...firstCheck.failureDetails];
  let failedContractIds = firstCheck.failedContractIds;
  let uncertainContractIds = firstCheck.uncertainContractIds;
  let hasCanonContradiction = firstCheck.canonContradiction.length > 0;

  // 3. fail・決定的NG・正史矛盾がある場合のみ、違反箇所と周辺だけを対象に最大1回修復
  //   （uncertainだけでは修復しない・設計書 6.2-4）
  if (failedContractIds.length > 0 || hasNgViolation || hasCanonContradiction) {
    input.onPhase?.('repairing');
    repairCalls += 1;
    const repaired = await runRepairOnce(input, text, failures);
    text = repaired.text;
    // 4. 修復後に再検証
    input.onPhase?.('rechecking');
    verifierCalls += 1;
    const recheck = await runSemanticCheck(input, text, activeContracts);
    const finalNg = findNgMatches(text, input.ngExpressions);
    hasNgViolation = finalNg.length > 0;
    hasCanonContradiction = recheck.canonContradiction.length > 0;
    failedContractIds = [...new Set([
      ...recheck.failedContractIds,
      ...(hasNgViolation ? checkedContractIds : []),
    ])];
    uncertainContractIds = [...new Set([
      ...uncertainContractIds,
      ...recheck.uncertainContractIds,
    ])];
    failures = [
      ...(hasNgViolation ? [`NG表現が残っています: ${finalNg.map((match) => match.expressionText).join('、')}`] : []),
      ...(hasCanonContradiction ? [`正史との矛盾が残っています: ${recheck.canonContradiction}`] : []),
      ...recheck.failureDetails,
    ];
  }

  const hasFinalFailures = failedContractIds.length > 0 || hasNgViolation || hasCanonContradiction;
  const status: GenerationContractValidation['status'] =
    hasFinalFailures || uncertainContractIds.length > 0
      ? 'review-required'
      : repairCalls > 0
        ? 'repaired'
        : 'passed';

  const validation = buildValidation({
    status,
    checkedContractIds,
    failedContractIds,
    uncertainContractIds,
    verifierCalls,
    repairCalls,
  });
  return {
    validation,
    finalText: text,
    reviewRequired: status === 'review-required',
  };
}

// NOTE: 契約ごとの pass / fail / uncertain を返すsemantic検査。uncertain は契約IDごとに
// 判定し、fail と uncertain が混在した場合はどちらも返す。revealed canonとの矛盾は
// canonContradictionとして返し、修復・再検証の対象にする（設計書 6.2-3・レビュー指摘 P1）。
async function runSemanticCheck(
  input: ContractVerificationInput,
  text: string,
  activeContracts: CreativeContract['items']
): Promise<{
  failedContractIds: string[];
  uncertainContractIds: string[];
  failureDetails: string[];
  canonContradiction: string;
}> {
  const exceptionGenerations = new Set(
    (input.contract?.exceptions ?? []).map((exception) => exception.generationId)
  );
  void exceptionGenerations;

  const canonContext = input.revealedCanon
    .slice(0, 12)
    .map((item) => `${item.statement}（${item.epistemicStatus}）`)
    .join('\n');

  const userPrompt = [
    'あなたは小説本文と作品の約束の整合性検査係です。',
    '与えられた本文が、作品の約束（hard契約）に意味的に違反しているかを判定してください。',
    '本文はドラフトであり、修復の対象です。',
    '判定の例: 「護衛は主人公を裏切らない」に対して「護衛は主人公を裏切った」は fail。',
    '「時間をかけて信頼が育つ」に対して1場面で急速に信頼が成立する描写は uncertificable ではなく fail 寄りの判定でもよいが、本文全体で判断してください。',
    '本文の一部だけを切り出して判定せず、場面全体の文脈で判断してください。',
    '曖昧な場合は uncertain にしてください。',
    '「どの契約にも違反していない」場合は fail を出さないでください。',
    'JSONオブジェクトだけを出力してください。',
    '【作品の約束（hard）】',
    activeContracts
      .map((item) => `[${item.contractId}] ${item.kind}: ${item.text}`)
      .join('\n'),
    ...(canonContext
      ? ['【正史の根拠（この内容との明確な矛盾も違反とする）】', canonContext]
      : []),
    '【本文】',
    text,
    '【出力形式】',
    JSON.stringify({
      results: [
        {
          contractId: '契約ID',
          verdict: 'pass | fail | uncertain',
          reason: '判定理由（100字以内）',
        },
      ],
      canonContradiction: '明確な正史矛盾がある場合の説明。無ければ空文字。',
    }),
  ].join('\n\n---\n\n');

  try {
    const result = await input.adapter.generateText({
      debugLabel: 'contractVerification.semanticCheck',
      systemInstructions: 'あなたは小説本文の整合性検査係です。JSONオブジェクトだけを出力してください。',
      userPrompt,
      outputLength: CONTRACT_VERIFICATION_LIMITS.verifierOutputLength,
      maxOutputTokens: 6_000,
      temperature: 0.1,
      timeoutMs: CONTRACT_VERIFICATION_LIMITS.verifierTimeoutMs,
      modelName: input.project.activeModelName,
      responseMimeType: 'application/json',
      abortSignal: input.abortSignal,
    });

    if (result.finishReason === 'timeout' || result.finishReason === 'error' || result.finishReason === 'content_filter') {
      return {
        failedContractIds: [],
        uncertainContractIds: activeContracts.map((item) => item.contractId),
        failureDetails: ['検証が完了できませんでした（uncertainとして扱います）。'],
        canonContradiction: '',
      };
    }
    if (result.finishReason === 'length' || !result.text.trim()) {
      return {
        failedContractIds: [],
        uncertainContractIds: activeContracts.map((item) => item.contractId),
        failureDetails: ['検証結果を読み取れませんでした（uncertainとして扱います）。'],
        canonContradiction: '',
      };
    }

    const parsed = parseSemanticCheck(result.text);
    if (!parsed) {
      // NOTE: JSON不正・空配列は「判定不能」として全契約をuncertainにする（設計書 12.4）。
      // 空配列を合格扱いにすると、モデルの出力崩れが違反の見逃しになる。
      return {
        failedContractIds: [],
        uncertainContractIds: activeContracts.map((item) => item.contractId),
        failureDetails: ['検証結果を読み取れませんでした（uncertainとして扱います）。'],
        canonContradiction: '',
      };
    }
    const byId = new Map(activeContracts.map((item) => [item.contractId, item]));
    const failedContractIds = parsed.results
      .filter((entry) => entry.verdict === 'fail')
      .map((entry) => entry.contractId)
      .filter((id) => byId.has(id));
    const uncertainFromResults = parsed.results
      .filter((entry) => entry.verdict === 'uncertain')
      .map((entry) => entry.contractId)
      .filter((id) => byId.has(id));
    // NOTE: 全hard契約の判定が揃っていなければ、欠落した契約をuncertainにする。
    // 判定の欠落は「合格」を意味しない（レビュー指摘 P1）。
    const judged = new Set(parsed.results.map((entry) => entry.contractId));
    const missingContractIds = activeContracts
      .map((item) => item.contractId)
      .filter((contractId) => !judged.has(contractId));
    const uncertainContractIds = [
      ...new Set([...uncertainFromResults, ...missingContractIds]),
    ];
    const failureDetails = parsed.results
      .filter((entry) => entry.verdict !== 'pass')
      .map((entry) => `契約[${entry.contractId}]: ${entry.reason}`)
      .filter(Boolean);
    return {
      failedContractIds: [...new Set(failedContractIds)],
      uncertainContractIds,
      failureDetails,
      canonContradiction: parsed.canonContradiction,
    };
  } catch {
    return {
      failedContractIds: [],
      uncertainContractIds: activeContracts.map((item) => item.contractId),
      failureDetails: ['検証が失敗しました（uncertainとして扱います）。'],
      canonContradiction: '',
    };
  }
}

// NOTE: 違反箇所と周辺だけを対象に最大1回の修復（設計書 6.2-4・10.5）。
// 無制限に繰り返さない。元本文も診断用に保持するが通常UIへ二重表示しない。
async function runRepairOnce(
  input: ContractVerificationInput,
  text: string,
  failureDetails: string[]
): Promise<{ text: string; failures: string[] }> {
  const userPrompt = [
    'あなたは小説の文章修正係です。',
    '与えられた違反内容を、本文全体の流れを保ったまま最小限の修正で解消してください。',
    '修正は違反箇所とその周辺だけに留め、全体的な言い換えはしないでください。',
    '本文だけを出力してください。説明や見出しは付けないでください。',
    '【違反内容】',
    failureDetails.join('\n'),
    '【本文】',
    text,
  ].join('\n\n---\n\n');

  try {
    const result = await input.adapter.generateText({
      debugLabel: 'contractVerification.repair',
      systemInstructions: 'あなたは小説の文章修正係です。修正後の本文だけを出力してください。',
      userPrompt,
      outputLength: Math.max(2_000, Math.ceil(text.length * 1.2)),
      maxOutputTokens: 16_000,
      temperature: 0.3,
      timeoutMs: CONTRACT_VERIFICATION_LIMITS.repairTimeoutMs,
      modelName: input.project.activeModelName,
      abortSignal: input.abortSignal,
    });

    if (result.finishReason !== 'stop' || !result.text.trim()) {
      return { text, failures: ['修復が完了できませんでした。'] };
    }
    const repaired = result.text.trim();
    if (repaired === text) {
      return { text, failures: ['修復で本文が変化しませんでした。'] };
    }
    return { text: repaired, failures: [] };
  } catch {
    return { text, failures: ['修復が失敗しました。'] };
  }
}

function buildValidation(input: {
  status: GenerationContractValidation['status'];
  checkedContractIds: string[];
  failedContractIds: string[];
  uncertainContractIds: string[];
  verifierCalls: number;
  repairCalls: number;
}): GenerationContractValidation {
  return {
    status: input.status,
    checkedContractIds: [...new Set(input.checkedContractIds)],
    failedContractIds: [...new Set(input.failedContractIds)],
    uncertainContractIds: [...new Set(input.uncertainContractIds)],
    verifierCalls: input.verifierCalls,
    repairCalls: input.repairCalls,
    completedAt: new Date().toISOString(),
  };
}

function parseSemanticCheck(
  text: string
): {
  results: Array<{ contractId: string; verdict: 'pass' | 'fail' | 'uncertain'; reason: string }>;
  canonContradiction: string;
} | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1)) as {
      results?: unknown;
      canonContradiction?: unknown;
    };
    if (!Array.isArray(parsed.results)) return null;
    const entries = parsed.results
      .filter(
        (item): item is { contractId: unknown; verdict: unknown; reason: unknown } =>
          typeof item === 'object' && item !== null && !Array.isArray(item)
      )
      .map(
        (item): { contractId: string; verdict: 'pass' | 'fail' | 'uncertain'; reason: string } => ({
          contractId: typeof item.contractId === 'string' ? item.contractId : '',
          // NOTE: pass / fail / uncertain 以外のverdict（"passed"・タイポ等）は判定不能として
          // uncertainに落とす。未知verdictを暗黙の合格にしない（レビュー指摘 P1）。
          verdict:
            item.verdict === 'pass' || item.verdict === 'fail' || item.verdict === 'uncertain'
              ? item.verdict
              : 'uncertain',
          reason: typeof item.reason === 'string' ? item.reason : '',
        })
      )
      .filter((entry) => entry.contractId.length > 0);
    // NOTE: 空配列は「判定なし」であり、呼び出し側で全契約をuncertainにする。
    if (entries.length === 0) return null;
    const canonContradiction =
      typeof parsed.canonContradiction === 'string'
        ? parsed.canonContradiction.trim().slice(0, 300)
        : '';
    return { results: entries, canonContradiction };
  } catch {
    return null;
  }
}
