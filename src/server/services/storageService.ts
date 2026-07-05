import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROJECTS_DIR, SETUP_SESSIONS_DIR } from '../config.js';
import {
  ensureDir,
  readJsonFile,
  readTextFile,
  safeWriteFile,
  safeWriteJson,
} from '../utils/safeWrite.js';
import type {
  Character,
  EpisodeRecord,
  ExpressionsFile,
  GenerationRecord,
  GenerationStatus,
  Memory,
  PresetsFile,
  Project,
  ProjectState,
  RefineScanResult,
  RefineSession,
  SetupSession,
  StoryState,
} from '../types/index.js';

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function projectDir(projectId: string): string {
  assertSafePathSegment(projectId, 'projectId');
  return path.join(PROJECTS_DIR, projectId);
}

export function setupSessionJsonPath(sessionId: string): string {
  assertSafePathSegment(sessionId, 'sessionId');
  return path.join(SETUP_SESSIONS_DIR, `${sessionId}.json`);
}

export function projectJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'project.json');
}

export function stateJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'state.json');
}

export function presetsJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'presets.json');
}

export function charactersJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'characters.json');
}

export function memoriesJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'memories.json');
}

export function worldMdPath(projectId: string): string {
  return path.join(projectDir(projectId), 'world.md');
}

export function contextSummaryMdPath(projectId: string): string {
  return path.join(projectDir(projectId), 'context-summary.md');
}

export function storyStateJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'story-state.json');
}

export function expressionsJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'expressions.json');
}

export function refineScanJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'refineScan.json');
}

export function refineSessionJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'refineSession.json');
}

export function episodesDir(projectId: string): string {
  return path.join(projectDir(projectId), 'episodes');
}

export function episodeJsonPath(projectId: string, episodeId: string): string {
  assertSafePathSegment(episodeId, 'episodeId');
  return path.join(episodesDir(projectId), `${episodeId}.json`);
}

export function episodeMdPath(projectId: string, episodeId: string): string {
  assertSafePathSegment(episodeId, 'episodeId');
  return path.join(episodesDir(projectId), `${episodeId}.md`);
}

export function generationsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'generations');
}

export function generationLogPath(projectId: string): string {
  return path.join(generationsDir(projectId), 'generation-log.jsonl');
}

export function generationMdPath(projectId: string, generationId: string): string {
  assertSafePathSegment(generationId, 'generationId');
  return path.join(generationsDir(projectId), `${generationId}.md`);
}

export function generationPromptPath(projectId: string, generationId: string): string {
  assertSafePathSegment(generationId, 'generationId');
  return path.join(generationsDir(projectId), `${generationId}.prompt.txt`);
}

export async function createProjectDir(projectId: string): Promise<void> {
  await ensureDir(projectDir(projectId));
  await ensureDir(episodesDir(projectId));
  await ensureDir(generationsDir(projectId));
}

export async function readSetupSession(sessionId: string): Promise<SetupSession | null> {
  return readJsonFile<SetupSession>(setupSessionJsonPath(sessionId));
}

export async function writeSetupSession(session: SetupSession): Promise<void> {
  await safeWriteJson(setupSessionJsonPath(session.sessionId), session);
}

