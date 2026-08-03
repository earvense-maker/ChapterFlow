import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { isDevDiagnosticsEnabled } from '../utils/devDiagnostics.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { buildPrompt, type BuildPromptResult } from '../prompts/promptBuilder.js';
import * as expressionService from './expressionService.js';
import * as knowledgeService from './knowledgeService.js';
import {
  buildEpisodeMarkdown,
  getContextGenerationIdsThroughCurrentScene,
  getCurrentSceneReferenceGenerationId,
  getRecentContextGenerationIds,
} from '../prompts/contextAssembler.js';
import { trimTrailingTextToSentenceBoundary } from '../utils/textBoundary.js';
import { runOutsideDataDirWrite, withDataDirWrite } from './dataDirLock.js';
import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import {
  revertLatestStoryStateDiffForGeneration,
} from './storyStateService.js';
import { writeShortcut } from './shortcutService.js';

import { withProjectWriteLock } from './projectLock.js';
export { withProjectWriteLock } from './projectLock.js';
import {
  assertGenerationNotBlockedByMaintenance,
  MaintenanceInProgressError,
  maintenanceBlocksGeneration,
  RefineAutomationError,
} from './refineAutomationGuard.js';

import {
  queueAcceptedGenerationStyleAnalysis,
  selectGenerationStyleProfile,
} from './styleVariationService.js';
import type {
  AdapterGenerateResult,
  ContextCompressionResult,
  Character,
  EpisodeRecord,
  FinishReason,
  GenerationRecord,
  GenerationTelemetry,
  Project,
  ProjectState,
  ReaderState,
  SceneNavigationDirection,
  SceneRecord,
} from '../types/index.js';
export { GenerateError } from './generationErrors.js';
import {
  GenerateError,
  classifyEmptyResponse,
  mapErrorMessage,
  throwIfAborted,
} from './generationErrors.js';
import {
  generateTextStreamWithPenaltyRetry,
  generateWithAdapter,
} from './generationAdapter.js';
import { countPromptTokens, resolveModelTokenLimits } from './modelInfoService.js';
import {
  checkPromptTokenBudget,
  NOVEL_TOTAL_PROMPT_MAX_CHARS,
  tokensToReducibleChars,
} from '../prompts/promptBudget.js';
import { resolveNovelMaxOutputTokens } from '../utils/outputLength.js';
import type { PromptBudgetReport } from '../../shared/types/generation.js';
import {
  buildReaderContextUsage,
  buildStoryStateRefreshStatus,
  findGeneration,
  getReaderState,
  startStoryStateRefreshAfterAcceptance,
  writeStoryStateRefreshUnlocked,
} from './generationReaderState.js';
export {
  calculateStoryStateBacklog,
  findGeneration,
  getGenerationMarkdown,
  getReaderState,
  readStoryStateBacklog,
  refreshStoryState,
  startStoryStateRefreshAfterAcceptance,
} from './generationReaderState.js';

const TEMPERATURE_DEFAULT = 0.9;
const TEMPERATURE_VARIATE_DELTA = 0.15;
const TEMPERATURE_MAX = 1.3;
const TEMPERATURE_SUMMARY = 0.25;

// NOTE: 設定画面の temperature スライダは 0〜1.3 で保存される。variate モード
// (「少し変える」) では +0.15 を上乗せする (上限 1.3)。summary は独立に固定。
function resolveTemperature(
  configured: number | undefined,
  mode: GenerateOptions['mode']
): number {
  const base =
    typeof configured === 'number' && Number.isFinite(configured)
      ? Math.min(Math.max(configured, 0), TEMPERATURE_MAX)
      : TEMPERATURE_DEFAULT;
  if (mode === 'variate') return Math.min(base + TEMPERATURE_VARIATE_DELTA, TEMPERATURE_MAX);
  return base;
}
// NOTE: ストリーミング生成では「無通信タイムアウト」（イベント受信ごとにリセット）、
// 非ストリーミングでは従来どおり総時間。非ストリーミングで長い文字数設定＋遅い
// モデルだと総時間側に当たりうるが、既定はストリーミングなので据え置き。
const TIMEOUT_MS = 120_000;
const SUMMARY_CHUNK_CHARS = 20_000;
// NOTE: 要約はロールプレイの ROLEPLAY_SUMMARY_MAX_CHARS と同じ 6,000 字を上限にする。
// 小説プロンプト全体 80,000 字（NOVEL_TOTAL_PROMPT_MAX_CHARS）に対して 7.5%、直近本文
// 12,000 字の半分。上限を小さくすると再圧縮の回数が増えて事実がパラフレーズで摩耗する
// ため、「小さいほど安全」ではないことに注意。
const CONTEXT_SUMMARY_MAX_CHARS = 6_000;
// NOTE: 圧縮呼び出しの出力枠。上限 6,000 字を書ける枠が無いと、上限を上げても
// モデル側で頭打ちになる（以前は 1,800 字だった）。
const CONTEXT_SUMMARY_OUTPUT_LENGTH = 6_000;
// NOTE: 採用のたびに畳むと生成1回につきモデル呼び出しが1回増える。窓から落ちた場面が
// この数だけ溜まってから畳むことで呼び出しを間引き、1回の要約が見る材料も増やす。
// 明示実行（POST /context/compress）はこの閾値を使わず、1場面でも畳む。
const CONTEXT_SUMMARY_MIN_PENDING = 3;

// NOTE: 文脈要約はモデル呼び出し中に project write lock を手放すため、要約同士には
// 専用の直列化が要る。手動圧縮と採用後ジョブが同じ旧要約から並行生成すると、遅く
// 終わった方が新しい要約を上書きし、畳み済みIDだけが先へ進む可能性がある。
const contextSummaryMutexes = new Map<string, Promise<void>>();

export interface GenerateOptions {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
  // NOTE: null / 未指定は「自動」。旧クライアントの request には無いので optional。
  viewpointCharacterId?: string | null;
}

export interface GenerateStreamOptions extends GenerateOptions {
  abortSignal?: AbortSignal;
}

interface GeneratedSceneResult {
  record: GenerationRecord;
  maintenanceRunId?: string;
}

interface GenerationRequestClock {
  startedAt: string;
  startedMs: number;
}

function startGenerationRequestClock(): GenerationRequestClock {
  const startedMs = Date.now();
  return { startedAt: new Date(startedMs).toISOString(), startedMs };
}

function elapsedMs(startedMs: number, completedMs: number): number {
  return Math.max(0, completedMs - startedMs);
}

function elapsedFromIso(startedMs: number, timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const completedMs = Date.parse(timestamp);
  return Number.isFinite(completedMs) ? elapsedMs(startedMs, completedMs) : undefined;
}

function buildGenerationTelemetry(input: {
  requestClock: GenerationRequestClock;
  modelStartedMs: number;
  modelCompletedMs: number;
  usage?: AdapterGenerateResult['rawUsage'];
  streamMetrics?: {
    firstProviderEventAt?: string;
    firstReasoningAt?: string;
    firstContentAt?: string;
    reasoningChars: number;
    reasoningChunks: number;
    contentChars: number;
    contentChunks: number;
  };
}): GenerationTelemetry {
  const metrics = input.streamMetrics;
  const timeToFirstProviderEventMs = elapsedFromIso(input.modelStartedMs, metrics?.firstProviderEventAt);
  const timeToFirstReasoningMs = elapsedFromIso(input.modelStartedMs, metrics?.firstReasoningAt);
  const timeToFirstContentMs = elapsedFromIso(input.modelStartedMs, metrics?.firstContentAt);
  return {
    schemaVersion: 1,
    requestStartedAt: input.requestClock.startedAt,
    modelRequestStartedAt: new Date(input.modelStartedMs).toISOString(),
    modelCompletedAt: new Date(input.modelCompletedMs).toISOString(),
    ...(metrics?.firstProviderEventAt ? { firstProviderEventAt: metrics.firstProviderEventAt } : {}),
    ...(metrics?.firstReasoningAt ? { firstReasoningAt: metrics.firstReasoningAt } : {}),
    ...(metrics?.firstContentAt ? { firstContentAt: metrics.firstContentAt } : {}),
    requestToModelMs: elapsedMs(input.requestClock.startedMs, input.modelStartedMs),
    modelDurationMs: elapsedMs(input.modelStartedMs, input.modelCompletedMs),
    totalDurationMs: elapsedMs(input.requestClock.startedMs, input.modelCompletedMs),
    ...(timeToFirstProviderEventMs !== undefined ? { timeToFirstProviderEventMs } : {}),
    ...(timeToFirstReasoningMs !== undefined ? { timeToFirstReasoningMs } : {}),
    ...(timeToFirstContentMs !== undefined ? { timeToFirstContentMs } : {}),
    ...(metrics
      ? {
          reasoningChars: metrics.reasoningChars,
          reasoningChunks: metrics.reasoningChunks,
          contentChars: metrics.contentChars,
          contentChunks: metrics.contentChunks,
        }
      : {}),
    ...(input.usage ? { usage: input.usage } : {}),
  };
}

