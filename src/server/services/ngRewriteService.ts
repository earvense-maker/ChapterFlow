import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import { normalizeNgPhrase } from '../../shared/ngDetection.js';
import {
  NG_REWRITE_MAX_ATTEMPTS,
  NgTextRewriteError,
  rewriteNgSpan,
} from './ngTextRewriteService.js';
import * as storage from './storageService.js';
import * as expressionService from './expressionService.js';
import { reloadCredentials } from './credentialService.js';
import { withProjectWriteLock } from './projectLock.js';
import {
  rebuildEpisodeMarkdownForAcceptedGeneration,
  startContextSummaryAfterAcceptance,
} from './generationService.js';
import { invalidateContextSummaryForGenerationUnlocked } from './acceptedTextDerivations.js';
import type { NgRewriteResult } from '../types/index.js';

// NOTE: 一文の取り出し・モデル呼び出し・決定的な再検証は ngTextRewriteService へ
// 抽出した（設計書 5.5）。この module に残すのは「小説の GenerationRecord を
// 読み書きする」責務だけで、ロールプレイ側は同じ純粋部分を別の保存規約で使う。

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

  const systemPromptResolution = await resolveSystemPrompt(
    project.activePresetIds,
    presets?.customSystemPrompt ?? null,
    presets?.baseSystemPrompt
  );

  let rewritten;
  try {
    rewritten = await rewriteNgSpan({
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
      systemInstructions: systemPromptResolution.systemPrompt,
      text,
      expression,
      start,
      end,
      allExpressions: expressions,
    });
  } catch (err) {
    if (err instanceof NgTextRewriteError) {
      // NOTE: 収束失敗だけは 422 + 具体的な次の手を出す。ここは手動操作の応答なので、
      // 「代替案を登録する / 手で直す」まで案内しないと利用者が詰まる。
      if (err.code === 'rewrite_not_converged') {
        throw new NgRewriteError(
          `${NG_REWRITE_MAX_ATTEMPTS}回試しても「${expression.text}」を十分に言い換えられませんでした。代替案を登録するか、手で直してください。`,
          err.code,
          err.retryable,
          422
        );
      }
      throw new NgRewriteError(err.message, err.code, err.retryable, 503);
    }
    throw err;
  }

  const { text: nextText, before: original, after: accepted, attempts } = rewritten;
  await storage.writeGenerationMarkdown(projectId, generationId, nextText);
  await storage.appendGenerationTextRevisionLog(projectId, generationId, nextText, {
    reason: `ng-rewrite:${expression.id}`,
    before: original,
    after: accepted,
  });
  const invalidatedSummary = await invalidateContextSummaryForGenerationUnlocked(
    projectId,
    generationId
  );
  if (record.status === 'accepted') {
    await rebuildEpisodeMarkdownForAcceptedGeneration(projectId, generationId);
  }
  if (invalidatedSummary) {
    // NOTE: 旧本文を含む要約を空にした後、現在の採用本文から背景で作り直す。件数閾値に
    // 届かない間も、summarized IDを空にしたため改訂後本文はrecent contextへ残る。
    startContextSummaryAfterAcceptance(projectId);
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
