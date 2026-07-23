import { generateTimestampId } from '../utils/id.js';
import { renderAutomationEvidenceCharacters } from '../utils/automationEvidence.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { withProjectWriteLock } from './projectLock.js';
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
export const MAINTENANCE_LEASE_MS = 120_000;

export function buildMaintenanceStatus(
  runId: string,
  generationId: string,
  phase: RefineMaintenancePhase,
  base?: Pick<RefineMaintenanceStatus, 'appliedPatchIds' | 'pendingPatchIds' | 'reviewPatchIds'>,
  previous?: RefineMaintenanceStatus
): RefineMaintenanceStatus {
  const nowStr = nowIso();
  // An error belongs to the transition that produced it. A later reservation
  // must start clean rather than inheriting a stale failure message.
  return {
    runId,
    generationId,
    phase,
    startedAt: previous?.startedAt ?? nowStr,
    updatedAt: nowStr,
    leaseExpiresAt: new Date(Date.now() + MAINTENANCE_LEASE_MS).toISOString(),
    appliedPatchIds: base?.appliedPatchIds ?? [],
    pendingPatchIds: base?.pendingPatchIds ?? [],
    reviewPatchIds: base?.reviewPatchIds ?? [],
    ...(previous?.postAcceptanceContinuation
      ? { postAcceptanceContinuation: previous.postAcceptanceContinuation }
      : {}),
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

// NOTE: generation 側は既に project write lock を保持しているため、ここで session lock を
// 取ってはいけない。run 本体だけを監査履歴上 stale にし、個々の patch は手動適用時にも
// run 状態を再検証することで安全に止める（§4.2 / §7.10）。
export async function markAutomationRunStaleUnlocked(
  projectId: string,
  runId: string,
  reason = '対応する下書きが選択対象ではなくなったため、この自動レビューは無効になりました。'
): Promise<RefineAutomationRun | null> {
  const store = await readAutomationStore(projectId);
  const target = store.runs.find((run) => run.runId === runId);
  if (!target || target.status === 'stale') return target ?? null;
  const stale: RefineAutomationRun = {
    ...target,
    status: 'stale',
    completedAt: nowIso(),
    errorMessage: reason,
  };
  await storage.writeRefineAutomation(
    projectId,
    pruneAutomationStore({
      ...store,
      runs: store.runs.map((run) => (run.runId === runId ? stale : run)),
    })
  );
  return stale;
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
  // NOTE: Phase C は LLM から渡された generationId / scope を信用しない。走査前に
  // サーバーが入力へ発行した sourceRef と照合し、実際に渡した本文だけを safe 判定に使う。
  evidenceSourceRef?: string;
}

export interface AutomationEvidenceSource {
  sourceRef: string;
  scope: Extract<RefineEvidenceScope, 'static' | 'accepted' | 'draft'>;
  text: string;
  generationId?: GenerationId;
  sceneId?: string;
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
  scannedStoryStateUpdatedAt?: string | null;
  // NOTE: generation 保存時に予約した runId。指定時は active maintenance slot と
  // compare-and-set で照合してから applying へ遷移する。
  runId?: string;
  expectedMaintenanceRunId?: string;
  evidenceSources?: AutomationEvidenceSource[];
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

interface ResolvedAutomationEvidence {
  scope: RefineEvidenceScope;
  sourceText?: string;
  sourceGenerationId?: GenerationId;
  sourceRef?: string;
}

async function resolveStoredEvidenceSource(
  projectId: string,
  sourceRef: string,
  expectedGenerationId?: GenerationId
): Promise<AutomationEvidenceSource | undefined> {
  if (sourceRef === 'static:world') {
    return { sourceRef, scope: 'static', text: await storage.readWorldText(projectId) };
  }
  if (sourceRef === 'static:characters') {
    return {
      sourceRef,
      scope: 'static',
      text: renderAutomationEvidenceCharacters(await storage.readCharacters(projectId)),
    };
  }

  const generationMatch = /^(?:draft|accepted):([^:]+):\d+$/.exec(sourceRef);
  if (!generationMatch || (expectedGenerationId && expectedGenerationId !== generationMatch[1])) {
    return undefined;
  }
  const generation = await storage.findGenerationRecord(projectId, generationMatch[1]);
  if (!generation || (generation.status !== 'draft' && generation.status !== 'accepted')) {
    return undefined;
  }
  return {
    sourceRef,
    scope: generation.status,
    text: generation.responseText,
    generationId: generation.generationId,
    sceneId: generation.sceneId,
  };
}

async function resolveAutomationEvidence(
  projectId: string,
  proposal: AutomationPatchProposal,
  sources: AutomationEvidenceSource[] | undefined
): Promise<ResolvedAutomationEvidence> {
  const suppliedFromScan = proposal.evidenceSourceRef
    ? sources?.find((source) => source.sourceRef === proposal.evidenceSourceRef)
    : undefined;
  // A retry has no in-memory scan snapshot. Rehydrate only server-issued source
  // refs from current storage so its risk decision remains evidence-backed.
  const supplied =
    suppliedFromScan ??
    (proposal.evidenceSourceRef
      ? await resolveStoredEvidenceSource(
          projectId,
          proposal.evidenceSourceRef,
          proposal.evidenceSourceGenerationId
        )
      : undefined);

  if (supplied) {
    if (
      proposal.evidenceSourceGenerationId !== undefined &&
      proposal.evidenceSourceGenerationId !== supplied.generationId
    ) {
      return { scope: 'mixed' };
    }
    if (supplied.scope === 'static') {
      return { scope: 'static', sourceText: supplied.text, sourceRef: supplied.sourceRef };
    }

    const generationId = supplied.generationId;
    if (!generationId) return { scope: 'mixed' };
    const sourceGeneration = await storage.findGenerationRecord(projectId, generationId);
    if (!sourceGeneration) return { scope: 'mixed' };
    if (sourceGeneration.status === 'accepted') {
      // NOTE: 走査中にユーザーが採用した場合、同じ sourceRef でも適用直前の正本は
      // accepted である。ここで再判定し、draft 専用保留を不必要に残さない。
      return {
        scope: 'accepted',
        sourceText: supplied.text,
        sourceGenerationId: generationId,
        sourceRef: supplied.sourceRef,
      };
    }
    if (sourceGeneration.status === 'draft') {
      return {
        scope: 'draft',
        sourceText: supplied.text,
        sourceGenerationId: generationId,
        sourceRef: supplied.sourceRef,
      };
    }
    return { scope: 'mixed' };
  }

  // NOTE: Phase B の直呼び出し・既存 retry との後方互換。Phase C 経路では必ず
  // evidenceSources を渡すため、この fallback を safe 判定の新規根拠には使わない。
  if (proposal.evidenceSourceGenerationId) {
    const sourceGeneration = await storage.findGenerationRecord(
      projectId,
      proposal.evidenceSourceGenerationId
    );
    if (sourceGeneration?.status === 'accepted') {
      return {
        scope: proposal.evidenceScope === 'static' ? 'accepted' : proposal.evidenceScope,
        sourceText: sourceGeneration.responseText,
        sourceGenerationId: sourceGeneration.generationId,
      };
    }
    if (proposal.evidenceScope === 'draft') {
      return { scope: 'draft', sourceGenerationId: proposal.evidenceSourceGenerationId };
    }
  }
  return { scope: proposal.evidenceScope === 'draft' ? 'draft' : 'mixed' };
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
  let reservedMaintenance: RefineMaintenanceStatus | undefined;
  if (input.expectedMaintenanceRunId) {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    if (
      !maintenance ||
      maintenance.runId !== input.expectedMaintenanceRunId ||
      maintenance.generationId !== input.generationId ||
      maintenance.phase !== 'scanning'
    ) {
      throw new RefineAutomationError(
        'この自動走査は新しい状態に置き換えられたため、結果を適用しません。',
        'automation_slot_stale',
        false,
        409
      );
    }
    reservedMaintenance = maintenance;
  }

  const existingForGeneration = store.runs.find(
    (run) => run.generationId === input.generationId && run.runId !== input.runId
  );
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
  const runId = input.runId ?? generateTimestampId('autorun');
  const systemMessageId = generateTimestampId('msg');

  const patches: RefinePatch[] = [];
  const appliedPatchIds: string[] = [];
  const pendingPatchIds: string[] = [];
  const reviewPatchIds: string[] = [];
  const highRiskAppliedPatchIds: string[] = [];
  let runAcknowledgement: 'pending' | undefined;
  let hasAwaitingAcceptancePatch = false;

  for (const proposal of input.proposals) {
    const patchId = generateTimestampId('patch');
    const evidence = await resolveAutomationEvidence(projectId, proposal, input.evidenceSources);
    const patchBaseFields = {
      patchId,
      createdAt: now,
      sourceMessageId: systemMessageId,
      summary: proposal.summary,
      operations: proposal.operations,
      origin: 'auto-scan' as const,
      automationRunId: runId,
      sourceGenerationId: evidence.sourceGenerationId ?? proposal.evidenceSourceGenerationId,
      evidenceScope: evidence.scope,
      evidenceQuote: proposal.evidenceQuote,
      evidenceSourceRef: evidence.sourceRef,
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

    // NOTE: retry でも常に再分類する。以前 safe だった補完が、その間に手動で
    // 非空値へ編集されていれば review へ格下げされる。
    const { riskLevel, riskReasons } = classifyPatchRisk({
      operations: proposal.operations,
      characters: workingCharacters,
      worldText: workingWorldText,
      evidenceScope: evidence.scope,
      evidenceQuote: proposal.evidenceQuote,
      evidenceSourceText: evidence.sourceText,
    });

    // NOTE: source generation が現在の draft である patch は、mode=all でも採用前に
    // 適用しない。mixed のうち source がこの draft のものも同じ扱いにして、下書き情報を
    // 確定設定へ早出ししない（§7.1 / §7.3）。
    const blockedByDraftOnlyEvidence =
      evidence.scope === 'draft' ||
      (evidence.scope === 'mixed' && patchBaseFields.sourceGenerationId === input.generationId);
    const shouldAutoApply =
      !blockedByDraftOnlyEvidence &&
      autoApplyAllowed &&
      (input.mode === 'all' || (input.mode === 'safe' && riskLevel === 'safe'));

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
      if (
        blockedByDraftOnlyEvidence &&
        patchBaseFields.sourceGenerationId === input.generationId &&
        (evidence.scope === 'draft' || evidence.scope === 'mixed')
      ) {
        hasAwaitingAcceptancePatch = true;
      }
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
  const terminalStatus: RefineMaintenancePhase = hasAwaitingAcceptancePatch
    ? 'awaitingAcceptance'
    : pendingPatchIds.length > 0
      ? 'needsReview'
      : 'complete';
  const run: RefineAutomationRun = {
    schemaVersion: 1,
    runId,
    generationId: input.generationId,
    status: terminalStatus,
    mode: input.mode,
    usedModel: input.usedModel,
    createdAt: now,
    completedAt: now,
    sourceStaticHash: beforeHash,
    sourceStoryStateUpdatedAt: input.scannedStoryStateUpdatedAt ?? null,
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
    }, reservedMaintenance)
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
      }, reservedMaintenance)
    ).catch((err) => {
      console.warn('Failed to clear maintenance phase', { projectId, runId, err });
    });
  }

  return run;
}

