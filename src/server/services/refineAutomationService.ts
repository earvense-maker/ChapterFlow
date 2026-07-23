import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { withProjectWriteLock } from './generationService.js';
import {
  applyPatchOperationsToSnapshot,
  getOrCreateRefineSession,
  truncateHistory,
  withSessionLock,
} from './refineChatService.js';
import { parseWorldMd, serializeWorldMd } from '../utils/worldMd.js';
import {
  classifyPatchRisk,
  computeStaticSettingsHash,
  isAutomationAllowedOperationKind,
} from './refineRiskPolicy.js';
import { effectiveRefineAutomationMode } from '../types/index.js';
import type {
  Character,
  GenerationId,
  RefineAutomationMode,
  RefineAutomationRun,
  RefineAutomationStore,
  RefineEvidenceScope,
  RefineMaintenancePhase,
  RefineMaintenanceStatus,
  RefineMessage,
  RefinePatch,
  RefinePatchOperation,
  RefineSession,
  WorldContent,
} from '../types/index.js';

export {
  MaintenanceInProgressError,
  RefineAutomationError,
  assertGenerationNotBlockedByMaintenance,
  maintenanceBlocksGeneration,
  readAndNormalizeMaintenance,
} from './refineAutomationGuard.js';
import { readAndNormalizeMaintenance, RefineAutomationError } from './refineAutomationGuard.js';

const MAX_RUNS = 50;
const MAX_SNAPSHOTS = 5;
// NOTE: lease は将来 Phase C の背景 job で定期更新する想定だが、Phase B は同期処理
// なので処理時間の上限として TIMEOUT_MS 相当を持たせる。孤立レコードは guard 側で
// 期限切れとして failed へ正規化される。
const MAINTENANCE_LEASE_MS = 120_000;

function buildMaintenanceStatus(
  runId: string,
  generationId: string,
  phase: RefineMaintenancePhase,
  base?: Pick<RefineMaintenanceStatus, 'appliedPatchIds' | 'pendingPatchIds' | 'reviewPatchIds'>
): RefineMaintenanceStatus {
  const nowStr = nowIso();
  return {
    runId,
    generationId,
    phase,
    startedAt: nowStr,
    updatedAt: nowStr,
    leaseExpiresAt: new Date(Date.now() + MAINTENANCE_LEASE_MS).toISOString(),
    appliedPatchIds: base?.appliedPatchIds ?? [],
    pendingPatchIds: base?.pendingPatchIds ?? [],
    reviewPatchIds: base?.reviewPatchIds ?? [],
  };
}

async function writeMaintenanceStatus(
  projectId: string,
  status: RefineMaintenanceStatus | undefined
): Promise<void> {
  const state = await storage.readState(projectId);
  if (!state) return;
  await storage.writeState(projectId, { ...state, refineMaintenance: status });
}

// ---------- ストア正規化 ----------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPlausibleRun(value: unknown): value is RefineAutomationRun {
  if (typeof value !== 'object' || value === null) return false;
  const run = value as Partial<RefineAutomationRun>;
  const snapshotIsValid =
    run.beforeSnapshot === undefined ||
    (typeof run.beforeSnapshot === 'object' &&
      run.beforeSnapshot !== null &&
      typeof run.beforeSnapshot.worldText === 'string' &&
      Array.isArray(run.beforeSnapshot.characters));
  return (
    run.schemaVersion === 1 &&
    typeof run.runId === 'string' &&
    typeof run.generationId === 'string' &&
    typeof run.status === 'string' &&
    typeof run.mode === 'string' &&
    typeof run.usedModel === 'object' &&
    run.usedModel !== null &&
    typeof run.usedModel.provider === 'string' &&
    typeof run.usedModel.modelName === 'string' &&
    typeof run.createdAt === 'string' &&
    typeof run.sourceStaticHash === 'string' &&
    typeof run.sourceAcceptedGenerationCount === 'number' &&
    Number.isFinite(run.sourceAcceptedGenerationCount) &&
    isStringArray(run.patchIds) &&
    isStringArray(run.appliedPatchIds) &&
    isStringArray(run.pendingPatchIds) &&
    isStringArray(run.reviewPatchIds) &&
    isStringArray(run.highRiskAppliedPatchIds) &&
    snapshotIsValid &&
    (run.resultStaticHash === undefined || typeof run.resultStaticHash === 'string') &&
    (run.acknowledgement === undefined ||
      run.acknowledgement === 'pending' ||
      run.acknowledgement === 'acknowledged' ||
      run.acknowledgement === 'reverted')
  );
}

