import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { buildPrompt } from '../prompts/promptBuilder.js';
import * as expressionService from './expressionService.js';
import * as knowledgeService from './knowledgeService.js';
import {
  buildEpisodeMarkdown,
  getContextSummary,
  getRecentContext,
} from '../prompts/contextAssembler.js';
import { adapterMap } from '../adapters/index.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import {
  normalizeStoryState,
  revertLatestStoryStateDiffForGeneration,
  updateStoryStateFromAcceptedScene,
  withStoryStateLock,
} from './storyStateService.js';
import { writeShortcut } from './shortcutService.js';
import { runOutsideDataDirWrite, withDataDirWrite } from './dataDirLock.js';
import { countPromptTokens, resolveModelTokenLimits } from './modelInfoService.js';
import { estimateContextUsage } from '../utils/contextEstimate.js';
import type {
  AdapterGenerateResult,
  AdapterGenerateStreamEvent,
  ContextCompressionResult,
  ContextUsageEstimate,
  Character,
  EpisodeRecord,
  FinishReason,
  GenerationRecord,
  Memory,
  Project,
  ProjectState,
  ReaderNavigationState,
  ReaderState,
  SceneNavigationDirection,
  SceneRecord,
  StoryStateRefreshStatus,
} from '../types/index.js';

const TEMPERATURE_DEFAULT = 0.7;
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
const STORY_STATE_TIMEOUT_MS = 30_000;
const SUMMARY_CHUNK_CHARS = 20_000;

const projectWriteMutexes = new Map<string, Promise<void>>();

export interface GenerateOptions {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
}

export interface GenerateStreamOptions extends GenerateOptions {
  abortSignal?: AbortSignal;
}

export async function generateScene(
  projectId: string,
  options: GenerateOptions
): Promise<GenerationRecord> {
  return withProjectWriteLock(projectId, () => generateSceneUnlocked(projectId, options));
}

async function generateSceneUnlocked(
  projectId: string,
  options: GenerateOptions
): Promise<GenerationRecord> {
  await reloadCredentials();

  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorldPromptText(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  const [bannedExpressions, knowledgeTexts] = await Promise.all([
    expressionService.resolveBannedExpressions(projectId),
    knowledgeService.getEnabledKnowledgeTexts(projectId),
  ]);

  const { systemInstructions, userPrompt } = await buildPrompt({
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
  });

  const temperature = resolveTemperature(project.samplingConfig?.temperature, options.mode);

  const result = await generateWithAdapter(adapter, {
    systemInstructions,
    userPrompt,
    outputLength: project.outputLength,
    temperature,
    timeoutMs: TIMEOUT_MS,
    modelName: project.activeModelName,
    frequencyPenalty: project.samplingConfig?.frequencyPenalty,
    presencePenalty: project.samplingConfig?.presencePenalty,
  });

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
  };

  await storage.writeGenerationMarkdown(projectId, generationId, record.responseText);
  await storage.appendGenerationLog(projectId, record);

  await persistTargetScene(projectId, target, generationId);

  // state更新
  await storage.writeState(projectId, {
    ...state,
    currentEpisodeId: episodeId,
    currentSceneId: sceneId,
    selectedDraftGenerationId: generationId,
    lastOpenedAt: nowIso(),
  });

  await projectService.updateProject(projectId, { updatedAt: nowIso() });

  return record;
}

export async function generateSceneStream(
  projectId: string,
  options: GenerateStreamOptions,
  onChunk: (chunk: string) => void
): Promise<GenerationRecord> {
  return withProjectWriteLock(projectId, () =>
    generateSceneStreamUnlocked(projectId, options, onChunk)
  );
}

