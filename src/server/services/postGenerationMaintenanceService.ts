import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { effectiveRefineAutomationMode } from '../types/index.js';
import { nowIso } from '../utils/date.js';
import { generateTimestampId } from '../utils/id.js';
import { renderAutomationEvidenceCharacters } from '../utils/automationEvidence.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import * as storage from './storageService.js';
import { reloadCredentials } from './credentialService.js';
import { withProjectWriteLock } from './projectLock.js';
import {
  buildMaintenanceStatus,
  continueAwaitingAcceptanceAutomationRun,
  markAutomationRunStaleUnlocked,
  readAutomationStore,
  RefineAutomationError,
  retryFailedAutomationRun,
  runRefineAutomationPipeline,
  type AutomationEvidenceSource,
  type AutomationPatchProposal,
} from './refineAutomationService.js';
import {
  getRefineReviewStatus,
  loadAcceptedSceneEvidence,
} from './refineScanService.js';
import {
  getOrCreateRefineSession,
  normalizeRefinePatchOperation,
  truncateHistory,
  withSessionLock,
} from './refineChatService.js';
import { computeStaticSettingsHash } from './refineRiskPolicy.js';
import {
  isPostGenerationMaintenanceJobRunning,
  registerPostGenerationMaintenanceJob,
  unregisterPostGenerationMaintenanceJob,
} from './postGenerationMaintenanceRegistry.js';
import type {
  Character,
  GenerationRecord,
  GenerationStatus,
  Project,
  ProjectState,
  RefineAutomationRun,
  RefineMaintenanceStatus,
  RefinePatchOperation,
  RefineSession,
  StoryState,
} from '../types/index.js';

const SCAN_OUTPUT_LENGTH = 2600;
const SCAN_TEMPERATURE = 0.25;
const SCAN_TIMEOUT_MS = 90_000;
const LEASE_HEARTBEAT_MS = 15_000;
const PROMPT_SNAPSHOT_MAX_CHARS = 3_000;

const TERMINAL_PHASES = new Set(['complete', 'needsReview', 'stale', 'failed']);

export interface PostGenerationMaintenanceReservation {
  runId?: string;
  maintenance?: RefineMaintenanceStatus;
}

interface ReservationInput {
  projectId: string;
  project: Project;
  state: ProjectState;
  generation: GenerationRecord;
  worldText: string;
  characters: Character[];
}

interface AutomationScanSnapshot {
  projectId: string;
  runId: string;
  project: Project;
  generation: GenerationRecord;
  worldText: string;
  characters: Character[];
  storyState: StoryState | null;
  sourceStaticHash: string;
  sourceStoryStateUpdatedAt: string | null;
  sourceAcceptedGenerationCount: number;
  promptSnapshot: string;
}

interface ParsedAutomationProposal {
  summary: string;
  operations: RefinePatchOperation[];
  evidenceScope: 'static' | 'accepted' | 'draft' | 'mixed';
  evidenceQuote?: string;
  evidenceSourceGenerationId?: string;
  evidenceSourceRef?: string;
}