// NOTE: MAX_SNAPSHOTS のカウントは「実適用があり、まだ revert されていない」run
// だけを対象にする。単純に index<MAX_SNAPSHOTS だと、suggest-only run を連続で
// 走らせるだけで、実際に取り消し対象になり得る古い applied run の beforeSnapshot が
// 押し出されてしまう（P1 レビュー #4）。
function isSnapshotRelevant(run: RefineAutomationRun): boolean {
  return run.appliedPatchIds.length > 0 && run.acknowledgement !== 'reverted';
}

function pruneAutomationStore(store: RefineAutomationStore): RefineAutomationStore {
  const trimmedRuns = store.runs.slice(0, MAX_RUNS);
  let snapshotBudgetUsed = 0;
  const prunedRuns = trimmedRuns.map((run) => {
    if (run.beforeSnapshot === undefined) return run;
    if (!isSnapshotRelevant(run)) {
      // suggest-only / reverted 済みの run は snapshot を持っていても取り消し対象に
      // ならないので、snapshot はここで削るが budget は消費しない。
      const { beforeSnapshot: _beforeSnapshot, ...rest } = run;
      return rest;
    }
    if (snapshotBudgetUsed < MAX_SNAPSHOTS) {
      snapshotBudgetUsed += 1;
      return run;
    }
    const { beforeSnapshot: _beforeSnapshot, ...rest } = run;
    return rest;
  });
  return { ...store, runs: prunedRuns };
}

export function normalizeRefineAutomationStore(value: unknown): RefineAutomationStore {
  if (typeof value !== 'object' || value === null) {
    return { schemaVersion: 1, runs: [] };
  }
  const raw = value as Partial<RefineAutomationStore>;
  const runs = Array.isArray(raw.runs) ? raw.runs.filter(isPlausibleRun) : [];
  const store: RefineAutomationStore = {
    schemaVersion: 1,
    runs,
    ...(raw.confirmationRequired && typeof raw.confirmationRequired === 'object'
      ? { confirmationRequired: raw.confirmationRequired }
      : {}),
  };
  return pruneAutomationStore(store);
}

export async function readAutomationStore(projectId: string): Promise<RefineAutomationStore> {
  return normalizeRefineAutomationStore(await storage.readRefineAutomation(projectId));
}

export async function listAutomationRuns(projectId: string): Promise<RefineAutomationRun[]> {
  return (await readAutomationStore(projectId)).runs;
}

export async function getLatestAutomationRun(projectId: string): Promise<RefineAutomationRun | null> {
  return (await readAutomationStore(projectId)).runs[0] ?? null;
}

export async function getMaintenanceStatus(projectId: string): Promise<RefineMaintenanceStatus | null> {
  return (await readAndNormalizeMaintenance(projectId)) ?? null;
}

// ---------- 分類+適用+保存パイプライン ----------
// NOTE: このパイプラインは LLM スキャンそのものを含まない。proposals は呼び出し元が
// 用意する。生成完了後に自動でスキャンして proposals を作る配線（Phase C）は本フェーズの
// 対象外で、ここでは「proposals を受け取ってから先」だけを実装する。/retry と
// テストはこの関数を直接呼び出して検証する。

export interface AutomationPatchProposal {
  summary: string;
  operations: RefinePatchOperation[];
  evidenceScope: RefineEvidenceScope;
  evidenceQuote?: string;
  // NOTE: 根拠本文は呼び出し元から受け取らない。設計書 5.4 のとおり、サーバーが
  // sourceGenerationId から storage.findGenerationRecord 経由で解決する。将来 LLM
  // 出力を接続する Phase C でも、モデルが用意した文字列でsafe判定が通ることを防ぐ。
  evidenceSourceGenerationId?: GenerationId;
}