async function generateSceneStreamUnlocked(
  projectId: string,
  options: GenerateStreamOptions,
  onChunk: (chunk: string) => void
): Promise<GenerationRecord> {
  await reloadCredentials();
  throwIfAborted(options.abortSignal);

  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);
  throwIfAborted(options.abortSignal);

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  if (!adapter.generateTextStream) {
    const record = await generateSceneUnlocked(projectId, options);
    throwIfAborted(options.abortSignal);
    onChunk(record.responseText);
    return record;
  }

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorldPromptText(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  const [bannedExpressions, knowledgeTexts] = await Promise.all([
    expressionService.resolveBannedExpressions(projectId),
    knowledgeService.getEnabledKnowledgeTexts(projectId),
  ]);

  const { systemInstructions, userPrompt } = await buildPrompt({
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
  });

  const temperature = resolveTemperature(project.samplingConfig?.temperature, options.mode);
  const textParts: string[] = [];
  let finishReason: FinishReason = 'stop';
  let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;
  let debugInfo: string | undefined;
  let resolvedModelName: string | undefined;

  try {
    for await (const event of generateTextStreamWithPenaltyRetry(adapter, {
      systemInstructions,
      userPrompt,
      outputLength: project.outputLength,
      temperature,
      timeoutMs: TIMEOUT_MS,
      modelName: project.activeModelName,
      abortSignal: options.abortSignal,
      frequencyPenalty: project.samplingConfig?.frequencyPenalty,
      presencePenalty: project.samplingConfig?.presencePenalty,
    })) {
      throwIfAborted(options.abortSignal);
      if (event.type === 'chunk') {
        textParts.push(event.text);
        onChunk(event.text);
      } else {
        finishReason = event.finishReason;
        rawUsage = event.rawUsage;
        debugInfo = event.debugInfo;
        resolvedModelName = event.resolvedModelName;
      }
    }
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code, err.message), err.code, err.retryable);
    }
    throw err;
  }

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
  };

  await storage.writeGenerationMarkdown(projectId, generationId, record.responseText);
  await storage.appendGenerationLog(projectId, record);
  await persistTargetScene(projectId, target, generationId);

  await storage.writeState(projectId, {
    ...state,
    currentEpisodeId: episodeId,
    currentSceneId: sceneId,
    selectedDraftGenerationId: generationId,
    lastOpenedAt: nowIso(),
  });

  await projectService.updateProject(projectId, { updatedAt: nowIso() });

  return record;
}

async function generateWithAdapter(
  adapter: ModelAdapter,
  request: Parameters<ModelAdapter['generateText']>[0]
) {
  try {
    const result = await adapter.generateText(request);
    if (shouldRetryWithoutPenalty(result, request)) {
      console.warn('Retrying generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: result.errorCode,
        message: result.errorMessage,
      });
      try {
        return await adapter.generateText({
          ...request,
          frequencyPenalty: undefined,
          presencePenalty: undefined,
        });
      } catch (retryErr) {
        if (retryErr instanceof ModelAdapterError) {
          throw new GenerateError(
            mapErrorMessage(retryErr.code, retryErr.message),
            retryErr.code,
            retryErr.retryable
          );
        }
        throw retryErr;
      }
    }
    return result;
  } catch (err) {
    if (
      err instanceof ModelAdapterError &&
      isPenaltyUnsupportedError(err) &&
      hasPenalty(request)
    ) {
      console.warn('Retrying generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: err.code,
        message: err.message,
      });
      try {
        return await adapter.generateText({
          ...request,
          frequencyPenalty: undefined,
          presencePenalty: undefined,
        });
      } catch (retryErr) {
        if (retryErr instanceof ModelAdapterError) {
          throw new GenerateError(
            mapErrorMessage(retryErr.code, retryErr.message),
            retryErr.code,
            retryErr.retryable
          );
        }
        throw retryErr;
      }
    }
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code, err.message), err.code, err.retryable);
    }
    throw err;
  }
}