// NOTE: この関数は generationService が保持する project write lock の内側から呼ぶ。
// draft の保存と scanning 予約を同じ state write に載せるため、ここで state を書かず
// 次の状態だけを返す。モデル走査は絶対にこの関数内で開始しない。
export async function reservePostGenerationMaintenanceUnlocked(
  input: ReservationInput
): Promise<PostGenerationMaintenanceReservation> {
  const previous = input.state.refineMaintenance;
  let staleMaintenance: RefineMaintenanceStatus | undefined;

  if (
    previous?.phase === 'awaitingAcceptance' &&
    previous.generationId !== input.generation.generationId
  ) {
    await markAutomationRunStaleUnlocked(
      input.projectId,
      previous.runId,
      '新しい生成案が選択されたため、この採用待ちの自動レビューは無効になりました。'
    );
    staleMaintenance = buildMaintenanceStatus(
      previous.runId,
      previous.generationId,
      'stale',
      {
        appliedPatchIds: previous.appliedPatchIds,
        pendingPatchIds: previous.pendingPatchIds,
        reviewPatchIds: previous.reviewPatchIds,
      },
      previous
    );
    staleMaintenance.errorMessage = '新しい生成案が選択されたため、この採用待ちは無効になりました。';
  }

  // 自動設定レビューは小説本文の world / characters にだけ作用する。ロールプレイや
  // 明示的 off では、上で stale 化した状態だけを表示して通常生成へ戻す。
  const mode = effectiveRefineAutomationMode(input.project.refineAutomation);
  if (mode === 'off' || input.project.projectType === 'roleplay') {
    return { maintenance: staleMaintenance };
  }

  const sourceStaticHash = computeStaticSettingsHash({
    worldText: input.worldText,
    characters: input.characters,
  });
  const shouldScan = await shouldScheduleScan({
    projectId: input.projectId,
    project: input.project,
    sourceStaticHash,
  });
  if (!shouldScan) return { maintenance: staleMaintenance };

  const runId = generateTimestampId('autorun');
  return {
    runId,
    maintenance: buildMaintenanceStatus(runId, input.generation.generationId, 'scanning'),
  };
}

async function shouldScheduleScan(input: {
  projectId: string;
  project: Project;
  sourceStaticHash: string;
}): Promise<boolean> {
  const settings = input.project.refineAutomation;
  if (!settings || effectiveRefineAutomationMode(settings) === 'off') return false;
  if (settings.scanPolicy === 'always') return true;

  const [store, storyState, reviewStatus, acceptedGenerationCount] = await Promise.all([
    readAutomationStore(input.projectId),
    storage.readStoryState(input.projectId),
    getRefineReviewStatus(input.projectId),
    countAcceptedGenerations(input.projectId),
  ]);
  const latestSuccessful = store.runs.find(
    (run) => run.status === 'complete' || run.status === 'needsReview' || run.status === 'awaitingAcceptance'
  );
  if (!latestSuccessful) return true;
  // NOTE: 同じ run が適用した変更で static hash が変わっていても、それを次の自動走査
  // 原因にしてはいけない。保存後の resultStaticHash を基準にし、手動編集だけを drift と
  // して検出する（§7.7）。
  if ((latestSuccessful.resultStaticHash ?? latestSuccessful.sourceStaticHash) !== input.sourceStaticHash) {
    return true;
  }
  if ((latestSuccessful.sourceStoryStateUpdatedAt ?? null) !== (storyState?.updatedAt ?? null)) return true;
  if (acceptedGenerationCount - latestSuccessful.sourceAcceptedGenerationCount >= 3) return true;
  const onlyOwnSettingsChange =
    reviewStatus.reasons.length > 0 && reviewStatus.reasons.every((reason) => reason === 'settings_changed');
  return reviewStatus.needsReview && !onlyOwnSettingsChange;
}

async function countAcceptedGenerations(projectId: string): Promise<number> {
  const episodeIds = await storage.listEpisodeIds(projectId);
  const episodes = await Promise.all(episodeIds.map((episodeId) => storage.readEpisodeRecord(projectId, episodeId)));
  return episodes.reduce(
    (count, episode) => count + (episode?.scenes.filter((scene) => scene.acceptedGenerationId !== null).length ?? 0),
    0
  );
}

// NOTE: generationService は予約済み state を保存して lock を解放してから、この関数を
// fire-and-forget で呼ぶ。job map はプロセス内の重複防止だけを担当し、永続正本は state。
export function startPostGenerationMaintenance(
  projectId: string,
  generationId: string,
  runId: string
): void {
  if (!registerPostGenerationMaintenanceJob(projectId, runId)) return;
  void runPostGenerationMaintenance(projectId, generationId, runId).finally(() => {
    unregisterPostGenerationMaintenanceJob(projectId, runId);
  });
}