async function persistGenerationReasoning(
  projectId: string,
  generationId: string,
  reasoningParts: readonly string[]
): Promise<void> {
  const reasoningText = reasoningParts.join('');
  if (!reasoningText.trim()) return;

  try {
    await storage.writeGenerationReasoningSnapshot(projectId, generationId, reasoningText);
  } catch (error) {
    // NOTE: Diagnostic persistence must never turn a successful prose
    // generation into a failure. Do not include the reasoning text here.
    console.warn('Failed to save generation reasoning diagnostics', {
      projectId,
      generationId,
      error,
    });
  }
}

async function resolveStyleProfileForGeneration(
  project: Project,
  options: GenerateOptions,
  rewriteTargetGenerationId: string | null
) {
  try {
    return await selectGenerationStyleProfile({
      project,
      mode: options.mode,
      targetGenerationId: rewriteTargetGenerationId,
      wish: options.wish,
    });
  } catch (error) {
    // NOTE: 文体変調は本文生成を止めない補助機能。破損した旧profileやtraceの
    // 読込失敗時も、レンズなしの既存生成経路へ縮退する。
    console.warn('Style profile selection failed; continuing without style variation', {
      projectId: project.projectId,
      mode: options.mode,
      error,
    });
    return undefined;
  }
}

export async function generateScene(
  projectId: string,
  options: GenerateOptions
): Promise<GenerationRecord> {
  const requestClock = startGenerationRequestClock();
  // NOTE: 期限切れ lease の failed 正規化はロック取得を伴うため、
  // withProjectWriteLock の外側で行う必要がある（ガード内で再度 withProjectWriteLock
  // に入るとデッドロックする）。ここで先に guard を通しておけば、maintenance state を
  // 書き換える他の経路（pipeline/revert）も同じ project lock を経由するため、
  // 次の withProjectWriteLock 取得時までに blocking phase が復活しても、ロック取得後の
  // 実処理は正常に直列化される（pipeline は自分のロック内で完結してから離す）。
  await assertGenerationNotBlockedByMaintenance(projectId);
  const result = await withProjectWriteLock(projectId, () =>
    generateSceneUnlocked(projectId, options, requestClock)
  );
  startReservedPostGenerationMaintenance(projectId, result.record.generationId, result.maintenanceRunId);
  return result.record;
}

async function generateSceneUnlocked(
  projectId: string,
  options: GenerateOptions,
  requestClock: GenerationRequestClock
): Promise<GeneratedSceneResult> {
  await reloadCredentials();

  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);
  // The preflight guard can race another generation while this request waits
  // for the project lock. Re-check the state captured under that lock before
  // any prompt or model work so a fresh scanning slot cannot be overwritten.
  if (maintenanceBlocksGeneration(state.refineMaintenance?.phase)) {
    throw new MaintenanceInProgressError();
  }

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorldPromptText(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  // NOTE: bannedExpressions はプロンプトへ載せない（promptBuilder のコメント参照）。
  // 頻出フレーズの soft caution からNG語を除外するためだけに使うので、件数を絞らない
  // 全件版を使う。絞ると漏れた語が soft caution 経由でプロンプトへ戻ってしまう。
  const [ngExpressions, knowledgeTexts] = await Promise.all([
    expressionService.resolveActiveNgExpressions(projectId),
    knowledgeService.getEnabledKnowledgeTexts(projectId),
  ]);
  const bannedExpressions = ngExpressions.map((expression) => expression.text);
  const rewriteTargetGenerationId =
    options.mode === 'continue'
      ? null
      : await getCurrentSceneReferenceGenerationId(
          projectId,
          state.currentEpisodeId,
          state.currentSceneId,
          state.selectedDraftGenerationId
        );
  const styleProfile = await resolveStyleProfileForGeneration(
    project,
    options,
    rewriteTargetGenerationId
  );

  const built = await buildPrompt({
    project,
    state,
    wish: options.wish,
    memories,
    characters,
    worldText,
    baseSystemPrompt: presets?.baseSystemPrompt,
    customSystemPrompt: presets?.customSystemPrompt,
    bannedExpressions,
    knowledgeTexts,
    mode: options.mode,
    styleProfile,
    viewpointCharacterId: options.viewpointCharacterId ?? null,
  });

  const fitted = await fitPromptToTokenBudget({ project, built });
  const { systemInstructions, userPrompt } = fitted.built;
  const promptBudgetReport = fitted.report;

  const temperature = resolveTemperature(project.samplingConfig?.temperature, options.mode);

  // NOTE: 開発診断が無効なら onReasoningChunk 自体を渡さない。推論本文は本文より
  // 長くなることがあり、リリース版で無駄に丸ごとメモリへ積むのを避ける。
  const devDiagnostics = isDevDiagnosticsEnabled();
  const reasoningParts: string[] = [];
  const modelStartedMs = Date.now();
  const result = await generateWithAdapter(adapter, {
    systemInstructions,
    userPrompt,
    outputLength: project.outputLength,
    temperature,
    timeoutMs: TIMEOUT_MS,
    modelName: project.activeModelName,
    maxOutputTokens: fitted.maxOutputTokens,
    frequencyPenalty: project.samplingConfig?.frequencyPenalty,
    presencePenalty: project.samplingConfig?.presencePenalty,
    ...(devDiagnostics
      ? { onReasoningChunk: (chunk: string) => reasoningParts.push(chunk) }
      : {}),
  });
  const modelCompletedMs = Date.now();

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    throw new GenerateError(
      mapErrorMessage(result.errorCode, result.errorMessage),
      result.errorCode || 'generation_failed',
      result.retryable
    );
  }
  if (result.finishReason === 'content_filter') {
    throw new GenerateError(
      mapErrorMessage('content_filter', result.debugInfo),
      'content_filter',
      false
    );
  }
  if (!result.text.trim()) {
    console.warn('Empty generation response', {
      projectId,
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
      finishReason: result.finishReason,
      rawUsage: result.rawUsage,
      debugInfo: result.debugInfo,
    });
    const classification = classifyEmptyResponse(result.debugInfo);
    throw new GenerateError(
      mapErrorMessage(
        classification.code,
        result.debugInfo || `finishReason=${result.finishReason}`
      ),
      classification.code,
      classification.retryable
    );
  }

  const generationId = generateTimestampId('gen');
  const outputFilePath = storage.generationMdPath(projectId, generationId);
  const previousContextFilePath = storage.generationPromptPath(projectId, generationId);
  await storage.writeGenerationPromptSnapshot(projectId, generationId, userPrompt);
  if (devDiagnostics) {
    await persistGenerationReasoning(projectId, generationId, reasoningParts);
  }
  const record: GenerationRecord = {
    generationId,
    sceneId,
    episodeId,
    request: {
      wish: options.wish,
      outputLength: project.outputLength,
      previousContextText: 'Prompt saved separately. See previousContextFilePath.',
      previousContextFilePath,
      previousContextChars: userPrompt.length,
      viewpointCharacterId: options.viewpointCharacterId ?? null,
    },
    responseText: result.text,
    usedPresets: project.activePresetIds,
    usedModel: {
      provider: project.activeModelProvider,
      modelName: result.resolvedModelName ?? project.activeModelName,
    },
    referencedMemoryIds: memories.filter((m) => m.importance === 'high').map((m) => m.memoryId),
    status: 'draft',
    createdAt: nowIso(),
    parentGenerationId: state.selectedDraftGenerationId,
    outputFilePath,
    bannedExpressions,
    finishReason: result.finishReason,
    ...(devDiagnostics
      ? {
          generationMode: options.mode,
          telemetry: buildGenerationTelemetry({
            requestClock,
            modelStartedMs,
            modelCompletedMs,
            usage: result.rawUsage,
            streamMetrics: {
              firstProviderEventAt: new Date(modelCompletedMs).toISOString(),
              ...(result.reasoningStats?.chars
                ? { firstReasoningAt: new Date(modelCompletedMs).toISOString() }
                : {}),
              ...(result.text.trim()
                ? { firstContentAt: new Date(modelCompletedMs).toISOString() }
                : {}),
              reasoningChars: result.reasoningStats?.chars ?? 0,
              reasoningChunks: result.reasoningStats?.chunks ?? 0,
              contentChars: result.text.length,
              contentChunks: result.text.trim() ? 1 : 0,
            },
          }),
          promptBudgetReport,
        }
      : {}),
    ...(styleProfile ? { styleProfile } : {}),
  };

  await storage.writeGenerationMarkdown(projectId, generationId, record.responseText);
  await storage.appendGenerationLog(projectId, record);

  await persistTargetScene(projectId, target, generationId);

  // state更新
  const rawWorldText = await storage.readWorldText(projectId);
  const maintenanceReservation = await reservePostGenerationMaintenanceForDraftUnlocked({
    projectId,
    project,
    state,
    generation: record,
    worldText: rawWorldText,
    characters,
  });
  await storage.writeState(projectId, {
    ...state,
    currentEpisodeId: episodeId,
    currentSceneId: sceneId,
    selectedDraftGenerationId: generationId,
    lastOpenedAt: nowIso(),
    ...(maintenanceReservation.maintenance
      ? { refineMaintenance: maintenanceReservation.maintenance }
      : {}),
  });

  await projectService.updateProject(projectId, { updatedAt: nowIso() });

  return { record, maintenanceRunId: maintenanceReservation.runId };
}