// ---------- draft 根拠の採用後適用 ----------

async function deferAwaitingRunForConfirmationUnlocked(
  projectId: string,
  state: NonNullable<Awaited<ReturnType<typeof storage.readState>>>,
  maintenance: RefineMaintenanceStatus,
  store: RefineAutomationStore,
  targetRun: RefineAutomationRun,
  session: RefineSession
): Promise<RefineAutomationRun> {
  const pendingPatches = session.patches.filter(
    (patch) => patch.automationRunId === targetRun.runId && patch.status === 'pending'
  );
  const pendingPatchIds = pendingPatches.map((patch) => patch.patchId);
  const reviewPatchIds = pendingPatches
    .filter((patch) => patch.riskLevel === 'review')
    .map((patch) => patch.patchId);
  const reason = '前回の自動レビューの後処理が未確認のため、採用後の自動反映は保留しています。';
  const nextRun: RefineAutomationRun = {
    ...targetRun,
    status: 'needsReview',
    completedAt: nowIso(),
    pendingPatchIds,
    reviewPatchIds,
    errorMessage: reason,
  };
  const nextStore = pruneAutomationStore({
    ...store,
    runs: store.runs.map((run) => (run.runId === targetRun.runId ? nextRun : run)),
  });
  const nextMaintenance = buildMaintenanceStatus(
    targetRun.runId,
    targetRun.generationId,
    'needsReview',
    { appliedPatchIds: targetRun.appliedPatchIds, pendingPatchIds, reviewPatchIds },
    maintenance
  );
  nextMaintenance.errorMessage = reason;

  try {
    await storage.writeRefineAutomation(projectId, nextStore);
    await storage.writeState(projectId, { ...state, refineMaintenance: nextMaintenance });
  } catch (error) {
    await storage.writeRefineAutomation(projectId, store).catch(() => undefined);
    throw error;
  }
  return nextRun;
}

