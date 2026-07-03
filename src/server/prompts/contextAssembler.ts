import * as storage from '../services/storageService.js';
import type { EpisodeRecord, GenerationRecord, ProjectId, SceneId } from '../types/index.js';

const DEFAULT_MAX_CHARS = 4000;

export async function getRecentContext(
  projectId: ProjectId,
  currentEpisodeId: string | null,
  currentSceneId: SceneId | null,
  options: { maxChars?: number } = {}
): Promise<string> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  if (!currentEpisodeId || !currentSceneId) return '';

  const episode = await storage.readEpisodeRecord(projectId, currentEpisodeId);
  if (!episode) return '';

  const currentIndex = episode.scenes.findIndex((scene) => scene.sceneId === currentSceneId);
  if (currentIndex < 0) return '';

  const contextScenes = episode.scenes.slice(0, currentIndex + 1);
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
  return joined.slice(-maxChars);
}

export async function getContextSummary(projectId: ProjectId): Promise<string> {
  return storage.readContextSummary(projectId);
}

async function findGeneration(
  projectId: ProjectId,
  generationId: string
): Promise<GenerationRecord | null> {
  // NOTE: generation-log.jsonlから生成履歴を検索する
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
