import * as storage from '../services/storageService.js';
import { readStoryState } from '../services/storyStateService.js';
import { dropLeadingTextToBoundary } from '../utils/textBoundary.js';
import type { EpisodeRecord, GenerationRecord, ProjectId, SceneId, StoryState } from '../types/index.js';

const DEFAULT_MAX_CHARS = 12000;

export async function getRecentContext(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: { maxChars?: number; includeCurrentScene?: boolean } = {}
): Promise<string> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // NOTE: variate / regenerate モードでは現在シーンの採用済み本文を除外する。
  // 含めたままだと AI が「その先」を書いてしまい、現在シーンの別案ではなく
  // 次のシーンの内容がドラフトとして保存されてしまうため。
  const includeCurrentScene = options.includeCurrentScene ?? true;

  if (!currentEpisodeId || !currentSceneId) return '';

  const episode = await storage.readEpisodeRecord(projectId, currentEpisodeId);
  if (!episode) return '';

  const currentIndex = episode.scenes.findIndex((scene) => scene.sceneId === currentSceneId);
  if (currentIndex < 0) return '';

  const upperExclusive = includeCurrentScene ? currentIndex + 1 : currentIndex;
  const contextScenes = episode.scenes.slice(0, upperExclusive);
  const acceptedTexts: string[] = [];
  let chars = 0;

  // NOTE: When the reader is moved to an earlier scene, later scenes must not leak into the prompt.
  for (const scene of [...contextScenes].reverse()) {
    if (!scene.acceptedGenerationId) continue;
    const generation = await findGeneration(projectId, scene.acceptedGenerationId);
    if (!generation) continue;
    acceptedTexts.unshift(generation.responseText);
    chars += generation.responseText.length;
    if (chars >= maxChars) break;
  }

  if (acceptedTexts.length === 0) return '';

  const joined = acceptedTexts.join('\n\n');
  if (joined.length <= maxChars) return joined;
  return dropLeadingTextToBoundary(joined.slice(-maxChars));
}

// NOTE: variate / regenerate モード向け。現在シーンの「書き直し対象本文」を返す。
// 採用済み本文があればそれを、なければ選択中のドラフトを、それも無ければ空文字。
export async function getCurrentSceneReferenceText(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  selectedDraftGenerationId: string | null
): Promise<string> {
  if (!currentEpisodeId || !currentSceneId) return '';
  const episode = await storage.readEpisodeRecord(projectId, currentEpisodeId);
  if (!episode) return '';
  const scene = episode.scenes.find((s) => s.sceneId === currentSceneId);
  if (!scene) return '';

  const targetGenId = scene.acceptedGenerationId ?? selectedDraftGenerationId;
  if (!targetGenId) return '';

  const generation = await findGeneration(projectId, targetGenId);
  return generation?.responseText ?? '';
}

export async function getContextSummary(projectId: ProjectId): Promise<string> {
  return storage.readContextSummary(projectId);
}

export async function getStoryState(projectId: ProjectId): Promise<StoryState> {
  return readStoryState(projectId);
}

async function findGeneration(
  projectId: ProjectId,
  generationId: string
): Promise<GenerationRecord | null> {
  return storage.findGenerationRecord(projectId, generationId);
}

export async function getAcceptedEpisodeText(projectId: ProjectId, episodeId: string): Promise<string> {
  return storage.readEpisodeText(projectId, episodeId);
}

export async function buildEpisodeMarkdown(
  projectId: ProjectId,
  episode: EpisodeRecord
): Promise<string> {
  const parts: string[] = [];
  for (const scene of episode.scenes) {
    if (!scene.acceptedGenerationId) continue;
    const generation = await findGeneration(projectId, scene.acceptedGenerationId);
    if (generation) parts.push(generation.responseText);
  }
  return parts.join('\n\n');
}

export async function appendToEpisodeText(
  projectId: ProjectId,
  episodeId: string,
  text: string
): Promise<void> {
  const existing = await storage.readEpisodeText(projectId, episodeId);
  const next = existing ? `${existing}\n\n${text}` : text;
  await storage.writeEpisodeText(projectId, episodeId, next);
}