export async function generateSceneStream(
  projectId: string,
  options: GenerateStreamOptions,
  onChunk: (chunk: string) => void
): Promise<GenerationRecord> {
  const requestClock = startGenerationRequestClock();
  // NOTE: 非ストリーム側と同じく、期限切れ lease の failed 正規化のためロック外で
  // guard を通す。route 側にも preflight があるが、直接呼び出し（テスト等）でも
  // 同じ挙動を保証する。
  await assertGenerationNotBlockedByMaintenance(projectId);
  const result = await withProjectWriteLock(projectId, () =>
    generateSceneStreamUnlocked(projectId, options, onChunk, requestClock)
  );
  startReservedPostGenerationMaintenance(projectId, result.record.generationId, result.maintenanceRunId);
  return result.record;
}

async function generateSceneStreamUnlocked(
  projectId: string,
  options: GenerateStreamOptions,
  onChunk: (chunk: string) => void,
  requestClock: GenerationRequestClock
): Promise<GeneratedSceneResult> {
  await reloadCredentials();
  throwIfAborted(options.abortSignal);

  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);
  // See the non-streaming path: the outer preflight is not a substitute for
  // checking the maintenance slot after this request acquires the project lock.
  if (maintenanceBlocksGeneration(state.refineMaintenance?.phase)) {
    throw new MaintenanceInProgressError();
  }
  throwIfAborted(options.abortSignal);

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  if (!adapter.generateTextStream) {
    const result = await generateSceneUnlocked(projectId, options, requestClock);
    throwIfAborted(options.abortSignal);
    onChunk(result.record.responseText);
    return result;
  }

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorldPromptText(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  // NOTE: bannedExpressions はプロンプトへ載せない（promptBuilder のコメント参照）。
  // 頻出フレーズの soft caution からNG語を除外するためだけに使うので、件数を絞らない
  // 全件版を使う。絞ると漏れた語が soft caution 経由でプロンプトへ戻ってしまう。
  const [ngExpressions, knowledgeTexts] = await Promise.all([
    expressionService.resolveActiveNgExpressions(projectId),
    knowledgeService.getEnabledKnowledgeTexts(projectId),
  ]);
  const bannedExpressions = ngExpressions.map((expression) => expression.text);
  const rewriteTargetGenerationId =
    options.mode === 'continue'
      ? null
      : await getCurrentSceneReferenceGenerationId(
          projectId,
          state.currentEpisodeId,
          state.currentSceneId,
          state.selectedDraftGenerationId
        );
  const styleProfile = await resolveStyleProfileForGeneration(
    project,
    options,
    rewriteTargetGenerationId
  );

  const built = await buildPrompt({
    project,
    state,
    wish: options.wish,
    memories,
    characters,
    worldText,
    baseSystemPrompt: presets?.baseSystemPrompt,
    customSystemPrompt: presets?.customSystemPrompt,
    bannedExpressions,
    knowledgeTexts,
    mode: options.mode,
    styleProfile,
    viewpointCharacterId: options.viewpointCharacterId ?? null,
  });

  const fitted = await fitPromptToTokenBudget({ project, built });
  const { systemInstructions, userPrompt } = fitted.built;
  const promptBudgetReport = fitted.report;

  const temperature = resolveTemperature(project.samplingConfig?.temperature, options.mode);
  // NOTE: 非ストリーミング側と同じ理由で、無効時は推論本文を集めない。
  const devDiagnostics = isDevDiagnosticsEnabled();
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  let finishReason: FinishReason = 'stop';
  let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;
  let debugInfo: string | undefined;
  let resolvedModelName: string | undefined;
  let streamMetrics: Parameters<typeof buildGenerationTelemetry>[0]['streamMetrics'];
  let firstObservedEventAt: string | undefined;
  let firstContentAt: string | undefined;
  let contentChars = 0;
  let contentChunks = 0;

  const modelStartedMs = Date.now();
  try {
    for await (const event of generateTextStreamWithPenaltyRetry(adapter, {
      systemInstructions,
      userPrompt,
      outputLength: project.outputLength,
      temperature,
      timeoutMs: TIMEOUT_MS,
      modelName: project.activeModelName,
      maxOutputTokens: fitted.maxOutputTokens,
      abortSignal: options.abortSignal,
      frequencyPenalty: project.samplingConfig?.frequencyPenalty,
      presencePenalty: project.samplingConfig?.presencePenalty,
      ...(devDiagnostics
        ? { onReasoningChunk: (chunk: string) => reasoningParts.push(chunk) }
        : {}),
    })) {
      throwIfAborted(options.abortSignal);
      if (event.type === 'chunk') {
        const receivedAt = new Date().toISOString();
        firstObservedEventAt ??= receivedAt;
        firstContentAt ??= receivedAt;
        contentChars += event.text.length;
        contentChunks += 1;
        textParts.push(event.text);
        onChunk(event.text);
      } else {
        firstObservedEventAt ??= new Date().toISOString();
        finishReason = event.finishReason;
        rawUsage = event.rawUsage;
        debugInfo = event.debugInfo;
        resolvedModelName = event.resolvedModelName;
        streamMetrics = event.streamMetrics;
      }
    }
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code, err.message), err.code, err.retryable);
    }
    throw err;
  }
  const modelCompletedMs = Date.now();
  const measuredStreamMetrics = {
    firstProviderEventAt: streamMetrics?.firstProviderEventAt ?? firstObservedEventAt,
    firstReasoningAt: streamMetrics?.firstReasoningAt,
    firstContentAt: streamMetrics?.firstContentAt ?? firstContentAt,
    reasoningChars: streamMetrics?.reasoningChars ?? 0,
    reasoningChunks: streamMetrics?.reasoningChunks ?? 0,
    contentChars,
    contentChunks,
  };

  if (finishReason === 'error' || finishReason === 'timeout') {
    throw new GenerateError(mapErrorMessage(finishReason), finishReason, true);
  }
  if (finishReason === 'content_filter') {
    throw new GenerateError(
      mapErrorMessage('content_filter', debugInfo),
      'content_filter',
      false
    );
  }
  const streamedText = textParts.join('').trim();
  if (!streamedText) {
    console.warn('Empty streaming generation response', {
      projectId,
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
      finishReason,
      rawUsage,
      debugInfo,
    });
    const classification = classifyEmptyResponse(debugInfo);
    throw new GenerateError(
      mapErrorMessage(
        classification.code,
        debugInfo || `finishReason=${finishReason}`
      ),
      classification.code,
      classification.retryable
    );
  }
  throwIfAborted(options.abortSignal);

  const generationId = generateTimestampId('gen');
  const outputFilePath = storage.generationMdPath(projectId, generationId);
  const previousContextFilePath = storage.generationPromptPath(projectId, generationId);
  await storage.writeGenerationPromptSnapshot(projectId, generationId, userPrompt);
  if (devDiagnostics) {
    await persistGenerationReasoning(projectId, generationId, reasoningParts);
  }
  const record: GenerationRecord = {
    generationId,
    sceneId,
    episodeId,
    request: {
      wish: options.wish,
      outputLength: project.outputLength,
      previousContextText: 'Prompt saved separately. See previousContextFilePath.',
      previousContextFilePath,
      previousContextChars: userPrompt.length,
      viewpointCharacterId: options.viewpointCharacterId ?? null,
    },
    responseText: streamedText,
    usedPresets: project.activePresetIds,
    usedModel: {
      provider: project.activeModelProvider,
      modelName: resolvedModelName ?? project.activeModelName,
    },
    referencedMemoryIds: memories.filter((m) => m.importance === 'high').map((m) => m.memoryId),
    status: 'draft',
    createdAt: nowIso(),
    parentGenerationId: state.selectedDraftGenerationId,
    outputFilePath,
    bannedExpressions,
    finishReason,
    ...(devDiagnostics
      ? {
          generationMode: options.mode,
          telemetry: buildGenerationTelemetry({
            requestClock,
            modelStartedMs,
            modelCompletedMs,
            usage: rawUsage,
            streamMetrics: measuredStreamMetrics,
          }),
          promptBudgetReport,
        }
      : {}),
    ...(styleProfile ? { styleProfile } : {}),
  };

  await storage.writeGenerationMarkdown(projectId, generationId, record.responseText);
  await storage.appendGenerationLog(projectId, record);
  await persistTargetScene(projectId, target, generationId);

  const rawWorldText = await storage.readWorldText(projectId);
  const maintenanceReservation = await reservePostGenerationMaintenanceForDraftUnlocked({
    projectId,
    project,
    state,
    generation: record,
    worldText: rawWorldText,
    characters,
  });
  await storage.writeState(projectId, {
    ...state,
    currentEpisodeId: episodeId,
    currentSceneId: sceneId,
    selectedDraftGenerationId: generationId,
    lastOpenedAt: nowIso(),
    ...(maintenanceReservation.maintenance
      ? { refineMaintenance: maintenanceReservation.maintenance }
      : {}),
  });

  await projectService.updateProject(projectId, { updatedAt: nowIso() });

  return { record, maintenanceRunId: maintenanceReservation.runId };
}