export async function continueAwaitingAcceptanceAutomationRun(
  projectId: string,
  runId: string
): Promise<RefineAutomationRun | null> {
  return withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, () => continueAwaitingAcceptanceAutomationRunUnlocked(projectId, runId))
  );
}

async function continueAwaitingAcceptanceAutomationRunUnlocked(
  projectId: string,
  runId: string
): Promise<RefineAutomationRun | null> {
  const state = await storage.readState(projectId);
  const maintenance = state?.refineMaintenance;
  if (!state || !maintenance || maintenance.runId !== runId || maintenance.phase !== 'awaitingAcceptance') {
    return null;
  }

  const sourceGeneration = await storage.findGenerationRecord(projectId, maintenance.generationId);
  if (!sourceGeneration || sourceGeneration.status !== 'accepted') {
    if (sourceGeneration && (sourceGeneration.status === 'rejected' || sourceGeneration.status === 'superseded')) {
      return staleAwaitingAutomationRunUnlocked(
        projectId,
        state,
        maintenance,
        '対応する下書きが採用されなかったため、この提案は無効になりました。'
      );
    }
    return null;
  }

  const [store, session, originalWorldText, originalCharacters] = await Promise.all([
    readAutomationStore(projectId),
    getOrCreateRefineSession(projectId),
    storage.readWorldText(projectId),
    storage.readCharacters(projectId),
  ]);
  const runIndex = store.runs.findIndex((run) => run.runId === runId);
  if (runIndex < 0) {
    return staleAwaitingAutomationRunUnlocked(
      projectId,
      state,
      maintenance,
      '対応する自動レビュー履歴が見つからないため、この提案は無効になりました。'
    );
  }
  const targetRun = store.runs[runIndex];
  if (store.confirmationRequired) {
    // A rollback hard-stop is stronger than accepting the draft: preserve the
    // proposals for a manual decision, but never write world/characters here.
    return deferAwaitingRunForConfirmationUnlocked(
      projectId,
      state,
      maintenance,
      store,
      targetRun,
      session
    );
  }
  const currentHash = computeStaticSettingsHash({
    worldText: originalWorldText,
    characters: originalCharacters,
  });
  // Earlier safe static patches from this same run are already reflected in
  // resultStaticHash. They must not make the later draft-evidence continuation
  // look externally stale, while any unrelated change still must stop it.
  if (currentHash !== (targetRun.resultStaticHash ?? targetRun.sourceStaticHash)) {
    return staleAwaitingAutomationRunUnlocked(
      projectId,
      state,
      maintenance,
      '走査後に世界設定または人物設定が変更されたため、この提案は再検証できません。'
    );
  }

  const hasPendingAcknowledgement = store.runs.some((run) => run.acknowledgement === 'pending');
  let workingWorldText = originalWorldText;
  let workingCharacters = originalCharacters;
  let worldChangedOverall = false;
  let charactersChangedOverall = false;
  const now = nowIso();

  const nextPatches = session.patches.map((patch) => {
    if (
      patch.automationRunId !== runId ||
      patch.status !== 'pending' ||
      patch.sourceGenerationId !== sourceGeneration.generationId ||
      patch.evidenceScope !== 'draft'
    ) {
      return patch;
    }

    // NOTE: source generation が accepted になった時点で初めて、保存済み本文に対する
    // quote 検証をやり直す。draft 時の分類やモデルの自己申告をそのまま昇格させない。
    const attempted = applyPatchOperationsToSnapshot(workingWorldText, workingCharacters, patch.operations);
    if (!attempted.ok) {
      return { ...patch, status: 'rejected' as const, applyError: attempted.error };
    }
    const { riskLevel, riskReasons } = classifyPatchRisk({
      operations: patch.operations,
      characters: workingCharacters,
      worldText: workingWorldText,
      evidenceScope: 'accepted',
      evidenceQuote: patch.evidenceQuote,
      evidenceSourceText: sourceGeneration.responseText,
    });
    const shouldAutoApply =
      !hasPendingAcknowledgement &&
      (targetRun.mode === 'all' || (targetRun.mode === 'safe' && riskLevel === 'safe'));
    if (!shouldAutoApply) {
      return {
        ...patch,
        evidenceScope: 'accepted' as const,
        riskLevel,
        riskReasons,
      };
    }

    workingWorldText = attempted.worldText;
    workingCharacters = attempted.characters;
    worldChangedOverall = worldChangedOverall || attempted.worldChanged;
    charactersChangedOverall = charactersChangedOverall || attempted.charactersChanged;
    return {
      ...patch,
      evidenceScope: 'accepted' as const,
      status: 'applied' as const,
      appliedAt: now,
      applyError: undefined,
      riskLevel,
      riskReasons,
    };
  });

  const runPatches = nextPatches.filter((patch) => patch.automationRunId === runId);
  const appliedPatchIds = runPatches.filter((patch) => patch.status === 'applied').map((patch) => patch.patchId);
  const pendingPatchIds = runPatches.filter((patch) => patch.status === 'pending').map((patch) => patch.patchId);
  const reviewPatchIds = runPatches
    .filter((patch) => patch.status === 'pending' && patch.riskLevel === 'review')
    .map((patch) => patch.patchId);
  const highRiskAppliedPatchIds = runPatches
    .filter((patch) => patch.status === 'applied' && patch.riskLevel === 'review')
    .map((patch) => patch.patchId);
  const persistedWorld = worldChangedOverall ? parseWorldMd(workingWorldText) : undefined;
  const persistedWorldText = persistedWorld ? serializeWorldMd(persistedWorld) : workingWorldText;
  const nextRun: RefineAutomationRun = {
    ...targetRun,
    status: pendingPatchIds.length > 0 ? 'needsReview' : 'complete',
    completedAt: now,
    appliedPatchIds,
    pendingPatchIds,
    reviewPatchIds,
    highRiskAppliedPatchIds,
    acknowledgement: highRiskAppliedPatchIds.length > 0 && targetRun.mode === 'all' ? 'pending' : targetRun.acknowledgement,
    resultStaticHash: computeStaticSettingsHash({
      worldText: persistedWorldText,
      characters: workingCharacters,
    }),
  };
  const nextSession: RefineSession = {
    ...session,
    patches: nextPatches,
    revision: session.revision + 1,
    updatedAt: now,
    lastError: null,
  };
  const nextStore = pruneAutomationStore({
    ...store,
    runs: store.runs.map((run) => (run.runId === runId ? nextRun : run)),
  });

  await writeMaintenanceStatus(
    projectId,
    buildMaintenanceStatus(
      runId,
      targetRun.generationId,
      'applying',
      { appliedPatchIds, pendingPatchIds, reviewPatchIds },
      maintenance
    )
  );

  let succeeded = false;
  let failureMessage: string | undefined;
  try {
    if (persistedWorld) await storage.writeWorld(projectId, persistedWorld);
    if (charactersChangedOverall) await storage.writeCharacters(projectId, workingCharacters);
    await storage.writeRefineSession(projectId, nextSession);
    await storage.writeRefineAutomation(projectId, nextStore);
    succeeded = true;
    return nextRun;
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : '採用後の設定更新に失敗しました。';
    const failedRun: RefineAutomationRun = {
      ...nextRun,
      status: 'failed',
      errorMessage: failureMessage,
      completedAt: nowIso(),
    };
    const failedStore = pruneAutomationStore({
      ...store,
      runs: store.runs.map((run) => (run.runId === runId ? failedRun : run)),
    });
    const rollbackResults = await Promise.allSettled([
      ...(worldChangedOverall ? [storage.restoreWorldText(projectId, originalWorldText)] : []),
      ...(charactersChangedOverall ? [storage.writeCharacters(projectId, originalCharacters)] : []),
      storage.writeRefineSession(projectId, session),
      storage.writeRefineAutomation(projectId, failedStore),
    ]);
    if (rollbackResults.some((result) => result.status === 'rejected')) {
      await storage
        .writeRefineAutomation(
          projectId,
          pruneAutomationStore({
            ...failedStore,
            confirmationRequired: {
              reason: 'automation_rollback_failed',
              sinceRunId: runId,
              setAt: nowIso(),
            },
          })
        )
        .catch(() => undefined);
    }
    throw new RefineAutomationError('採用後の設定更新に失敗しました。', 'automation_apply_failed', true, 500);
  } finally {
    const terminal = buildMaintenanceStatus(
      runId,
      targetRun.generationId,
      succeeded ? nextRun.status : 'failed',
      {
        appliedPatchIds: succeeded ? appliedPatchIds : [],
        pendingPatchIds,
        reviewPatchIds,
      },
      maintenance
    );
    if (failureMessage) terminal.errorMessage = failureMessage;
    await writeMaintenanceStatus(projectId, terminal).catch((err) => {
      console.warn('Failed to clear maintenance phase after acceptance', { projectId, runId, err });
    });
  }
}