async function* generateTextStreamWithPenaltyRetry(
  adapter: ModelAdapter,
  request: Parameters<NonNullable<ModelAdapter['generateTextStream']>>[0]
): AsyncGenerator<AdapterGenerateStreamEvent> {
  let yielded = false;
  try {
    for await (const event of adapter.generateTextStream!(request)) {
      yielded = true;
      yield event;
    }
  } catch (err) {
    if (
      !yielded &&
      err instanceof ModelAdapterError &&
      isPenaltyUnsupportedError(err) &&
      hasPenalty(request)
    ) {
      console.warn('Retrying streaming generation without penalties after invalid argument error', {
        provider: adapter.providerName,
        code: err.code,
        message: err.message,
      });
      for await (const event of adapter.generateTextStream!({
        ...request,
        frequencyPenalty: undefined,
        presencePenalty: undefined,
      })) {
        yield event;
      }
      return;
    }
    throw err;
  }
}

function hasPenalty(
  request: Parameters<ModelAdapter['generateText']>[0]
): boolean {
  return Boolean(request.frequencyPenalty || request.presencePenalty);
}

function isPenaltyUnsupportedError(err: ModelAdapterError): boolean {
  return isPenaltyUnsupportedSignal(err.code, err.message);
}

function shouldRetryWithoutPenalty(
  result: AdapterGenerateResult,
  request: Parameters<ModelAdapter['generateText']>[0]
): boolean {
  return (
    result.finishReason === 'error' &&
    hasPenalty(request) &&
    isPenaltyUnsupportedSignal(result.errorCode, result.errorMessage)
  );
}

function isPenaltyUnsupportedSignal(code?: string, message?: string): boolean {
  // NOTE: 非ストリーミング adapters はHTTP 400を例外ではなく結果として返すため、
  // code/message のどちらにプロバイダ固有情報が載っても拾えるようにしている。
  const text = `${code ?? ''} ${message ?? ''}`;
  if (/INVALID_ARGUMENT|invalid_request|unsupported_?param/i.test(text)) return true;
  return code === 'api_error' && /\b400\b|bad request/i.test(message ?? '');
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
}