// NOTE: provider 実測を使う経路の計測上限（設計書 3.1 step 5）。
// 初回、一括縮小後の再計測、保守的縮小後の最終計測の3回で打ち切り、
// 外部APIを無制限に叩かない。
const NOVEL_TOKEN_MEASUREMENTS_MAX = 3;

/**
 * 本文生成の直前に、組み立て済み prompt がモデルのトークン予算へ収まるか検証し、
 * 超過していれば任意節を縮小して組み立て直す（設計書 3.1 step 5〜7）。
 *
 * 文字数上限（system 24,000 / user 56,000 / 合計 80,000）は promptBuilder 側で
 * 保証済みだが、日本語では 80,000 字が 128k モデルでも収まらない。ここで縮小せず
 * 即エラーにすると「参考資料を1つ減らせば通る入力」まで生成不能になる。
 */
async function fitPromptToTokenBudget(input: {
  project: Project;
  built: BuildPromptResult;
}): Promise<{ built: BuildPromptResult; report: PromptBudgetReport; maxOutputTokens: number }> {
  const limits = await resolveModelTokenLimits(
    input.project.activeModelProvider,
    input.project.activeModelName
  );
  const maxOutputTokens = resolveNovelMaxOutputTokens(
    {
      provider: input.project.activeModelProvider,
      modelName: input.project.activeModelName,
      outputLength: input.project.outputLength,
    },
    Math.min(limits.contextWindowTokens, limits.outputTokenLimit ?? limits.contextWindowTokens)
  );

  let built = input.built;
  let lastCheck: ReturnType<typeof checkPromptTokenBudget> | null = null;

  for (let attempt = 0; attempt < NOVEL_TOKEN_MEASUREMENTS_MAX; attempt += 1) {
    const totalChars = built.systemInstructions.length + built.userPrompt.length;
    if (totalChars > NOVEL_TOTAL_PROMPT_MAX_CHARS) {
      throw new GenerateError(
        `プロンプトが上限を${totalChars - NOVEL_TOTAL_PROMPT_MAX_CHARS}字超えています。参考資料や設定を減らしてください。`,
        'prompt_budget_exceeded',
        false
      );
    }

    const providerCount = await countPromptTokens(
      input.project.activeModelProvider,
      input.project.activeModelName,
      built.systemInstructions,
      built.userPrompt
    );
    const check = checkPromptTokenBudget({
      systemInstructions: built.systemInstructions,
      userPrompt: built.userPrompt,
      contextWindowTokens: limits.contextWindowTokens,
      ...(limits.inputTokenLimit === undefined ? {} : { inputTokenLimit: limits.inputTokenLimit }),
      estimatedMaxOutputTokens: maxOutputTokens,
      providerTokens: providerCount?.tokens ?? null,
    });
    lastCheck = check;

    if (check.ok) {
      return {
        built,
        maxOutputTokens,
        report: {
          ...built.budgetReport,
          assembledChars: totalChars,
          tokenCheck: check.tokenCheck,
        },
      };
    }

    // 超過量から削るべき文字数を出し、user 予算を下げて組み立て直す。
    // 必須節の合計より下へは意味が無いので、そこで打ち切って型付きエラーにする。
    const reducible = tokensToReducibleChars(check.overByTokens, built.userPrompt);
    const nextBudget = built.budgetReport.maxChars - reducible;
    if (nextBudget <= built.requiredUserChars) break;
    built = built.rebuildWithUserBudget(nextBudget);
  }

  const over = lastCheck?.overByTokens ?? 0;
  throw new GenerateError(
    `プロンプトが選択中のモデルの文脈上限を約${over}トークン超えています。参考資料や設定を減らすか、上限の大きいモデルへ切り替えてください。`,
    'prompt_budget_exceeded',
    false
  );
}

async function reservePostGenerationMaintenanceForDraftUnlocked(input: {
  projectId: string;
  project: Project;
  state: ProjectState;
  generation: GenerationRecord;
  worldText: string;
  characters: Character[];
}): Promise<{ runId?: string; maintenance?: ProjectState['refineMaintenance'] }> {
  // NOTE: postGenerationMaintenanceService は refineScanService を利用し、その既存実装は
  // generationService の backlog helper を参照する。ここを runtime import にして、
  // モジュール初期化時の循環依存を作らずに「同じ project lock 内の予約」を満たす。
  const maintenanceService = await import('./postGenerationMaintenanceService.js');
  return maintenanceService.reservePostGenerationMaintenanceUnlocked(input);
}

function startReservedPostGenerationMaintenance(
  projectId: string,
  generationId: string,
  runId: string | undefined
): void {
  if (!runId) return;
  void import('./postGenerationMaintenanceService.js')
    .then((maintenanceService) => {
      maintenanceService.startPostGenerationMaintenance(projectId, generationId, runId);
    })
    .catch((error) => {
      console.warn('Failed to start post-generation maintenance', { projectId, generationId, runId, error });
    });
}