export interface RunAutomationPipelineInput {
  generationId: GenerationId;
  mode: RefineAutomationMode;
  usedModel: { provider: string; modelName: string };
  proposals: AutomationPatchProposal[];
  acceptedGenerationCount: number;
  // NOTE: store.confirmationRequired（ロールバック失敗によるハードストップ）が
  // 立っている間、これが true の呼び出し（/retry 等）だけが実行を許される。
  explicitConfirmation?: boolean;
  // NOTE: Phase C の分離型 scan → apply 経路のためのフィールド。scan 時点で
  // computeStaticSettingsHash を取り、apply 時にここへ渡す。pipeline 開始時の
  // beforeHash と一致しない場合は 409 で拒否し、間で world/characters が編集
  // された状態のまま safe/all 適用が走らないようにする。省略時は「scan と apply が
  // 同一トランザクション」とみなし、チェックしない（Phase B/retry の呼び出し方）。
  scannedStaticHash?: string;
}

export async function runRefineAutomationPipeline(
  projectId: string,
  input: RunAutomationPipelineInput
): Promise<RefineAutomationRun> {
  return withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, () => runRefineAutomationPipelineUnlocked(projectId, input))
  );
}

function buildAutomationSummaryMessage(input: {
  generationId: GenerationId;
  appliedCount: number;
  pendingCount: number;
}): string {
  const parts = [`生成案「${input.generationId}」を含めて設定を走査しました。`];
  if (input.appliedCount > 0) parts.push(`安全な変更を${input.appliedCount}件適用しました。`);
  if (input.pendingCount > 0) parts.push(`${input.pendingCount}件を確認待ちにしました。`);
  if (input.appliedCount === 0 && input.pendingCount === 0) parts.push('変更の提案はありませんでした。');
  return parts.join('');
}