export async function runPostGenerationMaintenance(
  projectId: string,
  generationId: string,
  runId: string
): Promise<void> {
  const snapshot = await readReservedSnapshot(projectId, generationId, runId);
  if (!snapshot) return;

  const heartbeat = startLeaseHeartbeat(projectId, generationId, runId);
  try {
    const { proposals, evidenceSources } = await scanGenerationForAutomation(snapshot);
    const run = await runRefineAutomationPipeline(projectId, {
      generationId,
      mode: effectiveRefineAutomationMode(snapshot.project.refineAutomation),
      usedModel: snapshot.generation.usedModel,
      proposals,
      acceptedGenerationCount: snapshot.sourceAcceptedGenerationCount,
      scannedStaticHash: snapshot.sourceStaticHash,
      scannedStoryStateUpdatedAt: snapshot.sourceStoryStateUpdatedAt,
      runId,
      expectedMaintenanceRunId: runId,
      evidenceSources,
    });
    void run;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as { code?: unknown }).code) : '';
    if (code === 'automation_slot_stale') return;
    if (code === 'automation_scan_stale') {
      await finalizeReservedRunAsStale(
        projectId,
        generationId,
        runId,
        '走査中に設定が変更されたため、この自動レビューは適用しませんでした。'
      );
    } else {
      await recordAutomationScanFailure(projectId, snapshot, error);
    }
  } finally {
    clearInterval(heartbeat);
    await startStoryStateRefreshIfOwnedByMaintenance(projectId, runId);
  }
}

function startLeaseHeartbeat(projectId: string, generationId: string, runId: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void renewScanningLease(projectId, generationId, runId);
  }, LEASE_HEARTBEAT_MS);
  // NOTE: 実ジョブが存在する限り process を生かす必要はない。終了処理を妨げないよう
  // Node の timer だけを unref する。
  timer.unref?.();
  return timer;
}

async function renewScanningLease(projectId: string, generationId: string, runId: string): Promise<void> {
  await withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    if (
      !state ||
      !maintenance ||
      maintenance.runId !== runId ||
      maintenance.generationId !== generationId ||
      maintenance.phase !== 'scanning'
    ) {
      return;
    }
    await storage.writeState(projectId, {
      ...state,
      refineMaintenance: {
        ...maintenance,
        updatedAt: nowIso(),
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });
  });
}

async function readReservedSnapshot(
  projectId: string,
  generationId: string,
  runId: string
): Promise<AutomationScanSnapshot | null> {
  return withProjectWriteLock(projectId, async () => {
    const [project, state, generation, worldText, characters, storyState, promptSnapshot] = await Promise.all([
      storage.readProject(projectId),
      storage.readState(projectId),
      storage.findGenerationRecord(projectId, generationId),
      storage.readWorldText(projectId),
      storage.readCharacters(projectId),
      storage.readStoryState(projectId),
      storage.readGenerationPromptSnapshot(projectId, generationId),
    ]);
    const maintenance = state?.refineMaintenance;
    if (
      !project ||
      !state ||
      !generation ||
      !maintenance ||
      maintenance.runId !== runId ||
      maintenance.generationId !== generationId ||
      maintenance.phase !== 'scanning'
    ) {
      return null;
    }
    if (generation.status !== 'draft' && generation.status !== 'accepted') {
      await finalizeReservedRunAsStaleUnlocked(
        projectId,
        state,
        maintenance,
        '対象の生成案が採用対象ではなくなったため、自動走査を中止しました。'
      );
      return null;
    }
    return {
      projectId,
      runId,
      project,
      generation,
      worldText,
      characters,
      storyState,
      sourceStaticHash: computeStaticSettingsHash({ worldText, characters }),
      sourceStoryStateUpdatedAt: storyState?.updatedAt ?? null,
      sourceAcceptedGenerationCount: await countAcceptedGenerations(projectId),
      promptSnapshot,
    };
  });
}