async function markAwaitingMaintenanceStaleUnlocked(
  projectId: string,
  maintenance: NonNullable<ProjectState['refineMaintenance']>,
  reason: string
): Promise<void> {
  const maintenanceService = await import('./refineAutomationService.js');
  await maintenanceService.markAutomationRunStaleUnlocked(projectId, maintenance.runId, reason);
}

type TargetScene =
  | {
      mode: 'continue';
      episode: EpisodeRecord;
      scene: SceneRecord;
      episodeId: string;
      sceneId: string;
    }
  | {
      mode: 'regenerate' | 'variate';
      episodeId: string;
      sceneId: string;
    };

async function prepareTargetScene(
  projectId: string,
  state: ProjectState,
  mode: GenerateOptions['mode']
): Promise<TargetScene> {
  if (mode === 'continue') {
    let episodeId = state.currentEpisodeId ?? generateTimestampId('ep');
    let episode: EpisodeRecord | null = null;
    if (state.currentEpisodeId) {
      episode = await storage.readEpisodeRecord(projectId, episodeId);
    }
    if (!episode) {
      episode = {
        episodeId,
        title: '第1章',
        order: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        scenes: [],
      };
    }

    const sceneOrder = episode.scenes.length + 1;
    const sceneId = generateTimestampId('scene');
    const scene: SceneRecord = {
      sceneId,
      episodeId,
      order: sceneOrder,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      acceptedGenerationId: null,
      draftGenerationIds: [],
    };

    return { mode, episode, scene, episodeId, sceneId };
  }

  // regenerate / variate は現在の場面を対象
  if (!state.currentEpisodeId || !state.currentSceneId) {
    throw new Error('No current scene to regenerate');
  }
  return { mode, episodeId: state.currentEpisodeId, sceneId: state.currentSceneId };
}

async function persistTargetScene(
  projectId: string,
  target: TargetScene,
  generationId: string
): Promise<void> {
  if (target.mode === 'continue') {
    target.scene.draftGenerationIds.push(generationId);
    target.episode.scenes.push(target.scene);
    target.episode.updatedAt = nowIso();
    await storage.writeEpisodeRecord(projectId, target.episode);
    return;
  }

  const episode = await storage.readEpisodeRecord(projectId, target.episodeId);
  if (!episode) throw new Error(`Episode not found: ${target.episodeId}`);
  const scene = episode.scenes.find((s) => s.sceneId === target.sceneId);
  if (!scene) throw new Error(`Scene not found: ${target.sceneId}`);
  if (!scene.draftGenerationIds.includes(generationId)) {
    scene.draftGenerationIds.push(generationId);
  }
  scene.updatedAt = nowIso();
  episode.updatedAt = nowIso();
  await storage.writeEpisodeRecord(projectId, episode);
}

interface AcceptGenerationResult {
  record: GenerationRecord;
  refreshStoryState: boolean;
  newlyAccepted: boolean;
  maintenanceContinuationRunId?: string;
}

export async function acceptGeneration(projectId: string, generationId?: string): Promise<GenerationRecord> {
  const result = await withProjectWriteLock(projectId, () =>
    acceptGenerationUnlocked(projectId, generationId)
  );
  if (result.maintenanceContinuationRunId) {
    void import('./postGenerationMaintenanceService.js')
      .then((maintenanceService) =>
        maintenanceService.continuePostGenerationMaintenanceAfterAcceptance(
          projectId,
          result.record.generationId,
          result.maintenanceContinuationRunId!
        )
      )
      .catch((error) => {
        console.warn('Failed to continue post-generation maintenance after acceptance', {
          projectId,
          generationId: result.record.generationId,
          error,
        });
      });
  } else if (result.refreshStoryState) {
    startStoryStateRefreshAfterAcceptance(projectId, result.record.generationId);
  }
  if (result.newlyAccepted) {
    // NOTE: 採用で場面が1つ増え、その分だけ古い場面が直近本文の窓から押し出される。
    // 押し出された本文はここで畳まないと、どこにも残らないまま失われる。
    startContextSummaryAfterAcceptance(projectId);
  }
  const project = result.newlyAccepted ? await storage.readProject(projectId) : null;
  if (project) {
    // NOTE: trace解析はプロセス内キューで非同期実行する。解析中にプロセスが終了した
    // 場合は記録なしで失われるため、将来の明示retry導線は「trace/analysisともにない
    // accepted generation」も対象に含める必要がある。
    queueAcceptedGenerationStyleAnalysis(project, result.record);
  }
  return result.record;
}