async function runRefineAutomationPipelineUnlocked(
  projectId: string,
  input: RunAutomationPipelineInput
): Promise<RefineAutomationRun> {
  if (input.mode === 'off') {
    throw new RefineAutomationError('自動レビューはオフになっています。', 'automation_disabled', false, 409);
  }

  const store = await readAutomationStore(projectId);
  if (store.confirmationRequired && !input.explicitConfirmation) {
    throw new RefineAutomationError(
      '前回の自動レビューの後処理に失敗したため、確認するまで自動レビューを停止しています。',
      'automation_confirmation_required',
      false,
      409
    );
  }
  const existingForGeneration = store.runs.find((run) => run.generationId === input.generationId);
  if (existingForGeneration && existingForGeneration.status !== 'failed') {
    throw new RefineAutomationError(
      'この生成案は既に自動レビュー済みです。',
      'automation_already_run',
      false,
      409
    );
  }

  const [originalWorldText, originalCharacters] = await Promise.all([
    storage.readWorldText(projectId),
    storage.readCharacters(projectId),
  ]);
  const beforeHash = computeStaticSettingsHash({ worldText: originalWorldText, characters: originalCharacters });

  // NOTE: Phase C の分離型 scan → apply では、scan 時点の hash を保存しておいて
  // apply 時にここへ渡す。scan と apply の間で world/characters が編集されていれば
  // 拒否する（設計書 7.9 の「apply 直前に hash と generation status を再検証する」）。
  if (input.scannedStaticHash && input.scannedStaticHash !== beforeHash) {
    throw new RefineAutomationError(
      '走査後に世界設定・人物設定が変更されているため、この提案は適用できません。もう一度走査からやり直してください。',
      'automation_scan_stale',
      false,
      409
    );
  }

  // NOTE: 未確認のall-mode高リスク適用runがstore中に1件でも残っていれば、以降のrunは
  // 自動適用を全面停止する（最新runだけを見ると、高リスクrunの後に提案のみのrunを挟むと
  // 確認前に自動適用が再開してしまう）。
  const hasPendingAcknowledgement = store.runs.some((r) => r.acknowledgement === 'pending');
  const autoApplyAllowed = !hasPendingAcknowledgement;

  const session = await getOrCreateRefineSession(projectId);

  let workingWorldText = originalWorldText;
  let workingCharacters = originalCharacters;
  let worldChangedOverall = false;
  let charactersChangedOverall = false;

  const now = nowIso();
  const runId = generateTimestampId('autorun');
  const systemMessageId = generateTimestampId('msg');

  const patches: RefinePatch[] = [];
  const appliedPatchIds: string[] = [];
  const pendingPatchIds: string[] = [];
  const reviewPatchIds: string[] = [];
  const highRiskAppliedPatchIds: string[] = [];
  let runAcknowledgement: 'pending' | undefined;

  for (const proposal of input.proposals) {
    const patchId = generateTimestampId('patch');
    const patchBaseFields = {
      patchId,
      createdAt: now,
      sourceMessageId: systemMessageId,
      summary: proposal.summary,
      operations: proposal.operations,
      origin: 'auto-scan' as const,
      automationRunId: runId,
      sourceGenerationId: proposal.evidenceSourceGenerationId,
      evidenceScope: proposal.evidenceScope,
      evidenceQuote: proposal.evidenceQuote,
      sourceStaticHash: beforeHash,
    };

    const disallowedOp = proposal.operations.find((op) => !isAutomationAllowedOperationKind(op.kind));
    if (disallowedOp) {
      patches.push({
        ...patchBaseFields,
        status: 'rejected',
        applyError: `対応していない操作種別です: ${disallowedOp.kind}`,
      });
      continue;
    }

    // NOTE: アンカー0/複数マッチ・対象人物不在・カノニカル世界構造の破壊は、この共有関数が
    // 正本として検出する（refineChatService.applyRefinePatchUnlocked と同じ検証）。
    const attempt = applyPatchOperationsToSnapshot(workingWorldText, workingCharacters, proposal.operations);
    if (!attempt.ok) {
      patches.push({ ...patchBaseFields, status: 'rejected', applyError: attempt.error });
      continue;
    }

    // NOTE: 根拠本文はサーバーが持つ generation record からのみ解決する。呼び出し元
    // (LLM や retry) が任意文字列を渡して safe 判定を通せないようにするため。
    // さらに、evidenceScope='accepted'/'static' を主張する proposal は、
    // sourceGeneration の status が 'accepted' である場合にだけ本文を照合対象にする。
    // draft のままの generation を根拠に safe 判定へ持ち込まれないようにする。
    let resolvedSourceText: string | undefined;
    if (proposal.evidenceSourceGenerationId) {
      const sourceGeneration = await storage.findGenerationRecord(
        projectId,
        proposal.evidenceSourceGenerationId
      );
      const acceptedOnlyScope =
        proposal.evidenceScope === 'accepted' || proposal.evidenceScope === 'static';
      if (sourceGeneration && (!acceptedOnlyScope || sourceGeneration.status === 'accepted')) {
        resolvedSourceText = sourceGeneration.responseText;
      }
    }
    // NOTE: retry でも常に再分類する。以前 safe だった補完が、その間に手動で
    // 非空値へ編集されていれば review へ格下げされる。
    const { riskLevel, riskReasons } = classifyPatchRisk({
      operations: proposal.operations,
      characters: workingCharacters,
      worldText: workingWorldText,
      evidenceScope: proposal.evidenceScope,
      evidenceQuote: proposal.evidenceQuote,
      evidenceSourceText: resolvedSourceText,
    });

    // NOTE: 下書きだけを根拠にしたパッチは、対応する生成案が採用されるまで適用しない
    // （設計書 1.2）。Phase B は awaitingAcceptance のライフサイクル（採用/却下との連携）を
    // 実装しないため、draft 根拠のパッチは常に pending のまま据え置く。
    const blockedByDraftOnlyEvidence = proposal.evidenceScope === 'draft';
    const shouldAutoApply =
      !blockedByDraftOnlyEvidence &&
      ((input.mode === 'safe' && riskLevel === 'safe') || (input.mode === 'all' && autoApplyAllowed));

    if (shouldAutoApply) {
      workingWorldText = attempt.worldText;
      workingCharacters = attempt.characters;
      worldChangedOverall = worldChangedOverall || attempt.worldChanged;
      charactersChangedOverall = charactersChangedOverall || attempt.charactersChanged;
      patches.push({ ...patchBaseFields, status: 'applied', appliedAt: now, riskLevel, riskReasons });
      appliedPatchIds.push(patchId);
      if (riskLevel === 'review') {
        highRiskAppliedPatchIds.push(patchId);
        runAcknowledgement = 'pending';
      }
    } else {
      patches.push({ ...patchBaseFields, status: 'pending', riskLevel, riskReasons });
      pendingPatchIds.push(patchId);
      if (riskLevel === 'review') reviewPatchIds.push(patchId);
    }
  }

  const systemMessage: RefineMessage = {
    messageId: systemMessageId,
    role: 'system',
    content: buildAutomationSummaryMessage({
      generationId: input.generationId,
      appliedCount: appliedPatchIds.length,
      pendingCount: pendingPatchIds.length,
    }),
    createdAt: now,
    patchIds: patches.map((p) => p.patchId),
    automationRunId: runId,
  };
  const nextSession: RefineSession = {
    ...session,
    messages: truncateHistory([...session.messages, systemMessage]),
    patches: [...session.patches, ...patches],
    revision: session.revision + 1,
    updatedAt: now,
  };

  // writeWorld は parse/serialize を通してカノニカル形式へ正規化する。取消判定用hashも
  // 実際に保存される文字列から作らないと、空行やエスケープの正規化だけで stale に
  // 見えるため、書込み前に同じ直列化結果を確定する。
  const persistedWorld = worldChangedOverall ? parseWorldMd(workingWorldText) : undefined;
  const persistedWorldText = persistedWorld ? serializeWorldMd(persistedWorld) : workingWorldText;
  const resultStaticHash = computeStaticSettingsHash({
    worldText: persistedWorldText,
    characters: workingCharacters,
  });
  const run: RefineAutomationRun = {
    schemaVersion: 1,
    runId,
    generationId: input.generationId,
    status: pendingPatchIds.length > 0 ? 'needsReview' : 'complete',
    mode: input.mode,
    usedModel: input.usedModel,
    createdAt: now,
    completedAt: now,
    sourceStaticHash: beforeHash,
    sourceStoryStateUpdatedAt: null,
    sourceAcceptedGenerationCount: input.acceptedGenerationCount,
    patchIds: patches.map((p) => p.patchId),
    appliedPatchIds,
    pendingPatchIds,
    reviewPatchIds,
    highRiskAppliedPatchIds,
    acknowledgement: runAcknowledgement,
    beforeSnapshot: { worldText: originalWorldText, characters: originalCharacters },
    resultStaticHash,
  };
  // NOTE: explicitConfirmation で走った retry が成功したら、以前立てられた
  // confirmationRequired は解除する。単純に `...store` で継承すると成功後も
  // ハードストップが残り、以降の run が拒否され続ける。
  const { confirmationRequired: previousHardStop, ...storeWithoutHardStop } = store;
  const shouldClearHardStop = input.explicitConfirmation && previousHardStop !== undefined;
  const baseStore = shouldClearHardStop ? storeWithoutHardStop : store;
  const nextStore = pruneAutomationStore({ ...baseStore, runs: [run, ...baseStore.runs] });

  // NOTE: 実書き込みの直前に refineMaintenance='applying' を立て、生成 API のガードを
  // 動作させる。書き込みが成功しても失敗しても finally で terminal phase へ遷移する。
  await writeMaintenanceStatus(
    projectId,
    buildMaintenanceStatus(runId, input.generationId, 'applying', {
      appliedPatchIds,
      pendingPatchIds,
      reviewPatchIds,
    })
  );

  let succeeded = false;
  try {
    if (persistedWorld) await storage.writeWorld(projectId, persistedWorld);
    if (charactersChangedOverall) await storage.writeCharacters(projectId, workingCharacters);
    await storage.writeRefineSession(projectId, nextSession);
    await storage.writeRefineAutomation(projectId, nextStore);
    succeeded = true;
  } catch (error) {
    // NOTE: world/characters は他ファイルとの整合が必須なので元へ戻す。session と
    // automation store は「今回の試行を新規に記録する」データなので、単純に書く前の
    // 状態へ巻き戻すのではなく、"適用されなかった" という実際の結果を反映した内容で
    // 書き直す（reject 済みの patch はそのまま、apply 予定だった patch は pending +
    // applyError に格下げする）。これにより retry が session から proposals を
    // 再構成できる。
    const failedPatches = patches.map((patch) =>
      patch.status === 'applied'
        ? {
            ...patch,
            status: 'pending' as const,
            appliedAt: undefined,
            applyError: '設定の保存に失敗しました。もう一度お試しください。',
          }
        : patch
    );
    const failedSession: RefineSession = {
      ...session,
      messages: truncateHistory([...session.messages, systemMessage]),
      patches: [...session.patches, ...failedPatches],
      revision: session.revision + 1,
      updatedAt: nowIso(),
      lastError: '自動レビューの設定保存に失敗しました。',
    };
    const failedRun: RefineAutomationRun = {
      ...run,
      status: 'failed',
      completedAt: nowIso(),
      appliedPatchIds: [],
      pendingPatchIds: failedPatches.filter((p) => p.status === 'pending').map((p) => p.patchId),
      highRiskAppliedPatchIds: [],
      acknowledgement: undefined,
    };
    const storeWithFailedRun = pruneAutomationStore({ ...store, runs: [failedRun, ...store.runs] });

    const rollbackResults = await Promise.allSettled([
      ...(worldChangedOverall ? [storage.restoreWorldText(projectId, originalWorldText)] : []),
      ...(charactersChangedOverall ? [storage.writeCharacters(projectId, originalCharacters)] : []),
      storage.writeRefineSession(projectId, failedSession),
      storage.writeRefineAutomation(projectId, storeWithFailedRun),
    ]);
    if (rollbackResults.some((result) => result.status === 'rejected')) {
      console.error('Refine automation rollback failed', { projectId, runId, error });
      const hardStoppedStore = pruneAutomationStore({
        ...storeWithFailedRun,
        confirmationRequired: {
          reason: 'automation_rollback_failed',
          sinceRunId: runId,
          setAt: nowIso(),
        },
      });
      await storage.writeRefineAutomation(projectId, hardStoppedStore).catch(() => undefined);
    }
    console.error('Refine automation apply failed', { projectId, runId, error });
    throw new RefineAutomationError(
      '設定の自動更新に失敗しました。',
      'automation_apply_failed',
      true,
      500
    );
  } finally {
    // NOTE: 成功でも失敗でも terminal phase を書いてガードを解除する。writeState 自体の
    // 失敗は catch 済みなのでここでは throw させず、ログに残すだけ。
    const terminalPhase: RefineMaintenancePhase = succeeded ? run.status : 'failed';
    await writeMaintenanceStatus(
      projectId,
      buildMaintenanceStatus(runId, input.generationId, terminalPhase, {
        appliedPatchIds: succeeded ? appliedPatchIds : [],
        pendingPatchIds,
        reviewPatchIds,
      })
    ).catch((err) => {
      console.warn('Failed to clear maintenance phase', { projectId, runId, err });
    });
  }

  return run;
}