export async function setupSessionExists(sessionId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(setupSessionJsonPath(sessionId));
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function listSetupSessionIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SETUP_SESSIONS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((sessionId) => SAFE_PATH_SEGMENT.test(sessionId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export async function listProjectIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export async function readProject(projectId: string): Promise<Project | null> {
  return readJsonFile<Project>(projectJsonPath(projectId));
}

export async function writeProject(project: Project): Promise<void> {
  await safeWriteJson(projectJsonPath(project.projectId), project);
}

export async function readState(projectId: string): Promise<ProjectState | null> {
  return readJsonFile<ProjectState>(stateJsonPath(projectId));
}

export async function writeState(projectId: string, state: ProjectState): Promise<void> {
  await safeWriteJson(stateJsonPath(projectId), state);
}

export async function readPresets(projectId: string): Promise<PresetsFile | null> {
  return readJsonFile<PresetsFile>(presetsJsonPath(projectId));
}

export async function writePresets(projectId: string, presets: PresetsFile): Promise<void> {
  await safeWriteJson(presetsJsonPath(projectId), presets);
}

export async function readCharacters(projectId: string): Promise<Character[]> {
  const data = await readJsonFile<Character[]>(charactersJsonPath(projectId));
  return data ?? [];
}

export async function writeCharacters(projectId: string, characters: Character[]): Promise<void> {
  await safeWriteJson(charactersJsonPath(projectId), characters);
}

export async function readMemories(projectId: string): Promise<Memory[]> {
  const data = await readJsonFile<Memory[]>(memoriesJsonPath(projectId));
  return data ?? [];
}

export async function writeMemories(projectId: string, memories: Memory[]): Promise<void> {
  await safeWriteJson(memoriesJsonPath(projectId), memories);
}

export async function readStoryState(projectId: string): Promise<StoryState | null> {
  return readJsonFile<StoryState>(storyStateJsonPath(projectId));
}

export async function writeStoryState(projectId: string, storyState: StoryState): Promise<void> {
  await safeWriteJson(storyStateJsonPath(projectId), storyState);
}

export async function readExpressions(projectId: string): Promise<ExpressionsFile> {
  const data = await readJsonFile<ExpressionsFile>(expressionsJsonPath(projectId));
  return data ?? { schemaVersion: 1, ngExpressions: [] };
}

export async function writeExpressions(projectId: string, file: ExpressionsFile): Promise<void> {
  await safeWriteJson(expressionsJsonPath(projectId), file);
}

export async function readRefineScan(projectId: string): Promise<RefineScanResult | null> {
  return readJsonFile<RefineScanResult>(refineScanJsonPath(projectId));
}

export async function writeRefineScan(
  projectId: string,
  scan: RefineScanResult
): Promise<void> {
  await safeWriteJson(refineScanJsonPath(projectId), scan);
}

export async function readRefineSession(projectId: string): Promise<RefineSession | null> {
  return readJsonFile<RefineSession>(refineSessionJsonPath(projectId));
}

export async function writeRefineSession(
  projectId: string,
  session: RefineSession
): Promise<void> {
  await safeWriteJson(refineSessionJsonPath(projectId), session);
}

export async function deleteRefineSession(projectId: string): Promise<void> {
  await fs.rm(refineSessionJsonPath(projectId), { force: true });
}

export async function readWorld(projectId: string): Promise<string> {
  const text = await readTextFile(worldMdPath(projectId));
  return text ?? '';
}

export async function writeWorld(projectId: string, text: string): Promise<void> {
  await safeWriteFile(worldMdPath(projectId), text);
}

export async function readContextSummary(projectId: string): Promise<string> {
  const text = await readTextFile(contextSummaryMdPath(projectId));
  return text ?? '';
}

export async function writeContextSummary(projectId: string, text: string): Promise<void> {
  await safeWriteFile(contextSummaryMdPath(projectId), text);
}

export async function readEpisodeRecord(projectId: string, episodeId: string): Promise<EpisodeRecord | null> {
  return readJsonFile<EpisodeRecord>(episodeJsonPath(projectId, episodeId));
}

export async function listEpisodeIds(projectId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(episodesDir(projectId), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .filter((episodeId) => SAFE_PATH_SEGMENT.test(episodeId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
}

export async function writeEpisodeRecord(projectId: string, episode: EpisodeRecord): Promise<void> {
  await safeWriteJson(episodeJsonPath(projectId, episode.episodeId), episode);
}

export async function readEpisodeText(projectId: string, episodeId: string): Promise<string> {
  const text = await readTextFile(episodeMdPath(projectId, episodeId));
  return text ?? '';
}

export async function writeEpisodeText(projectId: string, episodeId: string, text: string): Promise<void> {
  await safeWriteFile(episodeMdPath(projectId, episodeId), text);
}

export async function appendGenerationLog(projectId: string, record: GenerationRecord): Promise<void> {
  const logPath = generationLogPath(projectId);
  await ensureDir(generationsDir(projectId));
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(logPath, line, 'utf-8');
}

export async function appendGenerationStatusLog(
  projectId: string,
  generationId: string,
  status: GenerationStatus
): Promise<void> {
  const logPath = generationLogPath(projectId);
  await ensureDir(generationsDir(projectId));
  const line =
    JSON.stringify({
      entryType: 'status',
      generationId,
      status,
      updatedAt: new Date().toISOString(),
    }) + '\n';
  await fs.appendFile(logPath, line, 'utf-8');
}

export async function findGenerationRecord(
  projectId: string,
  generationId: string
): Promise<GenerationRecord | null> {
  const text = await readTextFile(generationLogPath(projectId));
  if (!text) return null;

  let latestStatus: GenerationStatus | null = null;
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as Partial<GenerationRecord> & {
        entryType?: string;
        status?: GenerationStatus;
      };
      if (entry.generationId !== generationId) continue;
      if (entry.entryType === 'status' && isGenerationStatus(entry.status)) {
        latestStatus ??= entry.status;
        continue;
      }
      if (typeof entry.responseText === 'string') {
        const record = entry as GenerationRecord;
        return latestStatus ? { ...record, status: latestStatus } : record;
      }
    } catch {
      // 破損行は無視
    }
  }
  return null;
}

export async function readGenerationMarkdown(projectId: string, generationId: string): Promise<string> {
  const text = await readTextFile(generationMdPath(projectId, generationId));
  return text ?? '';
}

export async function readGenerationPromptSnapshot(
  projectId: string,
  generationId: string
): Promise<string> {
  const text = await readTextFile(generationPromptPath(projectId, generationId));
  return text ?? '';
}

export async function writeGenerationMarkdown(
  projectId: string,
  generationId: string,
  text: string
): Promise<void> {
  await ensureDir(generationsDir(projectId));
  await safeWriteFile(generationMdPath(projectId, generationId), text);
}

export async function writeGenerationPromptSnapshot(
  projectId: string,
  generationId: string,
  text: string
): Promise<void> {
  await ensureDir(generationsDir(projectId));
  await safeWriteFile(generationPromptPath(projectId, generationId), text);
}

export async function projectExists(projectId: string): Promise<boolean> {
  try {
    const stat = await fs.stat(projectDir(projectId));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function deleteProjectDir(projectId: string): Promise<void> {
  await fs.rm(projectDir(projectId), { recursive: true, force: true });
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
  return value === 'draft' || value === 'accepted' || value === 'rejected' || value === 'superseded';
}

export { readTextFile };
