import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import { buildPrompt } from '../prompts/promptBuilder.js';
import { buildEpisodeMarkdown } from '../prompts/contextAssembler.js';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import type {
  Character,
  EpisodeRecord,
  GenerationRecord,
  Memory,
  Project,
  ProjectState,
  SceneRecord,
} from '../types/index.js';

const TEMPERATURE_DEFAULT = 0.7;
const TEMPERATURE_VARIATE = 0.85;
const TIMEOUT_MS = 120_000;

const adapterMap = {
  openai: new OpenAIAdapter(),
};

export interface GenerateOptions {
  wish: string;
  mode: 'continue' | 'regenerate' | 'variate';
}

export async function generateScene(
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

  const target = await prepareTargetScene(projectId, state, options.mode);
  const { episodeId, sceneId } = target;

  const { systemInstructions, userPrompt } = await buildPrompt({
    project,
    state,
    wish: options.wish,
    memories,
    characters,
    worldText,
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
      mapErrorMessage(result.errorCode),
      result.errorCode || 'generation_failed',
      result.retryable
    );
  }

  const generationId = generateTimestampId('gen');
  const record: GenerationRecord = {
    generationId,
    sceneId,
    episodeId,
    request: {
      wish: options.wish,
      outputLength: project.outputLength,
      previousContextText: userPrompt,
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
  };

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

async function generateWithAdapter(
  adapter: OpenAIAdapter,
  request: Parameters<OpenAIAdapter['generateText']>[0]
) {
  try {
    return await adapter.generateText(request);
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new GenerateError(mapErrorMessage(err.code), err.code, err.retryable);
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
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const targetId = generationId || state.selectedDraftGenerationId;
  if (!targetId) throw new Error('No draft generation selected');

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  if (generation.status === 'accepted') return generation;

  generation.status = 'accepted';
  await storage.appendGenerationLog(projectId, generation);

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
      await storage.appendGenerationLog(projectId, draft);
    }
  }
  await storage.writeEpisodeRecord(projectId, episode);

  // Markdown更新
  await updateEpisodeMarkdown(projectId, episode);

  await storage.writeState(projectId, {
    ...state,
    lastAcceptedGenerationId: generation.generationId,
    selectedDraftGenerationId: generation.generationId,
  });

  return generation;
}

export async function rejectGeneration(projectId: string, generationId?: string): Promise<GenerationRecord> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);

  const targetId = generationId || state.selectedDraftGenerationId;
  if (!targetId) throw new Error('No draft generation selected');

  const generation = await findGeneration(projectId, targetId);
  if (!generation) throw new Error(`Generation not found: ${targetId}`);

  generation.status = 'rejected';
  await storage.appendGenerationLog(projectId, generation);

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

export async function findGeneration(
  projectId: string,
  generationId: string
): Promise<GenerationRecord | null> {
  const text = await storage.readTextFile(storage.generationLogPath(projectId));
  if (!text) return null;

  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as GenerationRecord;
      if (record.generationId === generationId) return record;
    } catch {
      // 破損行は無視
    }
  }
  return null;
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

function mapErrorMessage(code?: string): string {
  switch (code) {
    case 'api_key_missing':
      return 'APIキーが設定されていません。設定画面からAPIキーを入力してください。';
    case 'invalid_api_key':
      return 'APIキーが無効です。設定を確認してください。';
    case 'rate_limit':
      return 'リクエスト制限に達しました。しばらくしてから再試行してください。';
    case 'timeout':
      return '生成がタイムアウトしました。再試行してください。';
    case 'network_error':
      return 'モデルサービスに接続できませんでした。ネットワーク設定を確認して再試行してください。';
    case 'server_error':
    case 'service_unavailable':
      return 'モデルサービスで一時的な問題が発生しました。再試行してください。';
    default:
      return '生成に失敗しました。再試行してください。';
  }
}

export async function getReaderState(projectId: string): Promise<{
  project: Project;
  state: ProjectState;
  currentEpisode: EpisodeRecord | null;
  currentScene: SceneRecord | null;
  currentGeneration: GenerationRecord | null;
  memories: Memory[];
}> {
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

  return { project, state, currentEpisode, currentScene, currentGeneration, memories };
}