async function acceptGenerationUnlocked(
  projectId: string,
  generationId?: string
): Promise<AcceptGenerationResult> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const targetId = generationId || state.selectedDraftGenerationId;
  if (!targetId) throw new Error('No draft generation selected');
  if (targetId !== state.selectedDraftGenerationId) {
    throw new RefineAutomationError(
      '現在選択されている下書きだけを採用できます。',
      'generation_not_selected',
      false,
      409
    );
  }

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  if (generation.status === 'accepted') {
    const continuation = state.refineMaintenance?.postAcceptanceContinuation;
    return {
      record: generation,
      refreshStoryState: false,
      newlyAccepted: false,
      ...(continuation?.owner === 'maintenance' && continuation.generationId === generation.generationId
        ? { maintenanceContinuationRunId: state.refineMaintenance?.runId }
        : {}),
    };
  }

  generation.status = 'accepted';
  await storage.appendGenerationStatusLog(projectId, generation.generationId, generation.status);

  const episode = await storage.readEpisodeRecord(projectId, generation.episodeId);
  if (!episode) throw new Error(`Episode not found: ${generation.episodeId}`);

  const scene = episode.scenes.find((s) => s.sceneId === generation.sceneId);
  if (!scene) throw new Error(`Scene not found: ${generation.sceneId}`);

  // 以前の採用があれば上書き
  const previousAcceptedGenerationId = scene.acceptedGenerationId;
  const invalidatesContextSummary = Boolean(
    previousAcceptedGenerationId &&
    previousAcceptedGenerationId !== generation.generationId &&
    state.contextSummary?.summarizedGenerationIds.includes(previousAcceptedGenerationId)
  );
  if (invalidatesContextSummary) {
    // NOTE: 旧採用本文は既存要約から差し引けない。新本文を旧要約へ足すと両案が混ざるため、
    // 同一シーンの採用し直しでは全要約を空にし、採用完了後の背景ジョブで再構築する。
    await storage.writeContextSummary(projectId, '');
  }
  scene.acceptedGenerationId = generation.generationId;
  // 他のdraftをsupersededに
  for (const draftId of scene.draftGenerationIds) {
    if (draftId === generation.generationId) continue;
    const draft = await findGeneration(projectId, draftId);
    if (draft && draft.status === 'draft') {
      draft.status = 'superseded';
      await storage.appendGenerationStatusLog(projectId, draft.generationId, draft.status);
    }
  }
  await storage.writeEpisodeRecord(projectId, episode);

  // Markdown更新
  await updateEpisodeMarkdown(projectId, episode);
  await writeProjectShortcut(projectId).catch((err) => {
    console.warn('Project shortcut update failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let nextMaintenance = state.refineMaintenance;
  let maintenanceContinuationRunId: string | undefined;
  if (
    nextMaintenance &&
    (nextMaintenance.phase === 'scanning' || nextMaintenance.phase === 'awaitingAcceptance')
  ) {
    if (nextMaintenance.generationId === generation.generationId) {
      nextMaintenance = {
        ...nextMaintenance,
        postAcceptanceContinuation: {
          generationId: generation.generationId,
          action: 'story-state-refresh',
          owner: 'maintenance',
          requestedAt: nowIso(),
        },
        updatedAt: nowIso(),
      };
      maintenanceContinuationRunId = nextMaintenance.runId;
    } else {
      await markAwaitingMaintenanceStaleUnlocked(
        projectId,
        nextMaintenance,
        '別の生成案が採用されたため、この採用待ちの自動レビューは無効になりました。'
      );
      nextMaintenance = {
        ...nextMaintenance,
        phase: 'stale',
        updatedAt: nowIso(),
        errorMessage: '別の生成案が採用されたため、この採用待ちは無効になりました。',
      };
    }
  }

  const storyStateRefresh = buildStoryStateRefreshStatus('pending', generation.generationId);
  await storage.writeState(projectId, {
    ...state,
    lastAcceptedGenerationId: generation.generationId,
    selectedDraftGenerationId: generation.generationId,
    storyStateRefresh,
    ...(invalidatesContextSummary
      ? {
          contextSummary: {
            summarizedGenerationIds: [],
            updatedAt: nowIso(),
          },
        }
      : {}),
    ...(nextMaintenance ? { refineMaintenance: nextMaintenance } : {}),
  });

  return {
    record: generation,
    refreshStoryState: maintenanceContinuationRunId === undefined,
    newlyAccepted: true,
    maintenanceContinuationRunId,
  };
}

async function writeProjectShortcut(projectId: string): Promise<void> {
  const project = await storage.readProject(projectId);
  if (!project) return;
  await writeShortcut(project.projectId, project.title);
}

export async function unacceptCurrentScene(projectId: string): Promise<GenerationRecord | null> {
  return withProjectWriteLock(projectId, () => unacceptCurrentSceneUnlocked(projectId));
}

// NOTE: 現在シーンの採用を取り消し、draft 状態に戻す。episode markdown も再構築される。
// 復元される status は 'draft'(supersededや他のdraftへの影響はしない)。
async function unacceptCurrentSceneUnlocked(projectId: string): Promise<GenerationRecord | null> {
  const state = await storage.readState(projectId);
  if (!state?.currentEpisodeId || !state.currentSceneId) return null;

  const episode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  if (!episode) return null;

  const scene = episode.scenes.find((s) => s.sceneId === state.currentSceneId);
  if (!scene?.acceptedGenerationId) return null;

  const acceptedId = scene.acceptedGenerationId;
  const generation = await findGeneration(projectId, acceptedId);
  if (!generation) return null;

  generation.status = 'draft';
  await storage.appendGenerationStatusLog(projectId, generation.generationId, generation.status);

  // NOTE: 採用を外すとこの generation はどのシーンの採用本文でもなくなる。畳み済みのまま
  // 残すと summarizedGenerationIds が現在位置prefix（getContextGenerationIdsThroughCurrentScene）
  // に収まらなくなり、promptBuilder の summaryFitsCurrentPosition が二度と真にならない。
  // 要約は背景で作られ続けるのにプロンプトへは一切入らない、という無言の停止になる。
  // 旧本文を既存要約から差し引けないのは採用し直しと同じなので、扱いも揃えて全破棄する。
  const invalidatesContextSummary = Boolean(
    state.contextSummary?.summarizedGenerationIds.includes(acceptedId)
  );
  if (invalidatesContextSummary) {
    await storage.writeContextSummary(projectId, '');
  }

  scene.acceptedGenerationId = null;
  await storage.writeEpisodeRecord(projectId, episode);

  await updateEpisodeMarkdown(projectId, episode);

  let nextMaintenance = state.refineMaintenance;
  if (
    nextMaintenance &&
    (nextMaintenance.phase === 'scanning' || nextMaintenance.phase === 'awaitingAcceptance') &&
    nextMaintenance.generationId === generation.generationId
  ) {
    const reason = '採用を取り消したため、この生成案に紐づく自動レビューは無効になりました。';
    await markAwaitingMaintenanceStaleUnlocked(projectId, nextMaintenance, reason);
    const { postAcceptanceContinuation: _continuation, ...withoutContinuation } = nextMaintenance;
    nextMaintenance = {
      ...withoutContinuation,
      phase: 'stale',
      updatedAt: nowIso(),
      errorMessage: reason,
    };
  }

  const nextState = {
    ...state,
    selectedDraftGenerationId: generation.generationId,
    lastAcceptedGenerationId:
      state.lastAcceptedGenerationId === acceptedId ? null : state.lastAcceptedGenerationId,
    ...(invalidatesContextSummary
      ? {
          contextSummary: {
            summarizedGenerationIds: [],
            updatedAt: nowIso(),
          },
        }
      : {}),
    ...(nextMaintenance ? { refineMaintenance: nextMaintenance } : {}),
  };
  await storage.writeState(projectId, nextState);

  const revertedStoryState = await revertLatestStoryStateDiffForGeneration(
    projectId,
    generation.generationId
  ).catch((err) => {
    console.warn('Story state auto-revert after unaccept failed', {
      projectId,
      generationId: generation.generationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  });
  if (revertedStoryState) {
    await writeStoryStateRefreshUnlocked(
      projectId,
      buildStoryStateRefreshStatus('stale', generation.generationId, '採用取消に合わせて物語状態を戻しました。必要なら再抽出してください。')
    );
  }

  if (invalidatesContextSummary) {
    // NOTE: 空にした要約を、採用が外れた後の本文から背景で作り直す。NGリライトの
    // 無効化と同じ形で、ここでは待たない（要約の失敗が採用取消を巻き込まないため）。
    startContextSummaryAfterAcceptance(projectId);
  }

  return generation;
}

export async function rejectGeneration(projectId: string, generationId?: string): Promise<GenerationRecord> {
  return withProjectWriteLock(projectId, () => rejectGenerationUnlocked(projectId, generationId));
}

async function rejectGenerationUnlocked(
  projectId: string,
  generationId?: string
): Promise<GenerationRecord> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const targetId = generationId || state.selectedDraftGenerationId;
  if (!targetId) throw new Error('No draft generation selected');

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  generation.status = 'rejected';
  await storage.appendGenerationStatusLog(projectId, generation.generationId, generation.status);

  let nextMaintenance = state.refineMaintenance;
  let maintenanceChanged = false;
  if (
    nextMaintenance &&
    (nextMaintenance.phase === 'scanning' || nextMaintenance.phase === 'awaitingAcceptance') &&
    nextMaintenance.generationId === generation.generationId
  ) {
    const reason = '生成案が却下されたため、この採用待ちの自動レビューは無効になりました。';
    await markAwaitingMaintenanceStaleUnlocked(projectId, nextMaintenance, reason);
    nextMaintenance = {
      ...nextMaintenance,
      phase: 'stale',
      updatedAt: nowIso(),
      errorMessage: reason,
    };
    maintenanceChanged = true;
  }

  if (state.selectedDraftGenerationId === generation.generationId) {
    const episode = await storage.readEpisodeRecord(projectId, generation.episodeId);
    const scene = episode?.scenes.find((s) => s.sceneId === generation.sceneId);
    if (episode && scene) {
      const previousDraftIds = scene.draftGenerationIds.filter((id) => id !== generation.generationId);
      scene.draftGenerationIds = previousDraftIds;
      const fallbackId = previousDraftIds.at(-1) ?? scene.acceptedGenerationId ?? null;
      scene.updatedAt = nowIso();
      episode.updatedAt = nowIso();
      await storage.writeEpisodeRecord(projectId, episode);
      await storage.writeState(projectId, {
        ...state,
        selectedDraftGenerationId: fallbackId,
        ...(nextMaintenance ? { refineMaintenance: nextMaintenance } : {}),
      });
      maintenanceChanged = false;
    }
  }

  if (maintenanceChanged && nextMaintenance) {
    await storage.writeState(projectId, { ...state, refineMaintenance: nextMaintenance });
  }

  return generation;
}

export async function revertToPrevious(projectId: string): Promise<GenerationRecord | null> {
  return navigateDraft(projectId, 'previous');
}

export async function navigateDraft(
  projectId: string,
  direction: SceneNavigationDirection
): Promise<GenerationRecord | null> {
  return withProjectWriteLock(projectId, () => navigateDraftUnlocked(projectId, direction));
}

async function navigateDraftUnlocked(
  projectId: string,
  direction: SceneNavigationDirection
): Promise<GenerationRecord | null> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  if (!state.currentEpisodeId || !state.currentSceneId) return null;

  const episode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  if (!episode) return null;

  const scene = episode.scenes.find((s) => s.sceneId === state.currentSceneId);
  if (!scene) return null;

  const currentId = state.selectedDraftGenerationId;
  const idx = scene.draftGenerationIds.findIndex((id) => id === currentId);
  if (idx < 0) return null;

  const targetIndex = direction === 'previous' ? idx - 1 : idx + 1;
  const targetId = scene.draftGenerationIds[targetIndex];
  if (!targetId) return null;

  const target = await findGeneration(projectId, targetId);
  if (!target) return null;

  let nextMaintenance = state.refineMaintenance;
  if (
    nextMaintenance &&
    nextMaintenance.phase === 'awaitingAcceptance' &&
    nextMaintenance.generationId !== targetId
  ) {
    const reason = '別の下書きが選択されたため、この採用待ちの自動レビューは無効になりました。';
    await markAwaitingMaintenanceStaleUnlocked(projectId, nextMaintenance, reason);
    nextMaintenance = {
      ...nextMaintenance,
      phase: 'stale',
      updatedAt: nowIso(),
      errorMessage: reason,
    };
  }

  await storage.writeState(projectId, {
    ...state,
    selectedDraftGenerationId: targetId,
    ...(nextMaintenance ? { refineMaintenance: nextMaintenance } : {}),
  });
  return target;
}

export async function navigateScene(
  projectId: string,
  direction: SceneNavigationDirection
): Promise<ReaderState> {
  return withProjectWriteLock(projectId, () => navigateSceneUnlocked(projectId, direction));
}

async function navigateSceneUnlocked(
  projectId: string,
  direction: SceneNavigationDirection
): Promise<ReaderState> {
  const state = await storage.readState(projectId);
  if (!state?.currentEpisodeId || !state.currentSceneId) {
    return getReaderState(projectId);
  }

  const episode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  if (!episode) return getReaderState(projectId);

  const currentIndex = episode.scenes.findIndex((scene) => scene.sceneId === state.currentSceneId);
  if (currentIndex < 0) return getReaderState(projectId);

  const nextIndex = direction === 'previous' ? currentIndex - 1 : currentIndex + 1;
  const targetScene = episode.scenes[nextIndex];
  if (!targetScene) return getReaderState(projectId);

  const selectedDraftGenerationId =
    targetScene.draftGenerationIds.at(-1) ?? targetScene.acceptedGenerationId ?? null;

  // Reading another scene does not change the source draft's eligibility.
  // Only rejection, selecting another draft, or starting a new generation may
  // stale its maintenance run (§4.2 / §7.10).
  await storage.writeState(projectId, {
    ...state,
    currentSceneId: targetScene.sceneId,
    selectedDraftGenerationId,
    lastOpenedAt: nowIso(),
  });

  return getReaderState(projectId);
}

// NOTE: 収集 → モデル呼び出し → 保存 の3段に分け、モデル呼び出しの間だけプロジェクト
// 書込みロックを手放す。要約は採用のたびに背景で走るようになったため、ロックを握ったまま
// 最大 TIMEOUT_MS 待つと、その間ずっと生成・採用・自動レビューが止まる。
// storyState 抽出が applyIfCurrent で取っているのと同じ形。
export async function compressProjectContext(
  projectId: string,
  options: { minPending?: number } = {}
): Promise<ContextCompressionResult> {
  return withContextSummaryLock(projectId, async () => {
    await reloadCredentials();
    // NOTE: 収集は読み取りだけなので project write lock を取らない。採用のたびに走る
    // 背景ジョブが「畳むものが無い」を確かめるためだけに生成・採用と競合するのを避ける。
    // モデル実行中に採用内容が変わった場合は、保存前検証で検出して最新状態からやり直す。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prepared = await prepareContextSummaryCompression(projectId, options);
      const summary = await runContextSummaryCompression(prepared);
      try {
        return await withProjectWriteLock(projectId, () =>
          persistContextSummary(projectId, prepared, summary)
        );
      } catch (err) {
        if (!(err instanceof ContextSummaryStaleError) || attempt === 2) throw err;
      }
    }
    throw new Error('Context summary retry loop exhausted');
  });
}

async function withContextSummaryLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = contextSummaryMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  contextSummaryMutexes.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (contextSummaryMutexes.get(projectId) === next) {
      contextSummaryMutexes.delete(projectId);
    }
  }
}

