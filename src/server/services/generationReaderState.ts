// NOTE: generationService から切り出した「読書画面の組み立て」と「物語状態の
// 自動再抽出」クラスタ。二重抽出を防ぐプロセス内キュー(storyStateRefreshJobs)を
// 保持し、reader 状態と物語状態が相互に参照し合うためひとつのモジュールに束ねる。
// 依存は下位方向のみ（generationErrors などの葉）で、生成本体からは一方向に
// import される（循環なし）。

import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import { buildPrompt } from '../prompts/promptBuilder.js';
import * as expressionService from './expressionService.js';
import * as knowledgeService from './knowledgeService.js';
import {
  getContextSummary,
  getRecentContext,
} from '../prompts/contextAssembler.js';
import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import {
  normalizeStoryState,
  updateStoryStateFromAcceptedScene,
  withStoryStateLock,
} from './storyStateService.js';

import { runOutsideDataDirWrite, withDataDirWrite } from './dataDirLock.js';
import { withProjectWriteLock } from './projectLock.js';
import {
  readAndNormalizeMaintenance,
} from './refineAutomationGuard.js';
import { countPromptTokens, resolveModelTokenLimits } from './modelInfoService.js';
import { estimateContextUsage } from '../utils/contextEstimate.js';

import type {
  ContextUsageEstimate,
  EpisodeRecord,
  GenerationRecord,
  Project,
  ProjectState,
  ReaderNavigationState,
  ReaderState,
  SceneRecord,
  StoryStateRefreshStatus,
} from '../types/index.js';
import { GenerateError, mapErrorMessage, sanitizeErrorDetail } from './generationErrors.js';

const STORY_STATE_TIMEOUT_MS = 30_000;

interface StoryStateRefreshJob {
  promise: Promise<void>;
  generationId: string;
  queuedGenerationIds: string[];
}

// NOTE: これは二重抽出を防ぐプロセス内キューであり、物語状態の正本ではない。
// 再起動後は永続化された pending を readStoryStateBacklog から手動回復できる。
const storyStateRefreshJobs = new Map<string, StoryStateRefreshJob>();