async function staleAwaitingAutomationRunUnlocked(
  projectId: string,
  state: NonNullable<Awaited<ReturnType<typeof storage.readState>>>,
  maintenance: RefineMaintenanceStatus,
  reason: string
): Promise<RefineAutomationRun | null> {
  const [store, existingSession] = await Promise.all([
    readAutomationStore(projectId),
    storage.readRefineSession(projectId),
  ]);
  const target = store.runs.find((run) => run.runId === maintenance.runId);
  const staleRun = target
    ? { ...target, status: 'stale' as const, completedAt: nowIso(), errorMessage: reason }
    : null;
  const nextStore = staleRun
    ? pruneAutomationStore({
        ...store,
        runs: store.runs.map((run) => (run.runId === maintenance.runId ? staleRun : run)),
      })
    : store;
  const nextSession = existingSession
    ? {
        ...existingSession,
        patches: existingSession.patches.map((patch) =>
          patch.automationRunId === maintenance.runId && patch.status === 'pending'
            ? { ...patch, status: 'stale' as const, applyError: reason }
            : patch
        ),
        revision: existingSession.revision + 1,
        updatedAt: nowIso(),
      }
    : null;
  const staleStatus = buildMaintenanceStatus(
    maintenance.runId,
    maintenance.generationId,
    'stale',
    {
      appliedPatchIds: maintenance.appliedPatchIds,
      pendingPatchIds: maintenance.pendingPatchIds,
      reviewPatchIds: maintenance.reviewPatchIds,
    },
    maintenance
  );
  staleStatus.errorMessage = reason;
  if (nextSession) await storage.writeRefineSession(projectId, nextSession);
  if (staleRun) await storage.writeRefineAutomation(projectId, nextStore);
  await storage.writeState(projectId, { ...state, refineMaintenance: staleStatus });
  return staleRun;
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
      evidenceSourceRef: patch.evidenceSourceRef,
    }));
}

interface RetryFailedAutomationRunOptions {
  failedRunId?: string;
  runId?: string;
  expectedMaintenanceRunId?: string;
}

export async function retryFailedAutomationRun(
  projectId: string,
  options: RetryFailedAutomationRunOptions = {}
): Promise<RefineAutomationRun> {
  const project = await projectService.getProject(projectId);
  if (!project) {
    throw new RefineAutomationError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const mode = effectiveRefineAutomationMode(project.refineAutomation);
  if (mode === 'off') {
    throw new RefineAutomationError('自動レビューはオフになっています。', 'automation_disabled', false, 409);
  }
  const store = await readAutomationStore(projectId);
  const latest = options.failedRunId
    ? store.runs.find((run) => run.runId === options.failedRunId)
    : store.runs[0];
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
    runId: options.runId,
    expectedMaintenanceRunId: options.expectedMaintenanceRunId,
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
