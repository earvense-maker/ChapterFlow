import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { buildPrompt } from '../prompts/promptBuilder.js';
import {
  buildEpisodeMarkdown,
  getContextSummary,
  getRecentContext,
} from '../prompts/contextAssembler.js';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import { updateStoryStateFromAcceptedScene } from './storyStateService.js';
import { countPromptTokens, resolveModelTokenLimits } from './modelInfoService.js';
import { estimateContextUsage } from '../utils/contextEstimate.js';
import type {
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
const TEMPERATURE_VARIATE = 0.85;
const TEMPERATURE_SUMMARY = 0.25;
const TIMEOUT_MS = 120_000;
const STORY_STATE_TIMEOUT_MS = 30_000;
const SUMMARY_CHUNK_CHARS = 20_000;

const adapterMap = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
};

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

  const adapter = adapterMap[project.activeModelProvider as keyof typeof adapterMap];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorld(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  const { systemInstructions, userPrompt } = await buildPrompt({
    project,
    state,
    wish: options.wish,
    memories,
    characters,
    worldText,
    customSystemPrompt: presets?.customSystemPrompt,
  });

  const temperature = options.mode === 'variate' ? TEMPERATURE_VARIATE : TEMPERATURE_DEFAULT;

  const result = await generateWithAdapter(adapter, {
    systemInstructions,
    userPrompt,
    outputLength: project.outputLength,
    temperature,
    timeoutMs: TIMEOUT_MS,
    modelName: project.activeModelName,
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    throw new GenerateError(
      mapErrorMessage(result.errorCode, result.errorMessage),
      result.errorCode || 'generation_failed',
      result.retryable
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
      modelName: project.activeModelName,
    },
    referencedMemoryIds: memories.filter((m) => m.importance === 'high').map((m) => m.memoryId),
    status: 'draft',
    createdAt: nowIso(),
    parentGenerationId: state.selectedDraftGenerationId,
    outputFilePath,
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

  const adapter = adapterMap[project.activeModelProvider as keyof typeof adapterMap];
  if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

  if (!adapter.generateTextStream) {
    const record = await generateSceneUnlocked(projectId, options);
    throwIfAborted(options.abortSignal);
    onChunk(record.responseText);
    return record;
  }

  const memories = (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
  const characters = await storage.readCharacters(projectId);
  const worldText = await storage.readWorld(projectId);
  const presets = await storage.readPresets(projectId);

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  const { systemInstructions, userPrompt } = await buildPrompt({
    project,
    state,
    wish: options.wish,
    memories,
    characters,
    worldText,
    customSystemPrompt: presets?.customSystemPrompt,
  });

  const temperature = options.mode === 'variate' ? TEMPERATURE_VARIATE : TEMPERATURE_DEFAULT;
  const textParts: string[] = [];
  let finishReason: FinishReason = 'stop';

  try {
    for await (const event of adapter.generateTextStream({
      systemInstructions,
      userPrompt,
      outputLength: project.outputLength,
      temperature,
      timeoutMs: TIMEOUT_MS,
      modelName: project.activeModelName,
      abortSignal: options.abortSignal,
    })) {
      throwIfAborted(options.abortSignal);
      if (event.type === 'chunk') {
        textParts.push(event.text);
        onChunk(event.text);
      } else {
        finishReason = event.finishReason;
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
    responseText: textParts.join('').trim(),
    usedPresets: project.activePresetIds,
    usedModel: {
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
    },
    referencedMemoryIds: memories.filter((m) => m.importance === 'high').map((m) => m.memoryId),
    status: 'draft',
    createdAt: nowIso(),
    parentGenerationId: state.selectedDraftGenerationId,
    outputFilePath,
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
    return await adapter.generateText(request);
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code, err.message), err.code, err.retryable);
    }
    throw err;
  }
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

export async function acceptGeneration(projectId: string, generationId?: string): Promise<GenerationRecord> {
  return withProjectWriteLock(projectId, () => acceptGenerationUnlocked(projectId, generationId));
}

async function acceptGenerationUnlocked(
  projectId: string,
  generationId?: string
): Promise<GenerationRecord> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const targetId = generationId || state.selectedDraftGenerationId;
  if (!targetId) throw new Error('No draft generation selected');

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  if (generation.status === 'accepted') return generation;

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

  const storyStateRefresh = buildStoryStateRefreshStatus('pending', generation.generationId);
  await storage.writeState(projectId, {
    ...state,
    lastAcceptedGenerationId: generation.generationId,
    selectedDraftGenerationId: generation.generationId,
    storyStateRefresh,
  });

  void refreshStoryStateAfterAcceptance(projectId, generation).catch((err) => {
    console.warn('Story state refresh failed', {
      projectId,
      generationId: generation.generationId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return generation;
}

async function refreshStoryStateAfterAcceptance(
  projectId: string,
  generation: GenerationRecord
): Promise<void> {
  const status = await refreshStoryStateForGeneration(projectId, generation, {
    lockRefreshStatusWrites: true,
  });
  if (status.status === 'stale') {
    console.warn('Story state refresh produced no update', {
      projectId,
      generationId: generation.generationId,
      error: status.errorMessage,
    });
  }
}

export async function refreshStoryState(projectId: string): Promise<ReaderState> {
  return withProjectWriteLock(projectId, () => refreshStoryStateUnlocked(projectId));
}

async function refreshStoryStateUnlocked(projectId: string): Promise<ReaderState> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const generationId = state.lastAcceptedGenerationId ?? state.selectedDraftGenerationId;
  if (!generationId) {
    throw new GenerateError(
      '再抽出できる採用済み本文がまだありません。',
      'no_accepted_generation',
      false
    );
  }

  const generation = await findGeneration(projectId, generationId);
  if (!generation || generation.status !== 'accepted') {
    throw new GenerateError(
      '再抽出できる採用済み本文が見つかりません。',
      'accepted_generation_not_found',
      false
    );
  }

  await writeStoryStateRefreshUnlocked(projectId, buildStoryStateRefreshStatus('pending', generation.generationId));
  await refreshStoryStateForGeneration(projectId, generation);
  return getReaderState(projectId);
}

async function refreshStoryStateForGeneration(
  projectId: string,
  generation: GenerationRecord,
  options: { lockRefreshStatusWrites?: boolean } = {}
): Promise<StoryStateRefreshStatus> {
  const writeRefreshStatus = options.lockRefreshStatusWrites
    ? writeStoryStateRefresh
    : writeStoryStateRefreshUnlocked;

  try {
    await reloadCredentials();

    const project = await storage.readProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const adapter = adapterMap[project.activeModelProvider as keyof typeof adapterMap];
    if (!adapter) throw new Error(`Unsupported provider: ${project.activeModelProvider}`);

    const [characters, worldText] = await Promise.all([
      storage.readCharacters(projectId),
      storage.readWorld(projectId),
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
      return writeRefreshStatus(
        projectId,
        buildStoryStateRefreshStatus(
          'stale',
          generation.generationId,
          '物語の状態を更新できませんでした。設定を確認して再抽出してください。'
        )
      );
    }

    return writeRefreshStatus(
      projectId,
      buildStoryStateRefreshStatus('fresh', generation.generationId)
    );
  } catch (err) {
    return writeRefreshStatus(
      projectId,
      buildStoryStateRefreshStatus('stale', generation.generationId, storyStateErrorMessage(err))
    );
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
  return withProjectWriteLock(projectId, () => revertToPreviousUnlocked(projectId));
}

async function revertToPreviousUnlocked(projectId: string): Promise<GenerationRecord | null> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  if (!state.currentEpisodeId || !state.currentSceneId) return null;

  const episode = await storage.readEpisodeRecord(projectId, state.currentEpisodeId);
  if (!episode) return null;

  const scene = episode.scenes.find((s) => s.sceneId === state.currentSceneId);
  if (!scene) return null;

  // 現在のdraftを探し、前のdraftに戻す
  const currentId = state.selectedDraftGenerationId;
  const idx = scene.draftGenerationIds.findIndex((id) => id === currentId);
  if (idx <= 0) {
    // 前のdraftがなければ最後のacceptedに戻す
    if (scene.acceptedGenerationId) {
      const gen = await findGeneration(projectId, scene.acceptedGenerationId);
      if (gen) {
        await storage.writeState(projectId, { ...state, selectedDraftGenerationId: gen.generationId });
        return gen;
      }
    }
    return null;
  }

  const previousId = scene.draftGenerationIds[idx - 1];
  const previous = await findGeneration(projectId, previousId);
  if (!previous) return null;

  await storage.writeState(projectId, { ...state, selectedDraftGenerationId: previousId });
  return previous;
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

  const adapter = adapterMap[project.activeModelProvider as keyof typeof adapterMap];
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

function mapErrorMessage(code?: string, detail?: string): string {
  let base: string;
  switch (code) {
    case 'api_key_missing':
      base = 'APIキーが設定されていません。設定画面からAPIキーを入力してください。';
      break;
    case 'invalid_api_key':
      base = 'APIキーが無効です。設定を確認してください。';
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

  const memories = await storage.readMemories(projectId);

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

  return {
    project,
    state,
    currentEpisode,
    currentScene,
    currentGeneration,
    memories,
    navigation,
    contextUsage,
    contextSummaryExcerpt: contextSummary.slice(0, 240),
  };
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

async function withProjectWriteLock<T>(
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
    return await task();
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
  const [memories, characters, worldText, presets, summaryText, recentContextText] =
    await Promise.all([
      storage.readMemories(project.projectId),
      storage.readCharacters(project.projectId),
      storage.readWorld(project.projectId),
      storage.readPresets(project.projectId),
      getContextSummary(project.projectId),
      getRecentContext(project.projectId, state.currentEpisodeId, state.currentSceneId),
    ]);

  const { systemInstructions, userPrompt } = await buildPrompt({
    project,
    state,
    wish,
    memories: memories.filter((m) => m.status === 'active'),
    characters,
    worldText,
    customSystemPrompt: presets?.customSystemPrompt,
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