export function startStoryStateRefreshAfterAcceptance(projectId: string, generationId: string): void {
  void startStoryStateRefreshJob(projectId, generationId).catch((err) => {
    console.warn('Story state refresh failed', {
      projectId,
      generationId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function refreshStoryState(projectId: string): Promise<ReaderState> {
  const refreshRequest = await withProjectWriteLock(projectId, async () => {
    // NOTE: check と job 登録を同じプロジェクトロックで行う。連打した手動再抽出が
    // calculateStoryStateBacklog の await 境界で別々のモデル呼び出しへ分かれないようにする。
    const activeJob = storyStateRefreshJobs.get(projectId);
    if (activeJob) {
      // NOTE: 完了処理の state.json 置換と ReaderState 読取りを同じロックで直列化する。
      return { job: null, readerState: await getReaderState(projectId) };
    }

    const backlog = await calculateStoryStateBacklog(projectId);
    if (backlog.length === 0) {
      await writeStoryStateRefreshUnlocked(projectId, buildStoryStateRefreshStatus('fresh', null));
      return { job: null, readerState: null };
    }

    const generationId = backlog[0].generationId;
    await writeStoryStateRefreshUnlocked(
      projectId,
      buildStoryStateRefreshStatus('pending', generationId)
    );
    return { job: startStoryStateRefreshJob(projectId, generationId), readerState: null };
  });
  const job = refreshRequest.job;
  if (!job) return refreshRequest.readerState ?? getReaderState(projectId);

  await job;
  return getReaderState(projectId);
}

function startStoryStateRefreshJob(projectId: string, generationId: string): Promise<void> {
  const existing = storyStateRefreshJobs.get(projectId);
  if (existing) {
    if (
      existing.generationId !== generationId &&
      !existing.queuedGenerationIds.includes(generationId)
    ) {
      existing.queuedGenerationIds.push(generationId);
    }
    return existing.promise;
  }

  const job: StoryStateRefreshJob = {
    promise: Promise.resolve(),
    generationId,
    queuedGenerationIds: [],
  };
  // NOTE: 背景抽出は採用時の AsyncLocalStorage 書込みスコープを継承させない。
  // ただし実行中はデータディレクトリの切替・削除と競合しないよう、job 全体を
  // 独立した書込みスコープとして保持する。
  const promise = runOutsideDataDirWrite(() =>
    withDataDirWrite(() => runStoryStateRefreshJob(projectId, job))
  );
  job.promise = promise;
  storyStateRefreshJobs.set(projectId, job);
  void promise.then(
    () => {
      if (storyStateRefreshJobs.get(projectId) === job) {
        storyStateRefreshJobs.delete(projectId);
      }
    },
    () => {
      if (storyStateRefreshJobs.get(projectId) === job) {
        storyStateRefreshJobs.delete(projectId);
      }
    }
  );
  return promise;
}

async function runStoryStateRefreshJob(projectId: string, job: StoryStateRefreshJob): Promise<void> {
  // NOTE: クライアントの ReaderState 再取得より先にモデルが応答しても、旧データの
  // processedGenerationIds 移行を確定してから新しい採用本文を追加する。
  await calculateStoryStateBacklog(projectId);

  while (true) {
    const generationId = job.generationId;
    const backlog = await readStoryStateBacklog(projectId);
    const backlogItem = backlog.find((item) => item.generationId === generationId);

    if (backlogItem) {
      const generation = await findGeneration(projectId, generationId);
      const refreshStatus =
        !generation || generation.status !== 'accepted'
          ? buildStoryStateRefreshStatus(
              'stale',
              generationId,
              '未反映の採用済み本文が見つかりません。'
            )
          : await refreshStoryStateForGeneration(projectId, generation, {
              skipRefreshStatusWrite: true,
            });

      if (refreshStatus.status === 'stale') {
        const wroteOwnedStatus = await writeStoryStateRefreshIfOwned(
          projectId,
          generationId,
          refreshStatus
        );
        if (!wroteOwnedStatus) {
          await writeQueuedStoryStateRefreshStale(projectId, job);
        }
        if (refreshStatus.errorMessage) {
          console.warn('Story state refresh produced no update', {
            projectId,
            generationId,
            error: refreshStatus.errorMessage,
          });
        }
        return;
      }
    }

    const remaining = await readStoryStateBacklog(projectId);
    const nextGenerationId = takeQueuedBacklogGenerationId(job, remaining);
    if (nextGenerationId) {
      job.generationId = nextGenerationId;
      continue;
    }

    const terminalStatus = buildStoryStateRefreshStatus(
      remaining.length > 0 ? 'stale' : 'fresh',
      generationId,
      remaining.length > 0
        ? `物語の状態に未反映の場面があと${remaining.length}件あります。`
        : undefined
    );
    await writeStoryStateRefreshIfOwned(projectId, generationId, terminalStatus);
    if (terminalStatus.status === 'stale') {
      if (terminalStatus.errorMessage) {
        console.warn('Story state refresh produced no update', {
          projectId,
          generationId,
          error: terminalStatus.errorMessage,
        });
      }
      return;
    }
    return;
  }
}

function takeQueuedBacklogGenerationId(
  job: StoryStateRefreshJob,
  backlog: AcceptedGenerationRef[]
): string | null {
  const currentBacklogIds = new Set(backlog.map((item) => item.generationId));
  while (job.queuedGenerationIds.length > 0) {
    const generationId = job.queuedGenerationIds.shift();
    if (generationId && currentBacklogIds.has(generationId)) return generationId;
  }
  return null;
}

async function refreshStoryStateForGeneration(
  projectId: string,
  generation: GenerationRecord,
  options: { skipRefreshStatusWrite?: boolean } = {}
): Promise<StoryStateRefreshStatus> {
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
      applyIfCurrent: (apply) =>
        withProjectWriteLock(projectId, async () => {
          if (!(await isCurrentAcceptedGeneration(projectId, generation))) return null;
          return apply();
        }),
    });

    if (!updated) {
      // 差し替え採用により、モデル応答待ちの間に対象が現在の採用本文でなくなった。
      // runStoryStateRefreshJob が待機列と最新 backlog を見て次の採用本文へ進む。
      const fresh = buildStoryStateRefreshStatus('fresh', generation.generationId);
      return options.skipRefreshStatusWrite ? fresh : writeStoryStateRefresh(projectId, fresh);
    }

    const fresh = buildStoryStateRefreshStatus('fresh', generation.generationId);
    return options.skipRefreshStatusWrite ? fresh : writeStoryStateRefresh(projectId, fresh);
  } catch (err) {
    const stale = buildStoryStateRefreshStatus('stale', generation.generationId, storyStateErrorMessage(err));
    return options.skipRefreshStatusWrite ? stale : writeStoryStateRefresh(projectId, stale);
  }
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
  const [accepted, state] = await Promise.all([
    listAcceptedGenerationRefs(projectId),
    storage.readState(projectId),
  ]);
  const pendingGenerationId =
    state?.storyStateRefresh?.status === 'pending' ? state.storyStateRefresh.generationId : null;
  const activeJob = storyStateRefreshJobs.get(projectId);
  const protectedGenerationIds = new Set<string>(
    [pendingGenerationId, activeJob?.generationId, ...(activeJob?.queuedGenerationIds ?? [])].filter(
      (generationId): generationId is string => Boolean(generationId)
    )
  );

  await withStoryStateLock(projectId, async () => {
    const rawStoryState = await storage.readStoryState(projectId);
    const hadProcessedIds = Array.isArray(rawStoryState?.processedGenerationIds);
    if (hadProcessedIds) return;

    // NOTE: 旧データは pending の採用本文だけを未処理として引き継ぐ。通常の
    // Reader 読み込みではこの移行を書き込むが、レビューは read-only query を使う。
    const storyState = normalizeStoryState(rawStoryState ?? undefined);
    storyState.processedGenerationIds = accepted
      .map((item) => item.generationId)
      .filter((generationId) => !protectedGenerationIds.has(generationId));
    await storage.writeStoryState(projectId, storyState);
  });

  return readStoryStateBacklog(projectId);
}

// NOTE: レビューや進行中ジョブが安全に利用できる、書き込みを行わない backlog query。
// processedGenerationIds を持たない旧データは、現行移行規則と同じく pending の採用
// generation だけを未抽出扱いにする。
export async function readStoryStateBacklog(projectId: string): Promise<AcceptedGenerationRef[]> {
  const [accepted, state, storyState] = await Promise.all([
    listAcceptedGenerationRefs(projectId),
    storage.readState(projectId),
    storage.readStoryState(projectId),
  ]);
  const pendingGenerationId =
    state?.storyStateRefresh?.status === 'pending' ? state.storyStateRefresh.generationId : null;
  const processedIds = storyState?.processedGenerationIds;

  if (!Array.isArray(processedIds)) {
    return pendingGenerationId
      ? accepted.filter((item) => item.generationId === pendingGenerationId)
      : [];
  }

  const processed = new Set(processedIds);
  return accepted.filter((item) => !processed.has(item.generationId));
}

async function isCurrentAcceptedGeneration(
  projectId: string,
  generation: GenerationRecord
): Promise<boolean> {
  const episode = await storage.readEpisodeRecord(projectId, generation.episodeId);
  return (
    episode?.scenes.some(
      (scene) =>
        scene.sceneId === generation.sceneId &&
        scene.acceptedGenerationId === generation.generationId
    ) ?? false
  );
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

export async function getReaderState(projectId: string): Promise<ReaderState> {
  // NOTE: ReaderState は再起動後に最初に読まれやすい経路。期限切れで process 内 job が
  // 無い scanning/applying/reverting をここで failed に正規化し、永久ロックを残さない。
  await readAndNormalizeMaintenance(projectId);
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

async function writeStoryStateRefresh(
  projectId: string,
  storyStateRefresh: StoryStateRefreshStatus
): Promise<StoryStateRefreshStatus> {
  return withProjectWriteLock(projectId, () =>
    writeStoryStateRefreshUnlocked(projectId, storyStateRefresh)
  );
}

async function writeStoryStateRefreshIfOwned(
  projectId: string,
  generationId: string,
  storyStateRefresh: StoryStateRefreshStatus
): Promise<boolean> {
  return withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    if (
      !state ||
      state.storyStateRefresh?.status !== 'pending' ||
      state.storyStateRefresh.generationId !== generationId
    ) {
      return false;
    }
    await storage.writeState(projectId, { ...state, storyStateRefresh });
    return true;
  });
}

async function writeQueuedStoryStateRefreshStale(
  projectId: string,
  job: StoryStateRefreshJob
): Promise<boolean> {
  const queuedGenerationIds = new Set(job.queuedGenerationIds);
  return withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const currentRefresh = state?.storyStateRefresh;
    if (
      !state ||
      currentRefresh?.status !== 'pending' ||
      !currentRefresh.generationId ||
      !queuedGenerationIds.has(currentRefresh.generationId)
    ) {
      return false;
    }
    await storage.writeState(projectId, {
      ...state,
      storyStateRefresh: buildStoryStateRefreshStatus(
        'stale',
        currentRefresh.generationId,
        '先に採用した場面の状態整理に失敗したため、未反映の場面があります。再抽出してください。'
      ),
    });
    return true;
  });
}

export async function writeStoryStateRefreshUnlocked(
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

export function buildStoryStateRefreshStatus(
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

export async function buildReaderContextUsage(
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