// ---------- 明示再試行 ----------

function reconstructProposalsFromRun(
  run: RefineAutomationRun,
  session: RefineSession
): AutomationPatchProposal[] {
  return session.patches
    .filter((patch) => patch.automationRunId === run.runId)
    .map((patch) => ({
      summary: patch.summary,
      operations: patch.operations,
      evidenceScope: patch.evidenceScope ?? 'mixed',
      evidenceQuote: patch.evidenceQuote,
      evidenceSourceGenerationId: patch.sourceGenerationId,
    }));
}

export async function retryFailedAutomationRun(projectId: string): Promise<RefineAutomationRun> {
  const project = await projectService.getProject(projectId);
  if (!project) {
    throw new RefineAutomationError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const mode = effectiveRefineAutomationMode(project.refineAutomation);
  if (mode === 'off') {
    throw new RefineAutomationError('自動レビューはオフになっています。', 'automation_disabled', false, 409);
  }
  const store = await readAutomationStore(projectId);
  const latest = store.runs[0];
  if (!latest || latest.status !== 'failed') {
    throw new RefineAutomationError(
      '再試行できる失敗した自動レビューがありません。',
      'no_failed_automation_run',
      false,
      404
    );
  }
  const session = await getOrCreateRefineSession(projectId);
  const proposals = reconstructProposalsFromRun(latest, session);
  return runRefineAutomationPipeline(projectId, {
    generationId: latest.generationId,
    mode,
    usedModel: latest.usedModel,
    proposals,
    acceptedGenerationCount: latest.sourceAcceptedGenerationCount,
    explicitConfirmation: true,
  });
}

// ---------- 高リスク自動適用の確認 ----------
// NOTE: acknowledgement='pending' の run が1件でも残ると autoApplyAllowed が false へ
// 落ちる（全runで判定）。ユーザーが「確認した」を押した時にこの関数を呼び、対象runを
// 'acknowledged' へ遷移させる。取り消し(reverted)は別経路。

export async function acknowledgeAutomationRun(
  projectId: string,
  runId: string
): Promise<RefineAutomationRun> {
  return withSessionLock(projectId, async () => {
    const store = await readAutomationStore(projectId);
    const target = store.runs.find((r) => r.runId === runId);
    if (!target) {
      throw new RefineAutomationError(
        '対象の自動更新が見つかりません。',
        'automation_run_not_found',
        false,
        404
      );
    }
    if (target.acknowledgement !== 'pending') {
      throw new RefineAutomationError(
        'この自動更新は確認待ちではありません。',
        'automation_run_not_pending',
        false,
        409
      );
    }
    const acknowledged: RefineAutomationRun = { ...target, acknowledgement: 'acknowledged' };
    const nextRuns = store.runs.map((r) => (r.runId === runId ? acknowledged : r));
    await storage.writeRefineAutomation(projectId, pruneAutomationStore({ ...store, runs: nextRuns }));
    return acknowledged;
  });
}

// ---------- 取り消し ----------

export async function revertLatestAutomationRun(
  projectId: string,
  runId: string
): Promise<{ run: RefineAutomationRun; world: WorldContent; characters: Character[] }> {
  return withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, () => revertLatestAutomationRunUnlocked(projectId, runId))
  );
}