class ContextSummaryStaleError extends GenerateError {
  constructor() {
    super(
      '要約中に採用本文が更新されました。最新の本文でやり直してください。',
      'context_compression_stale',
      true
    );
    this.name = 'ContextSummaryStaleError';
  }
}

// NOTE: 直近本文の窓から落ちて、まだ要約へ畳んでいない採用生成を物語順で返す。
// 窓に残っている本文は原文がプロンプトに入っているので畳まない（二重計上になる）。
async function collectPendingSummaryGenerations(
  projectId: string,
  state: ProjectState
): Promise<GenerationRecord[]> {
  const inWindow = await getRecentContextGenerationIds(
    projectId,
    state.currentEpisodeId,
    state.currentSceneId
  );
  const summarized = new Set(state.contextSummary?.summarizedGenerationIds ?? []);
  const eligibleGenerationIds = await getContextGenerationIdsThroughCurrentScene(
    projectId,
    state.currentEpisodeId,
    state.currentSceneId
  );

  // NOTE: 1件ずつ findGeneration すると、そのたびに追記型の generation ログ全体を
  // 読み直して全行を JSON.parse する。要約を破棄した直後は pending が作品の全採用場面に
  // なるため、この経路だけログ走査が場面数ぶん積み上がる（1万字級の連載で実測 15 秒超、
  // parse は同期なのでその間サーバー全体が止まる）。batch 版は同じ解決規則のまま
  // 1 走査で済むので、候補IDを先に絞ってからまとめて引く。
  const pendingIds = eligibleGenerationIds.filter(
    (generationId) => !inWindow.has(generationId) && !summarized.has(generationId)
  );
  const generations = await storage.findGenerationRecords(projectId, pendingIds);

  const pending: GenerationRecord[] = [];
  for (const generationId of pendingIds) {
    const generation = generations.get(generationId);
    if (generation?.responseText.trim()) pending.push(generation);
  }
  return pending;
}

// NOTE: 設定・現在状態・伏線・情報の所在は storyState が構造化して保持し、プロンプトへ
// 別枠で入る。ここで同じものを並べると同じ事実へ二重にトークンを払い、しかも要約側は
// 古いまま残って storyState と食い違う。
// NOTE: ただし禁止リストにはしない。流れを散文で書けば「誰が何を知って動いたか」は
// 自然に混ざるもので、それを禁じると因果が書けなくなる。禁じるのは「一覧として並べる
// こと」だけにして、流れに必要な範囲で触れるのは明示的に許可する。
const CONTEXT_SUMMARY_SYSTEM_INSTRUCTIONS = [
  'あなたは連載小説アプリの文脈要約係です。担当は「物語の流れ」です。',
  '小説本文は書かず、要約だけを出力してください。',
  'あなたが書くのは、場面と場面の繋がりです。',
  '- どの場面から何がきっかけで次が起きたのか、という因果の筋',
  '- 人物の関係と感情がどの場面を境にどう動いたのか',
  '- 後の場面を読むために必要な、経緯としての文脈',
  '事実の箇条書きではなく、時系列に沿った簡潔な散文で書いてください。',
  '世界設定、人物の現在の状態、未回収の伏線、誰が何を知っているかは、別の仕組みが一覧として保持しています。',
  'それらを改めて一覧や箇条書きで並べ直す必要はありません。流れを語るうえで必要な範囲で文中に含めるのは構いません。',
  `全体で${CONTEXT_SUMMARY_MAX_CHARS}字以内に収めてください。`,
].join('\n');

interface PreparedContextSummaryCompression {
  project: Project;
  pending: GenerationRecord[];
  existingSummary: string;
}

