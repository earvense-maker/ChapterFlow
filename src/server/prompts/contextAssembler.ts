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

  const acceptedTexts: string[] = [];
  let chars = 0;

  // 同じエピソード内の場面を後ろから見て、直近の採用済み本文を集める
  for (const scene of [...episode.scenes].reverse()) {
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