export async function acceptGeneration(projectId: string, generationId?: string): Promise<GenerationRecord> {
  const result = await withProjectWriteLock(projectId, () =>
    acceptGenerationUnlocked(projectId, generationId)
  );
  if (result.refreshStoryState) {
    startStoryStateRefreshAfterAcceptance(projectId, result.record.generationId);
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

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  if (generation.status === 'accepted') {
    return { record: generation, refreshStoryState: false };
  }

  generation.status = 'accepted';
  await storage.appendGenerationStatusLog(projectId, generation.generationId, generation.status);

  const episode = await storage.readEpisodeRecord(projectId, generation.episodeId);
  if (!episode) throw new Error(`Episode not found: ${generation.episodeId}`);

  const scene = episode.scenes.find((s) => s.sceneId === generation.sceneId);
  if (!scene) throw new Error(`Scene not found: ${generation.sceneId}`);

  // 以前の採用があれば上書き
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

  const storyStateRefresh = buildStoryStateRefreshStatus('pending', generation.generationId);
  await storage.writeState(projectId, {
    ...state,
    lastAcceptedGenerationId: generation.generationId,
    selectedDraftGenerationId: generation.generationId,
    storyStateRefresh,
  });

  return { record: generation, refreshStoryState: true };
}

function startStoryStateRefreshAfterAcceptance(projectId: string, generationId: string): void {
  runOutsideDataDirWrite(() => {
    void refreshStoryStateAfterAcceptance(projectId).catch((err) => {
      console.warn('Story state refresh failed', {
        projectId,
        generationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
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

  scene.acceptedGenerationId = null;
  await storage.writeEpisodeRecord(projectId, episode);

  await updateEpisodeMarkdown(projectId, episode);

  const nextState = {
    ...state,
    selectedDraftGenerationId: generation.generationId,
    lastAcceptedGenerationId:
      state.lastAcceptedGenerationId === acceptedId ? null : state.lastAcceptedGenerationId,
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

  return generation;
}

async function refreshStoryStateAfterAcceptance(projectId: string): Promise<void> {
  await withDataDirWrite(async () => {
    const status = await drainStoryStateBacklog(projectId, {
      lockRefreshStatusWrites: true,
    });
    if (status.status === 'stale') {
      console.warn('Story state refresh produced no update', {
        projectId,
        generationId: status.generationId,
        error: status.errorMessage,
      });
    }
  });
}

export async function refreshStoryState(projectId: string): Promise<ReaderState> {
  return refreshStoryStateUnlocked(projectId);
}

async function refreshStoryStateUnlocked(projectId: string): Promise<ReaderState> {
  const backlog = await calculateStoryStateBacklog(projectId);
  if (backlog.length === 0) {
    await writeStoryStateRefresh(projectId, buildStoryStateRefreshStatus('fresh', null));
    return getReaderState(projectId);
  }
  await writeStoryStateRefresh(projectId, buildStoryStateRefreshStatus('pending', backlog[0].generationId));
  await drainStoryStateBacklog(projectId, {
    lockRefreshStatusWrites: true,
    maxItems: 1,
  });
  return getReaderState(projectId);
}

async function drainStoryStateBacklog(
  projectId: string,
  options: { lockRefreshStatusWrites?: boolean; maxItems?: number } = {}
): Promise<StoryStateRefreshStatus> {
  const writeRefreshStatus = options.lockRefreshStatusWrites
    ? writeStoryStateRefresh
    : writeStoryStateRefreshUnlocked;

  try {
    const backlog = await calculateStoryStateBacklog(projectId);
    const firstGenerationId = backlog[0]?.generationId ?? null;
    if (backlog.length === 0) {
      return writeRefreshStatus(projectId, buildStoryStateRefreshStatus('fresh', null));
    }

    // NOTE: モデル呼び出しを直列に積むと手動再抽出も採用後更新も長時間
    // ブロックするため、1回の処理は1場面に限定する。残りは状態表示から再実行できる。
    const limit = backlog.slice(0, options.maxItems ?? 1);
    let processed = 0;
    let currentGenerationId = firstGenerationId;
    for (const item of limit) {
      currentGenerationId = item.generationId;
      const generation = await findGeneration(projectId, item.generationId);
      if (!generation || generation.status !== 'accepted') {
        return writeRefreshStatus(
          projectId,
          buildStoryStateRefreshStatus('stale', item.generationId, '未反映の採用済み本文が見つかりません。')
        );
      }
      const status = await refreshStoryStateForGeneration(projectId, generation, {
        lockRefreshStatusWrites: options.lockRefreshStatusWrites,
        skipRefreshStatusWrite: true,
      });
      if (status.status === 'stale') {
        return writeRefreshStatus(projectId, status);
      }
      processed += 1;
    }

    const remaining = Math.max(0, backlog.length - processed);
    return writeRefreshStatus(
      projectId,
      buildStoryStateRefreshStatus(
        remaining > 0 ? 'stale' : 'fresh',
        currentGenerationId,
        remaining > 0 ? `物語の状態に未反映の場面があと${remaining}件あります。` : undefined
      )
    );
  } catch (err) {
    return writeRefreshStatus(
      projectId,
      buildStoryStateRefreshStatus(
        'stale',
        null,
        storyStateErrorMessage(err)
      )
    );
  }
}

async function refreshStoryStateForGeneration(
  projectId: string,
  generation: GenerationRecord,
  options: { lockRefreshStatusWrites?: boolean; skipRefreshStatusWrite?: boolean } = {}
): Promise<StoryStateRefreshStatus> {
  const writeRefreshStatus = options.lockRefreshStatusWrites
    ? writeStoryStateRefresh
    : writeStoryStateRefreshUnlocked;

  try {
    await reloadCredentials();

    const project = await storage.readProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const adapter = adapterMap[project.activeModelProvider];
    if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

    const [characters, worldText] = await Promise.all([
      storage.readCharacters(projectId),
      storage.readWorldPromptText(projectId),
    ]);

    const updated = await updateStoryStateFromAcceptedScene({
      project,
      adapter,
      generation,
      characters,
      worldText,
      timeoutMs: STORY_STATE_TIMEOUT_MS,
    });

    if (!updated) {
      const stale = buildStoryStateRefreshStatus(
        'stale',
        generation.generationId,
        '物語の状態を更新できませんでした。設定を確認して再抽出してください。'
      );
      return options.skipRefreshStatusWrite ? stale : writeRefreshStatus(projectId, stale);
    }

    const fresh = buildStoryStateRefreshStatus('fresh', generation.generationId);
    return options.skipRefreshStatusWrite ? fresh : writeRefreshStatus(projectId, fresh);
  } catch (err) {
    const stale = buildStoryStateRefreshStatus('stale', generation.generationId, storyStateErrorMessage(err));
    return options.skipRefreshStatusWrite ? stale : writeRefreshStatus(projectId, stale);
  }
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
      });
    }
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

  await storage.writeState(projectId, { ...state, selectedDraftGenerationId: targetId });
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

  await storage.writeState(projectId, {
    ...state,
    currentSceneId: targetScene.sceneId,
    selectedDraftGenerationId,
    lastOpenedAt: nowIso(),
  });

  return getReaderState(projectId);
}

export async function compressProjectContext(projectId: string): Promise<ContextCompressionResult> {
  return withProjectWriteLock(projectId, () => compressProjectContextUnlocked(projectId));
}

async function compressProjectContextUnlocked(projectId: string): Promise<ContextCompressionResult> {
  await reloadCredentials();

  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);
  if (!state.currentEpisodeId) {
    throw new GenerateError('圧縮できる採用済み本文がまだありません。', 'no_context_to_compress', false);
  }

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  const episode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  if (!episode) {
    throw new GenerateError('圧縮できる採用済み本文がまだありません。', 'no_context_to_compress', false);
  }

  const acceptedText = await buildEpisodeMarkdown(projectId, episode);
  if (!acceptedText.trim()) {
    throw new GenerateError('圧縮できる採用済み本文がまだありません。', 'no_context_to_compress', false);
  }

  let summary = await storage.readContextSummary(projectId);
  const chunks = splitTextIntoChunks(acceptedText, SUMMARY_CHUNK_CHARS);

  for (const [index, chunk] of chunks.entries()) {
    const result = await generateWithAdapter(adapter, {
      systemInstructions: [
        'あなたは連載小説アプリの文脈圧縮係です。',
        '本文の雰囲気を壊さず、次回生成に必要な事実だけを簡潔に整理してください。',
        '小説本文を書かず、設定・人物・関係性・未解決の伏線・直近状況を箇条書き中心でまとめてください。',
      ].join('\n'),
      userPrompt: [
        `【既存の要約】\n${summary.trim() || 'なし'}`,
        `【追加で圧縮する本文 ${index + 1}/${chunks.length}】\n${chunk}`,
        '【出力】\n既存の要約と追加本文を統合した、次回生成用の要約だけを出力してください。',
      ].join('\n\n---\n\n'),
      outputLength: 1800,
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

  await storage.writeContextSummary(projectId, summary);
  const contextUsage = await buildReaderContextUsage(project, state, '');
  return { summary, contextUsage };
}

export async function findGeneration(
  projectId: string,
  generationId: string
): Promise<GenerationRecord | null> {
  return storage.findGenerationRecord(projectId, generationId);
}

export async function getGenerationMarkdown(
  projectId: string,
  generationId: string
): Promise<{ filename: string; text: string } | null> {
  const generation = await findGeneration(projectId, generationId);
  if (!generation) return null;

  const storedText = await storage.readGenerationMarkdown(projectId, generationId);
  return {
    filename: `${generationId}.md`,
    text: storedText || generation.responseText,
  };
}

type AcceptedGenerationRef = {
  generationId: string;
  episodeId: string;
  sceneId: string;
};

export async function calculateStoryStateBacklog(projectId: string): Promise<AcceptedGenerationRef[]> {
  const accepted = await listAcceptedGenerationRefs(projectId);
  const state = await storage.readState(projectId);
  const pendingGenerationId =
    state?.storyStateRefresh?.status === 'pending'
      ? state.storyStateRefresh.generationId
      : null;
  const processedIds = await withStoryStateLock(projectId, async () => {
    const rawStoryState = await storage.readStoryState(projectId);
    const hadProcessedIds =
      isRecord(rawStoryState) && Array.isArray(rawStoryState.processedGenerationIds);
    const storyState = normalizeStoryState(rawStoryState ?? undefined);

    if (!hadProcessedIds) {
      storyState.processedGenerationIds = accepted
        .map((item) => item.generationId)
        .filter((generationId) => generationId !== pendingGenerationId);
      await storage.writeStoryState(projectId, storyState);
    }

    return storyState.processedGenerationIds ?? [];
  });

  const processed = new Set(processedIds);
  return accepted.filter((item) => !processed.has(item.generationId));
}

async function listAcceptedGenerationRefs(projectId: string): Promise<AcceptedGenerationRef[]> {
  const episodeIds = await storage.listEpisodeIds(projectId);
  const episodes = await Promise.all(
    episodeIds.map((episodeId) => storage.readEpisodeRecord(projectId, episodeId))
  );
  return episodes
    .filter((episode): episode is EpisodeRecord => episode !== null)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .flatMap((episode) =>
      [...episode.scenes]
        .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
        .flatMap((scene) =>
          scene.acceptedGenerationId
            ? [
                {
                  generationId: scene.acceptedGenerationId,
                  episodeId: episode.episodeId,
                  sceneId: scene.sceneId,
                },
              ]
            : []
        )
    );
}

async function updateEpisodeMarkdown(projectId: string, episode: EpisodeRecord): Promise<void> {
  const text = await buildEpisodeMarkdown(projectId, episode);
  await storage.writeEpisodeText(projectId, episode.episodeId, text);
}

export class GenerateError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = 'GenerateError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GenerateError('生成が中断されました。', 'aborted', false);
  }
}

// NOTE: adapter が空応答時に埋める debugInfo からセーフティ由来かを判定する。
// promptFeedback.blockReason（PROHIBITED_CONTENT / SAFETY 等）か、blocked=true の
// candidateSafety が入っていれば「解除できない安全フィルタ」と見なす。HIGH でも
// blocked=false の評価はあり得るため、確率だけではブロック扱いにしない。
function classifyEmptyResponse(debugInfo?: string): { code: string; retryable: boolean } {
  if (isSafetyBlockedDiagnostic(debugInfo)) {
    return { code: 'safety_blocked', retryable: false };
  }
  return { code: 'empty_response', retryable: true };
}

function isSafetyBlockedDiagnostic(debugInfo?: string): boolean {
  return Boolean(
    debugInfo &&
      (/promptBlockReason=/.test(debugInfo) || /candidateSafety=\S*\(blocked\)/.test(debugInfo))
  );
}

function mapErrorMessage(code?: string, detail?: string): string {
  let base: string;
  switch (code) {
    case 'api_key_missing':
      base = 'APIキーが設定されていません。設定画面からAPIキーを入力してください。';
      break;
    case 'invalid_api_key':
      base = 'APIキーが無効です。設定を確認してください。';
      break;
    case 'payment_required':
      base = 'APIキーのクレジットが不足しています。プロバイダー側の残高や利用上限を確認してください。';
      break;
    case 'permission_denied':
      base = 'APIキーにこのモデルを利用する権限がないか、プロバイダー側で拒否されました。';
      break;
    case 'rate_limit':
      base = 'リクエスト制限に達しました。しばらくしてから再試行してください。';
      break;
    case 'timeout':
      base = '生成がタイムアウトしました。出力文量を下げるか、再試行してください。';
      break;
    case 'aborted':
      base = '生成が中断されました。';
      break;
    case 'network_error':
      base = 'モデルサービスに接続できませんでした。ネットワーク設定を確認して再試行してください。';
      break;
    case 'server_error':
    case 'service_unavailable':
      base = 'モデルサービスで一時的な問題が発生しました。再試行してください。';
      break;
    case 'content_filter':
    case 'safety_blocked':
      base =
        'AIの安全フィルタでブロックされ、本文が生成されませんでした。Geminiは解除できない固定フィルタ（PROHIBITED_CONTENT等）を持つため、創作用途では設定画面からDeepSeekへの切り替えをおすすめします。';
      break;
    case 'empty_response':
      base =
        'モデルからの本文が空でした。出力上限（maxOutputTokens）が不足しているか、モデル名が誤っている可能性があります。';
      break;
    default:
      base = '生成に失敗しました。設定画面のプロバイダー、モデル名、APIキーを確認してください。';
  }

  const safeDetail = sanitizeErrorDetail(detail);
  if (!safeDetail || safeDetail === base) return base;
  return `${base}\n詳細: ${safeDetail}`;
}

function sanitizeErrorDetail(detail?: string): string {
  if (!detail) return '';
  const collapsed = detail.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > 500 ? `${collapsed.slice(0, 500)}...` : collapsed;
}

export async function getReaderState(projectId: string): Promise<ReaderState> {
  const project = await storage.readProject(projectId);
  const state = await storage.readState(projectId);
  if (!project || !state) throw new Error(`Project not found: ${projectId}`);

  const [memories, knowledgeFiles] = await Promise.all([
    storage.readMemories(projectId),
    knowledgeService.listKnowledge(projectId),
  ]);

  let currentEpisode: EpisodeRecord | null = null;
  let currentScene: SceneRecord | null = null;
  let currentGeneration: GenerationRecord | null = null;

  if (state.currentEpisodeId) {
    currentEpisode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  }
  if (currentEpisode && state.currentSceneId) {
    currentScene = currentEpisode.scenes.find((s) => s.sceneId === state.currentSceneId) ?? null;
  }
  if (state.selectedDraftGenerationId) {
    currentGeneration = await findGeneration(projectId, state.selectedDraftGenerationId);
  }
  if (!currentGeneration && currentScene?.acceptedGenerationId) {
    currentGeneration = await findGeneration(projectId, currentScene.acceptedGenerationId);
  }

  const navigation = buildNavigationState(currentEpisode, currentScene);
  const contextUsage = await buildReaderContextUsage(project, state, '');
  const contextSummary = await storage.readContextSummary(projectId);
  const storyStateBacklogCount = (await calculateStoryStateBacklog(projectId)).length;
  const stateWithBacklog: ProjectState = {
    ...state,
    storyStateBacklogCount,
  };

  return {
    project,
    state: stateWithBacklog,
    storyStateBacklogCount,
    currentEpisode,
    currentScene,
    currentGeneration,
    memories,
    knowledgeFiles,
    navigation,
    contextUsage,
    contextSummaryExcerpt: contextSummary.slice(0, 240),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function writeStoryStateRefresh(
  projectId: string,
  storyStateRefresh: StoryStateRefreshStatus
): Promise<StoryStateRefreshStatus> {
  return withProjectWriteLock(projectId, () =>
    writeStoryStateRefreshUnlocked(projectId, storyStateRefresh)
  );
}

async function writeStoryStateRefreshUnlocked(
  projectId: string,
  storyStateRefresh: StoryStateRefreshStatus
): Promise<StoryStateRefreshStatus> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);
  await storage.writeState(projectId, {
    ...state,
    storyStateRefresh,
  });
  return storyStateRefresh;
}

function buildStoryStateRefreshStatus(
  status: StoryStateRefreshStatus['status'],
  generationId: string | null,
  errorMessage?: string
): StoryStateRefreshStatus {
  return {
    status,
    generationId,
    updatedAt: nowIso(),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function storyStateErrorMessage(err: unknown): string {
  if (err instanceof ModelAdapterError) return mapErrorMessage(err.code, err.message);
  if (err instanceof GenerateError) return err.message;
  if (err instanceof Error) return sanitizeErrorDetail(err.message) || '物語の状態更新に失敗しました。';
  return '物語の状態更新に失敗しました。';
}

// NOTE: 他サービス（refineChatService の apply 等）も同じロックを使いたいので
// export。ロック粒度は「プロジェクトごとの書き込み排他」で、生成と設定編集が
// 同時に走らないことを保証する。
export async function withProjectWriteLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = projectWriteMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  projectWriteMutexes.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await withDataDirWrite(task);
  } finally {
    release();
    if (projectWriteMutexes.get(projectId) === next) {
      projectWriteMutexes.delete(projectId);
    }
  }
}

function buildNavigationState(
  episode: EpisodeRecord | null,
  currentScene: SceneRecord | null
): ReaderNavigationState {
  if (!episode || !currentScene) {
    return {
      currentSceneOrder: null,
      totalScenes: episode?.scenes.length ?? 0,
      hasPreviousScene: false,
      hasNextScene: false,
    };
  }

  const index = episode.scenes.findIndex((scene) => scene.sceneId === currentScene.sceneId);
  return {
    currentSceneOrder: index >= 0 ? index + 1 : null,
    totalScenes: episode.scenes.length,
    hasPreviousScene: index > 0,
    hasNextScene: index >= 0 && index < episode.scenes.length - 1,
  };
}

async function buildReaderContextUsage(
  project: Project,
  state: ProjectState,
  wish: string
): Promise<ContextUsageEstimate | null> {
  const [memories, characters, worldText, presets, summaryText, recentContextText, knowledgeTexts] =
    await Promise.all([
      storage.readMemories(project.projectId),
      storage.readCharacters(project.projectId),
      storage.readWorldPromptText(project.projectId),
      storage.readPresets(project.projectId),
      getContextSummary(project.projectId),
      getRecentContext(project.projectId, state.currentEpisodeId, state.currentSceneId),
      knowledgeService.getEnabledKnowledgeTexts(project.projectId),
    ]);

  const bannedExpressions = await expressionService.resolveBannedExpressions(project.projectId);

  const { systemInstructions, userPrompt } = await buildPrompt({
    project,
    state,
    wish,
    memories: memories.filter((m) => m.status === 'active'),
    characters,
    worldText,
    baseSystemPrompt: presets?.baseSystemPrompt,
    customSystemPrompt: presets?.customSystemPrompt,
    bannedExpressions,
    knowledgeTexts,
  });
  const [modelLimits, promptTokenCount] = await Promise.all([
    resolveModelTokenLimits(project.activeModelProvider, project.activeModelName),
    countPromptTokens(
      project.activeModelProvider,
      project.activeModelName,
      systemInstructions,
      userPrompt
    ),
  ]);

  return estimateContextUsage({
    provider: project.activeModelProvider,
    modelName: project.activeModelName,
    systemInstructions,
    userPrompt,
    outputLength: project.outputLength,
    summaryText,
    recentContextText,
    knowledgeText: knowledgeTexts.map((item) => item.content).join('\n\n'),
    modelLimits,
    promptTokenCount,
  });
}

function splitTextIntoChunks(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    chunks.push(text.slice(i, i + maxChars));
  }
  return chunks;
}