// NOTE: 取り消し対象は「実適用runで、現在のhashと resultStaticHash が一致し、
// まだ取り消し・失敗していない、runs配列の中で最新のもの」。単純に store.runs[0]
// を使うと、実適用runの後に提案のみのrunを挟むだけで前者を取り消せなくなる。
function findRevertCandidateRun(
  runs: RefineAutomationRun[],
  currentHash: string
): RefineAutomationRun | undefined {
  return runs.find(
    (run) =>
      run.appliedPatchIds.length > 0 &&
      run.status !== 'failed' &&
      run.acknowledgement !== 'reverted' &&
      run.beforeSnapshot !== undefined &&
      run.resultStaticHash !== undefined &&
      run.resultStaticHash === currentHash
  );
}

async function revertLatestAutomationRunUnlocked(
  projectId: string,
  runId: string
): Promise<{ run: RefineAutomationRun; world: WorldContent; characters: Character[] }> {
  const store = await readAutomationStore(projectId);
  const targetIndex = store.runs.findIndex((r) => r.runId === runId);
  if (targetIndex < 0) {
    throw new RefineAutomationError(
      '対象の自動更新が見つかりません。',
      'automation_run_not_found',
      false,
      404
    );
  }
  const target = store.runs[targetIndex];
  if (target.status === 'failed') {
    throw new RefineAutomationError(
      'この自動更新は失敗しているため、取り消す変更がありません。',
      'automation_run_not_revertible',
      false,
      409
    );
  }
  if (target.acknowledgement === 'reverted') {
    throw new RefineAutomationError(
      'この自動更新は既に取り消し済みです。',
      'automation_run_already_reverted',
      false,
      409
    );
  }
  if (target.appliedPatchIds.length === 0) {
    throw new RefineAutomationError(
      'この自動更新には取り消す変更がありません。',
      'automation_run_not_revertible',
      false,
      409
    );
  }
  if (!target.beforeSnapshot) {
    throw new RefineAutomationError(
      'この自動更新は復元用データが残っていません。',
      'automation_run_snapshot_missing',
      false,
      409
    );
  }

  const [currentWorldText, currentCharacters] = await Promise.all([
    storage.readWorldText(projectId),
    storage.readCharacters(projectId),
  ]);
  const currentHash = computeStaticSettingsHash({ worldText: currentWorldText, characters: currentCharacters });
  const candidate = findRevertCandidateRun(store.runs, currentHash);
  if (!candidate || candidate.runId !== target.runId) {
    throw new RefineAutomationError(
      '設定が別の変更で更新されているため取り消せません。相談から手動で修正してください。',
      'automation_run_stale',
      false,
      409
    );
  }

  const beforeSnapshot = target.beforeSnapshot;
  const revertedRun: RefineAutomationRun = {
    ...target,
    acknowledgement: 'reverted',
    revertedAt: nowIso(),
    revertError: undefined,
    beforeSnapshot: undefined,
  };
  const nextRuns = store.runs.map((r) => (r.runId === target.runId ? revertedRun : r));
  const nextStore = pruneAutomationStore({ ...store, runs: nextRuns });

  // NOTE: revert 実行中は 'reverting' phase を立て、生成 API を止める。
  await writeMaintenanceStatus(
    projectId,
    buildMaintenanceStatus(target.runId, target.generationId, 'reverting')
  );

  // NOTE: session.patches の中の該当 run の適用済み patch は、実世界の変更が
  // 巻き戻された以上、'applied' のままにすると UI が「まだ反映されている」表示に
  // なり、監査上も嘘になる。'stale' へ遷移させ、applyError で理由を残す。
  const revertedAtIso = nowIso();
  const existingSession = await storage.readRefineSession(projectId);
  const revertedSession = existingSession
    ? {
        ...existingSession,
        patches: existingSession.patches.map((patch) => {
          if (patch.automationRunId !== target.runId) return patch;
          if (patch.status !== 'applied') return patch;
          return {
            ...patch,
            status: 'stale' as const,
            applyError: '自動更新を取り消したため、この変更は元に戻されました。',
          };
        }),
        revision: existingSession.revision + 1,
        updatedAt: revertedAtIso,
      }
    : null;

  let revertSucceeded = false;
  try {
    await storage.restoreWorldText(projectId, beforeSnapshot.worldText);
    await storage.writeCharacters(projectId, beforeSnapshot.characters);
    if (revertedSession) await storage.writeRefineSession(projectId, revertedSession);
    await storage.writeRefineAutomation(projectId, nextStore);
    revertSucceeded = true;
  } catch (error) {
    const rollbackResults = await Promise.allSettled([
      storage.restoreWorldText(projectId, currentWorldText),
      storage.writeCharacters(projectId, currentCharacters),
      // NOTE: session の patch 状態も元に戻す。ここで writeRefineSession が既に走って
      // いた場合の巻き戻し。 existingSession が null の場合は書いていないので skip。
      ...(existingSession ? [storage.writeRefineSession(projectId, existingSession)] : []),
    ]);
    const runWithError: RefineAutomationRun = {
      ...target,
      revertError: error instanceof Error ? error.message : '取り消しに失敗しました。',
    };
    const errorRuns = store.runs.map((r) => (r.runId === target.runId ? runWithError : r));
    const storeWithError = pruneAutomationStore({ ...store, runs: errorRuns });
    const storeWriteFailed = await storage
      .writeRefineAutomation(projectId, storeWithError)
      .then(() => false)
      .catch(() => true);
    if (rollbackResults.some((result) => result.status === 'rejected') || storeWriteFailed) {
      console.error('Refine automation revert rollback failed', { projectId, runId, error });
    }
    throw new RefineAutomationError('取り消しに失敗しました。', 'automation_revert_failed', true, 500);
  } finally {
    await writeMaintenanceStatus(
      projectId,
      buildMaintenanceStatus(
        target.runId,
        target.generationId,
        revertSucceeded ? 'complete' : 'failed'
      )
    ).catch((err) => {
      console.warn('Failed to clear maintenance phase after revert', { projectId, runId, err });
    });
  }

  return {
    run: revertedRun,
    world: parseWorldMd(beforeSnapshot.worldText),
    characters: beforeSnapshot.characters,
  };
}