async function prepareContextSummaryCompression(
  projectId: string,
  options: { minPending?: number }
): Promise<PreparedContextSummaryCompression> {
  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);
  if (!adapterMap[project.activeModelProvider]) {
    throw new Error(`Unsupported provider: ${project.activeModelProvider}`);
  }

  const pending = await collectPendingSummaryGenerations(projectId, state);
  if (pending.length < Math.max(1, options.minPending ?? 1)) {
    throw new GenerateError(
      '要約に畳める本文がまだありません。直近本文の枠に収まっている場面は、原文のままプロンプトへ入ります。',
      'no_context_to_compress',
      false
    );
  }

  return { project, pending, existingSummary: await storage.readContextSummary(projectId) };
}

async function runContextSummaryCompression(
  prepared: PreparedContextSummaryCompression
): Promise<string> {
  const { project } = prepared;
  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  let summary = prepared.existingSummary;
  const chunks = splitTextIntoChunks(
    prepared.pending.map((generation) => generation.responseText).join('\n\n'),
    SUMMARY_CHUNK_CHARS
  );

  for (const [index, chunk] of chunks.entries()) {
    const result = await generateWithAdapter(adapter, {
      systemInstructions: CONTEXT_SUMMARY_SYSTEM_INSTRUCTIONS,
      userPrompt: [
        `【これまでの流れの要約】\n${summary.trim() || 'なし'}`,
        `【新たに畳む本文 ${index + 1}/${chunks.length}】\n${chunk}`,
        '【出力】\nこれまでの要約に新しい本文の流れを統合した、更新後の要約だけを出力してください。',
      ].join('\n\n---\n\n'),
      outputLength: CONTEXT_SUMMARY_OUTPUT_LENGTH,
      temperature: TEMPERATURE_SUMMARY,
      timeoutMs: TIMEOUT_MS,
      modelName: project.activeModelName,
    });

    if (result.finishReason === 'error' || result.finishReason === 'timeout') {
      throw new GenerateError(
        mapErrorMessage(result.errorCode, result.errorMessage),
        result.errorCode || 'context_compression_failed',
        result.retryable
      );
    }
    summary = result.text.trim();
  }

  // NOTE: 上限は指示でも伝えているが、超過分を黙って捨てると文の途中で切れる。
  // 既存の文境界ヘルパーで末尾を整えてから保存する。
  if (summary.length > CONTEXT_SUMMARY_MAX_CHARS) {
    return trimTrailingTextToSentenceBoundary(summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS));
  }
  return summary;
}

async function persistContextSummary(
  projectId: string,
  prepared: PreparedContextSummaryCompression,
  summary: string
): Promise<ContextCompressionResult> {
  // NOTE: モデル呼び出し中は採用・採用取消・本文リライト・現在位置の変更を許す。
  // IDだけでは同一generationの本文差し替えを検出できないため、最新状態からpendingを
  // 選び直し、順序と本文まで一致するときだけ保存する。
  const latestState = await storage.readState(projectId);
  if (!latestState) throw new Error(`Project state not found: ${projectId}`);
  const latestPending = await collectPendingSummaryGenerations(projectId, latestState);
  const currentSummary = await storage.readContextSummary(projectId);
  if (
    currentSummary !== prepared.existingSummary ||
    !sameSummaryInputs(prepared.pending, latestPending)
  ) {
    throw new ContextSummaryStaleError();
  }

  // NOTE: 要約の保存と「畳み済み」の記録は必ず同じロック区間で確定させる。片方だけ残ると、
  // 同じ本文をもう一度畳む（重複）か、二度と畳まない（欠落）になる。
  // モデル呼び出しの間ロックを手放しているので、state は必ず読み直してから統合する。
  const summarized = new Set(latestState.contextSummary?.summarizedGenerationIds ?? []);
  for (const generation of prepared.pending) summarized.add(generation.generationId);
  const nextState: ProjectState = {
    ...latestState,
    contextSummary: {
      summarizedGenerationIds: [...summarized],
      updatedAt: nowIso(),
    },
  };
  await storage.writeContextSummary(projectId, summary);
  await storage.writeState(projectId, nextState);
  const contextUsage = await buildReaderContextUsage(prepared.project, nextState, '');
  return { summary, contextUsage };
}

function sameSummaryInputs(
  prepared: readonly GenerationRecord[],
  latest: readonly GenerationRecord[]
): boolean {
  return (
    prepared.length === latest.length &&
    prepared.every(
      (generation, index) =>
        generation.generationId === latest[index]?.generationId &&
        generation.responseText === latest[index]?.responseText
    )
  );
}

// NOTE: generation本文はNGリライトで同じIDのまま変わる。すでに要約済みなら、そのIDだけ
// 未要約へ戻しても既存要約から旧本文を差し引けないため、要約全体を破棄して現在の採用本文
// から作り直す。この関数は呼び出し側が project write lock を保持して使う。
export async function invalidateContextSummaryForGenerationUnlocked(
  projectId: string,
  generationId: string
): Promise<boolean> {
  const state = await storage.readState(projectId);
  if (!state?.contextSummary?.summarizedGenerationIds.includes(generationId)) return false;

  await storage.writeContextSummary(projectId, '');
  await storage.writeState(projectId, {
    ...state,
    contextSummary: {
      summarizedGenerationIds: [],
      updatedAt: nowIso(),
    },
  });
  return true;
}

// NOTE: 採用のたびに呼ぶ背景ジョブ。窓から落ちた場面が CONTEXT_SUMMARY_MIN_PENDING 件
// 溜まるまでは何もしない（no_context_to_compress を握りつぶす）。要約の失敗が採用や
// 本文生成を巻き込まないよう、storyState 抽出と同じく fire-and-forget にする。
const contextSummaryJobs = new Map<string, Promise<void>>();
const contextSummaryRerunRequests = new Set<string>();

export function startContextSummaryAfterAcceptance(projectId: string): void {
  if (contextSummaryJobs.has(projectId)) {
    // NOTE: 実行中の採用通知を捨てると、その採用で閾値へ達したpendingが次の採用まで
    // 要約されない。booleanの再実行要求に畳み、完了後に少なくとも1回は再確認する。
    contextSummaryRerunRequests.add(projectId);
    return;
  }
  const promise = runOutsideDataDirWrite(() =>
    withDataDirWrite(async () => {
      await compressProjectContext(projectId, { minPending: CONTEXT_SUMMARY_MIN_PENDING });
    })
  ).catch((err: unknown) => {
    if (err instanceof GenerateError && err.code === 'no_context_to_compress') return;
    console.warn('Context summary compression failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  contextSummaryJobs.set(projectId, promise);
  void promise.finally(() => {
    if (contextSummaryJobs.get(projectId) !== promise) return;
    contextSummaryJobs.delete(projectId);
    // promiseが解決してからmapを消すまでの間に来た通知も、ここで拾って新しいジョブにする。
    if (contextSummaryRerunRequests.delete(projectId)) {
      startContextSummaryAfterAcceptance(projectId);
    }
  });
}

// NOTE: NG表現の局所リライトで採用済み本文が書き換わったときに、その本文を含む章の
// .md を作り直す。generation の .md が正本で章 .md は派生物なので、片方だけ更新すると
// 書き出した原稿にだけ古い表現が残る。対象の generation が採用済みでなければ何もしない
// （下書きは章 .md に載っていないため）。
export async function rebuildEpisodeMarkdownForAcceptedGeneration(
  projectId: string,
  generationId: string
): Promise<boolean> {
  const episodeIds = await storage.listEpisodeIds(projectId);
  for (const episodeId of episodeIds) {
    const episode = await storage.readEpisodeRecord(projectId, episodeId);
    if (!episode) continue;
    if (!episode.scenes.some((scene) => scene.acceptedGenerationId === generationId)) continue;
    await updateEpisodeMarkdown(projectId, episode);
    return true;
  }
  return false;
}

async function updateEpisodeMarkdown(projectId: string, episode: EpisodeRecord): Promise<void> {
  const text = await buildEpisodeMarkdown(projectId, episode);
  await storage.writeEpisodeText(projectId, episode.episodeId, text);
}

// NOTE: withProjectWriteLock は projectLock.ts から re-export。移設理由の詳細は
// projectLock.ts のコメント参照（refineAutomationGuard との循環 import 回避）。

function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}