async function scanGenerationForAutomation(snapshot: AutomationScanSnapshot): Promise<{
  proposals: AutomationPatchProposal[];
  evidenceSources: AutomationEvidenceSource[];
}> {
  await reloadCredentials();
  const adapter = adapterMap[snapshot.project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${snapshot.project.activeModelProvider}`);

  const [presets, cachedScan, diffs, reviewStatus] = await Promise.all([
    storage.readPresets(snapshot.projectId),
    storage.readRefineScan(snapshot.projectId),
    storage.readStoryStateDiffs(snapshot.projectId),
    getRefineReviewStatus(snapshot.projectId),
  ]);
  const systemPromptResolution = await resolveSystemPrompt(
    snapshot.project.activePresetIds,
    presets?.customSystemPrompt ?? null,
    presets?.baseSystemPrompt
  );
  const acceptedEvidence = await loadAcceptedSceneEvidence(
    snapshot.project,
    diffs,
    reviewStatus,
    cachedScan?.reviewedStoryStateDiffId
  );
  const evidenceSources = buildEvidenceSources(snapshot, acceptedEvidence.evidence);
  const { systemInstructions, userPrompt } = buildAutomationScanPrompt({
    snapshot,
    systemPrompt: systemPromptResolution.systemPrompt,
    acceptedEvidence: acceptedEvidence.evidence,
    omittedEvidenceCount: acceptedEvidence.omittedCount,
  });

  let result;
  try {
    result = await adapter.generateText({
      systemInstructions,
      userPrompt,
      outputLength: SCAN_OUTPUT_LENGTH,
      temperature: SCAN_TEMPERATURE,
      timeoutMs: SCAN_TIMEOUT_MS,
      modelName: snapshot.project.activeModelName,
      responseMimeType: 'application/json',
    });
  } catch (error) {
    if (error instanceof ModelAdapterError) {
      throw new Error(`モデル呼び出しに失敗しました: ${error.message}`);
    }
    throw error;
  }
  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    throw new Error(result.errorMessage || '自動設定レビューのモデル応答が得られませんでした。');
  }
  const proposals = parseAutomationProposals(result.text, snapshot.characters, snapshot.generation.generationId);
  if (!proposals) throw new Error('自動設定レビューの応答を JSON として解釈できませんでした。');
  return { proposals, evidenceSources };
}

function buildEvidenceSources(
  snapshot: AutomationScanSnapshot,
  acceptedEvidence: Array<{ generationId: string; sceneId: string; text: string }>
): AutomationEvidenceSource[] {
  return [
    { sourceRef: 'static:world', scope: 'static', text: snapshot.worldText },
    {
      sourceRef: 'static:characters',
      scope: 'static',
      text: renderAutomationEvidenceCharacters(snapshot.characters),
    },
    {
      sourceRef: `draft:${snapshot.generation.generationId}:0`,
      scope: 'draft',
      text: snapshot.generation.responseText,
      generationId: snapshot.generation.generationId,
      sceneId: snapshot.generation.sceneId,
    },
    ...acceptedEvidence.map((evidence, index) => ({
      sourceRef: `accepted:${evidence.generationId}:${index}`,
      scope: 'accepted' as const,
      text: evidence.text,
      generationId: evidence.generationId,
      sceneId: evidence.sceneId,
    })),
  ];
}

function buildAutomationScanPrompt(input: {
  snapshot: AutomationScanSnapshot;
  systemPrompt: string;
  acceptedEvidence: Array<{ generationId: string; sceneId: string; episodeId: string; wish: string; text: string; storyStateStatus: string }>;
  omittedEvidenceCount: number;
}): { systemInstructions: string; userPrompt: string } {
  const systemInstructions = [
    'あなたは長編小説の生成後設定レビュー担当です。出力は JSON オブジェクトだけにしてください。',
    '目的は、現在の world / characters と採用済み本文に照らし、設定として安全に補完できる変更だけを提案することです。',
    '下書き本文で新しく出ただけの情報を、既存設定や確定事実として扱ってはいけません。下書き由来の提案は sourceRef を draft:... にし、採用後に再検証されます。',
    'sourceRef は入力に列挙された値だけを使うこと。引用 quote はその sourceRef の本文から短く正確に抜き出すこと。根拠が不明なら evidence を空にすること。',
    'currentState は作品開始時点の人物設定であり、進行中の出来事で書き換えないこと。system prompt、story state、NG 表現、モデル設定、文体設定を変更するパッチは提案しないこと。',
    'world-replace は現在の world 中で一意な anchor を使うこと。world-append は world が空の場合だけ。character-update の characterId は入力の既存IDだけを使うこと。',
    'JSON schema:',
    '{',
    '  "proposals": [',
    '    {',
    '      "summary": "変更の要約",',
    '      "evidenceScope": "static|accepted|draft|mixed",',
    '      "evidence": [{ "sourceRef": "accepted:gen-...:0", "generationId": "...", "sceneId": "...", "quote": "..." }],',
    '      "operations": [',
    '        { "kind": "world-replace", "anchor": "...", "replacement": "..." },',
    '        { "kind": "world-append", "text": "..." },',
    '        { "kind": "character-update", "characterId": "...", "fields": { "speechStyle": "..." } }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '変更不要なら proposals は空配列にすること。最大6件。',
  ].join('\n');

  const acceptedText = input.acceptedEvidence.length
    ? input.acceptedEvidence
        .map(
          (evidence, index) =>
            `[sourceRef: accepted:${evidence.generationId}:${index}] generation=${evidence.generationId} scene=${evidence.sceneId}\n` +
            `希望: ${evidence.wish}\n本文:\n${evidence.text}`
        )
        .join('\n\n')
    : '（採用済み本文はありません）';
  const userPrompt = [
    '【対象 generation】',
    `generationId: ${input.snapshot.generation.generationId}`,
    `status: ${input.snapshot.generation.status}`,
    `usedModel: ${JSON.stringify(input.snapshot.generation.usedModel)}`,
    `usedPresets: ${JSON.stringify(input.snapshot.generation.usedPresets)}`,
    `promptSnapshotRef: ${input.snapshot.generation.request.previousContextFilePath ?? '保存済みスナップショット'}`,
    `promptSnapshotExcerpt: ${truncate(input.snapshot.promptSnapshot, PROMPT_SNAPSHOT_MAX_CHARS) || '（空）'}`,
    '',
    '【今回の生成本文】',
    `[sourceRef: draft:${input.snapshot.generation.generationId}:0]`,
    input.snapshot.generation.responseText,
    '',
    '【現在の world】',
    '[sourceRef: static:world]',
    input.snapshot.worldText || '（未設定）',
    '',
    '【現在の characters】',
    '[sourceRef: static:characters]',
    renderAutomationEvidenceCharacters(input.snapshot.characters),
    '',
    '【現在の system prompt】',
    input.systemPrompt || '（未設定）',
    '',
    '【現在の story state】',
    input.snapshot.storyState ? JSON.stringify(input.snapshot.storyState) : '（未生成）',
    '',
    '【採用済み過去本文の根拠】',
    acceptedText,
    input.omittedEvidenceCount > 0 ? `（長さのため ${input.omittedEvidenceCount} 件を省略）` : '',
  ].join('\n');
  return { systemInstructions, userPrompt };
}

function parseAutomationProposals(
  text: string,
  characters: Character[],
  draftGenerationId: string
): AutomationPatchProposal[] | null {
  const object = parseJsonObject(text);
  if (!object) return null;
  const rawProposals = Array.isArray(object.proposals) ? object.proposals : [];
  const proposals: AutomationPatchProposal[] = [];
  for (const raw of rawProposals.slice(0, 6)) {
    if (!isRecord(raw)) continue;
    const rawOperations = Array.isArray(raw.operations) ? raw.operations : [];
    const operations = rawOperations
      .map((operation) => normalizeRefinePatchOperation(operation, characters))
      .filter((operation): operation is RefinePatchOperation => operation !== null);
    if (operations.length === 0) continue;
    const evidenceEntries = Array.isArray(raw.evidence) ? raw.evidence.filter(isRecord) : [];
    const evidence = evidenceEntries.length === 1 ? evidenceEntries[0] : undefined;
    // Multi-source evidence cannot safely be auto-verified as a single quote.
    // Preserve a server-verifiable draft taint so mode=all still waits for acceptance.
    const includesCurrentDraft = evidenceEntries.some(
      (entry) => entry.sourceRef === `draft:${draftGenerationId}:0`
    );
    const scope = raw.evidenceScope;
    proposals.push({
      summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : '設定の変更提案',
      operations,
      // A patch that cites more than one source can include a draft-only
      // premise. Keep it review-only until a future schema preserves and
      // verifies every source reference rather than trusting the first one.
      evidenceScope:
        evidenceEntries.length === 1 &&
        (scope === 'static' || scope === 'accepted' || scope === 'draft' || scope === 'mixed')
          ? scope
          : 'mixed',
      ...(evidence && typeof evidence.quote === 'string' ? { evidenceQuote: evidence.quote } : {}),
      ...(evidence && typeof evidence.generationId === 'string'
        ? { evidenceSourceGenerationId: evidence.generationId }
        : includesCurrentDraft
          ? { evidenceSourceGenerationId: draftGenerationId }
        : {}),
      ...(evidence && typeof evidence.sourceRef === 'string' ? { evidenceSourceRef: evidence.sourceRef } : {}),
    });
  }
  return proposals;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const tryParse = (candidate: string) => {
    try {
      const value = JSON.parse(candidate);
      return isRecord(value) ? value : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const value = tryParse(fenced[1].trim());
    if (value) return value;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start >= 0 && end > start ? tryParse(trimmed.slice(start, end + 1)) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

async function recordAutomationScanFailure(
  projectId: string,
  snapshot: AutomationScanSnapshot,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : '自動設定レビューに失敗しました。';
  await withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, async () => {
      const state = await storage.readState(projectId);
      const maintenance = state?.refineMaintenance;
      if (
        !state ||
        !maintenance ||
        maintenance.runId !== snapshot.runId ||
        maintenance.phase !== 'scanning'
      ) {
        return;
      }
      const [store, session] = await Promise.all([
        readAutomationStore(projectId),
        getOrCreateRefineSession(projectId),
      ]);
      const now = nowIso();
      const failedRun: RefineAutomationRun = {
        schemaVersion: 1,
        runId: snapshot.runId,
        generationId: snapshot.generation.generationId,
        status: 'failed',
        mode: effectiveRefineAutomationMode(snapshot.project.refineAutomation),
        usedModel: snapshot.generation.usedModel,
        createdAt: maintenance.startedAt,
        completedAt: now,
        sourceStaticHash: snapshot.sourceStaticHash,
        sourceStoryStateUpdatedAt: snapshot.sourceStoryStateUpdatedAt,
        sourceAcceptedGenerationCount: snapshot.sourceAcceptedGenerationCount,
        patchIds: [],
        appliedPatchIds: [],
        pendingPatchIds: [],
        reviewPatchIds: [],
        highRiskAppliedPatchIds: [],
        resultStaticHash: snapshot.sourceStaticHash,
        errorMessage: message,
      };
      const systemMessage = {
        messageId: generateTimestampId('msg'),
        role: 'system' as const,
        content: `生成案「${snapshot.generation.generationId}」の自動設定レビューに失敗しました。`,
        createdAt: now,
        patchIds: [],
        automationRunId: snapshot.runId,
      };
      const nextSession: RefineSession = {
        ...session,
        messages: truncateHistory([...session.messages, systemMessage]),
        revision: session.revision + 1,
        updatedAt: now,
        lastError: message,
      };
      const nextStore = {
        ...store,
        runs: [failedRun, ...store.runs.filter((run) => run.runId !== snapshot.runId)].slice(0, 50),
      };
      const failedStatus = buildMaintenanceStatus(
        snapshot.runId,
        snapshot.generation.generationId,
        'failed',
        { appliedPatchIds: [], pendingPatchIds: [], reviewPatchIds: [] },
        maintenance
      );
      failedStatus.errorMessage = message;
      await storage.writeRefineSession(projectId, nextSession);
      await storage.writeRefineAutomation(projectId, nextStore);
      await storage.writeState(projectId, { ...state, refineMaintenance: failedStatus });
    })
  );
}

async function finalizeReservedRunAsStale(
  projectId: string,
  generationId: string,
  runId: string,
  reason: string
): Promise<void> {
  await withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    if (
      !state ||
      !maintenance ||
      maintenance.runId !== runId ||
      maintenance.generationId !== generationId ||
      !['scanning', 'applying'].includes(maintenance.phase)
    ) {
      return;
    }
    await finalizeReservedRunAsStaleUnlocked(projectId, state, maintenance, reason);
  });
}

async function finalizeReservedRunAsStaleUnlocked(
  projectId: string,
  state: ProjectState,
  maintenance: RefineMaintenanceStatus,
  reason: string
): Promise<void> {
  await markAutomationRunStaleUnlocked(projectId, maintenance.runId, reason);
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
  await storage.writeState(projectId, { ...state, refineMaintenance: staleStatus });
}

// NOTE: acceptGeneration は本文採用だけを project lock 内で確定し、設定反映はこの
// 統括へ委譲する。scanning 中なら既存job（または再起動後の復元job）へ任せ、
// awaitingAcceptance なら session lock → project lock で再検証・適用する。
export async function continuePostGenerationMaintenanceAfterAcceptance(
  projectId: string,
  generationId: string,
  runId: string
): Promise<void> {
  const maintenance = (await storage.readState(projectId))?.refineMaintenance;
  if (!maintenance || maintenance.runId !== runId || maintenance.generationId !== generationId) return;

  if (maintenance.phase === 'scanning') {
    if (!isPostGenerationMaintenanceJobRunning(projectId, runId)) {
      startPostGenerationMaintenance(projectId, generationId, runId);
    }
    return;
  }
  if (maintenance.phase === 'awaitingAcceptance') {
    try {
      await continueAwaitingAcceptanceAutomationRun(projectId, runId);
    } catch (error) {
      // The acceptance itself is already durable. The continuation marks its
      // run failed in its own finally block; still claim the persisted refresh
      // continuation so a settings-write failure cannot strand story refresh.
      console.warn('Failed to apply accepted draft-evidence automation patches', {
        projectId,
        generationId,
        runId,
        error,
      });
    }
  }
  await startStoryStateRefreshIfOwnedByMaintenance(projectId, runId);
}

// NOTE: apply 保存失敗は既存 Phase B の proposal 再試行を使う。一方、モデル走査そのものが
// 失敗した run は patch が無いため、新しい reservation を作ってもう一度だけモデル走査する。
export async function retryFailedPostGenerationMaintenance(projectId: string): Promise<RefineAutomationRun> {
  const retry = await withProjectWriteLock(projectId, async () => {
    const [project, store, state] = await Promise.all([
      storage.readProject(projectId),
      readAutomationStore(projectId),
      storage.readState(projectId),
    ]);
    if (!project || !state) {
      throw new RefineAutomationError('作品が見つかりません。', 'project_not_found', false, 404);
    }
    const mode = effectiveRefineAutomationMode(project.refineAutomation);
    if (mode === 'off') {
      throw new RefineAutomationError('自動レビューはオフになっています。', 'automation_disabled', false, 409);
    }
    const latest = store.runs[0];
    if (!latest || latest.status !== 'failed') {
      throw new RefineAutomationError(
        '再試行できる失敗した自動レビューがありません。',
        'no_failed_automation_run',
        false,
        404
      );
    }
    if (state.refineMaintenance && !TERMINAL_PHASES.has(state.refineMaintenance.phase)) {
      throw new RefineAutomationError(
        '別の自動レビューが実行中です。状態を更新してから再試行してください。',
        'post_generation_maintenance_in_progress',
        true,
        409
      );
    }

    const runId = generateTimestampId('autorun');
    const maintenance = buildMaintenanceStatus(runId, latest.generationId, 'scanning');
    await storage.writeState(projectId, { ...state, refineMaintenance: maintenance });

    if (latest.patchIds.length > 0) {
      return { kind: 'patch' as const, latest, mode, runId, maintenance };
    }

    const [generation, worldText, characters] = await Promise.all([
      storage.findGenerationRecord(projectId, latest.generationId),
      storage.readWorldText(projectId),
      storage.readCharacters(projectId),
    ]);
    if (!generation || (generation.status !== 'draft' && generation.status !== 'accepted')) {
      const failed = buildMaintenanceStatus(runId, latest.generationId, 'failed', undefined, maintenance);
      failed.errorMessage = '対象の生成案が利用できないため、走査を再試行できません。';
      await storage.writeState(projectId, { ...state, refineMaintenance: failed });
      throw new RefineAutomationError(
        '対象の生成案が利用できないため、走査を再試行できません。',
        'automation_retry_source_unavailable',
        false,
        409
      );
    }
    return {
      kind: 'scan' as const,
      mode,
      runId,
      generation,
      maintenance,
      sourceStaticHash: computeStaticSettingsHash({ worldText, characters }),
      sourceAcceptedGenerationCount: await countAcceptedGenerations(projectId),
    };
  });

  if (retry.kind === 'patch') {
    try {
      return await retryFailedAutomationRun(projectId, {
        failedRunId: retry.latest.runId,
        runId: retry.runId,
        expectedMaintenanceRunId: retry.runId,
      });
    } catch (error) {
      await markReservedRetryFailed(projectId, retry.runId, retry.latest.generationId, error);
      throw error;
    }
  }

  startPostGenerationMaintenance(projectId, retry.generation.generationId, retry.runId);
  return {
    schemaVersion: 1,
    runId: retry.runId,
    generationId: retry.generation.generationId,
    status: 'scanning',
    mode: retry.mode,
    usedModel: retry.generation.usedModel,
    createdAt: retry.maintenance.startedAt,
    sourceStaticHash: retry.sourceStaticHash,
    sourceStoryStateUpdatedAt: null,
    sourceAcceptedGenerationCount: retry.sourceAcceptedGenerationCount,
    patchIds: [],
    appliedPatchIds: [],
    pendingPatchIds: [],
    reviewPatchIds: [],
    highRiskAppliedPatchIds: [],
  };
}

async function markReservedRetryFailed(
  projectId: string,
  runId: string,
  generationId: string,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : '自動設定レビューの再試行に失敗しました。';
  await withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    if (
      !state ||
      !maintenance ||
      maintenance.runId !== runId ||
      maintenance.generationId !== generationId ||
      !['scanning', 'applying'].includes(maintenance.phase)
    ) {
      return;
    }
    const failed = buildMaintenanceStatus(runId, generationId, 'failed', undefined, maintenance);
    failed.errorMessage = message;
    await storage.writeState(projectId, { ...state, refineMaintenance: failed });
  });
}

async function startStoryStateRefreshIfOwnedByMaintenance(projectId: string, runId: string): Promise<void> {
  const generationId = await withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    const continuation = maintenance?.postAcceptanceContinuation;
    if (
      !state ||
      !maintenance ||
      maintenance.runId !== runId ||
      !continuation ||
      continuation.owner !== 'maintenance' ||
      !TERMINAL_PHASES.has(maintenance.phase)
    ) {
      return null;
    }
    const { postAcceptanceContinuation: _continuation, ...withoutContinuation } = maintenance;
    await storage.writeState(projectId, { ...state, refineMaintenance: withoutContinuation });
    return continuation.generationId;
  });
  if (!generationId) return;

  // generationService からこのサービスを動的 import するため、ここも runtime import にして
  // module 初期化の循環を作らない。claim を先に永続化しているので重複起動しない。
  const generationService = await import('./generationService.js');
  generationService.startStoryStateRefreshAfterAcceptance(projectId, generationId);
}
