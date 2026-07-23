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
import { withDataDirWrite } from './dataDirLock.js';
import type {
  Character,
  EpisodeRecord,
  ExpressionsFile,
  GenerationRecord,
  GenerationStatus,
  KnowledgeExtension,
  KnowledgeIndexFile,
  Memory,
  PresetsFile,
  Project,
  ProjectState,
  RefineAutomationStore,
  RefineScanResult,
  RefineSession,
  RoleplaySession,
  SetupSession,
  StoryState,
  StoryStateDiffRecord,
  WorldContent,
} from '../types/index.js';
import {
  hasCompleteCanonicalWorldStructure,
  parseWorldMd,
  serializeWorldMd,
} from '../utils/worldMd.js';
import {
  normalizeCharactersForStorage,
  type LegacyCharacterInput,
} from '../../shared/characterSchema.js';

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

async function removeDataPath(filePath: string, options: Parameters<typeof fs.rm>[1]): Promise<void> {
  await withDataDirWrite(() => fs.rm(filePath, options));
}

export function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function assertKnowledgeExtension(value: unknown): asserts value is KnowledgeExtension {
  if (value !== 'md' && value !== 'txt') {
    throw new Error(`Invalid knowledge extension: ${String(value)}`);
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

export function legacyCharactersBackupPath(projectId: string): string {
  return path.join(projectDir(projectId), 'characters.pre-traits-v1.json');
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

export function storyStateDiffsJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'story-state-diffs.json');
}

export function expressionsJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'expressions.json');
}

export function knowledgeDir(projectId: string): string {
  return path.join(projectDir(projectId), 'knowledge');
}

export function knowledgeIndexJsonPath(projectId: string): string {
  return path.join(knowledgeDir(projectId), 'knowledge.json');
}

export function knowledgeContentPath(
  projectId: string,
  knowledgeId: string,
  extension: KnowledgeExtension
): string {
  assertSafePathSegment(knowledgeId, 'knowledgeId');
  assertKnowledgeExtension(extension);
  return path.join(knowledgeDir(projectId), `${knowledgeId}.${extension}`);
}

export function refineScanJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'refineScan.json');
}

export function roleplaySessionsDir(projectId: string): string {
  return path.join(projectDir(projectId), 'roleplay', 'sessions');
}

export function roleplaySessionJsonPath(projectId: string, sessionId: string): string {
  assertSafePathSegment(sessionId, 'sessionId');
  return path.join(roleplaySessionsDir(projectId), `${sessionId}.json`);
}

export function refineSessionJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'refineSession.json');
}

// NOTE: 自動レビュー run の監査記録・取り消し用 snapshot 専用ファイル。
// refineSession.json へ埋め込まず、画面表示時に合成する（設計書 5.5）。
export function refineAutomationJsonPath(projectId: string): string {
  return path.join(projectDir(projectId), 'refineAutomation.json');
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

export async function deleteSetupSession(sessionId: string): Promise<void> {
  await removeDataPath(setupSessionJsonPath(sessionId), { force: true });
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
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_PATH_SEGMENT.test(entry.name))
      .map((entry) => entry.name);
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
  const data = await readJsonFile<LegacyCharacterInput[]>(charactersJsonPath(projectId));
  return normalizeCharactersForStorage(Array.isArray(data) ? data : []);
}

export async function writeCharacters(
  projectId: string,
  characters: LegacyCharacterInput[]
): Promise<void> {
  await withDataDirWrite(async () => {
    await backupLegacyCharactersOnce(projectId);
    await safeWriteJson(
      charactersJsonPath(projectId),
      normalizeCharactersForStorage(characters)
    );
  });
}

async function backupLegacyCharactersOnce(projectId: string): Promise<void> {
  const sourcePath = charactersJsonPath(projectId);
  let raw: string;
  try {
    raw = await fs.readFile(sourcePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        (Object.hasOwn(item, 'want') || Object.hasOwn(item, 'fear'))
    )
  ) {
    return;
  }

  try {
    // NOTE: ダウングレード復旧用。最初の旧形式だけを保持し、以後は上書きしない。
    await fs.writeFile(legacyCharactersBackupPath(projectId), raw, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
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

export async function readStoryStateDiffs(projectId: string): Promise<StoryStateDiffRecord[]> {
  const data = await readJsonFile<StoryStateDiffRecord[]>(storyStateDiffsJsonPath(projectId));
  return data ?? [];
}

export async function writeStoryStateDiffs(
  projectId: string,
  diffs: StoryStateDiffRecord[]
): Promise<void> {
  await safeWriteJson(storyStateDiffsJsonPath(projectId), diffs);
}

export async function readExpressions(projectId: string): Promise<ExpressionsFile> {
  const data = await readJsonFile<ExpressionsFile>(expressionsJsonPath(projectId));
  return data ?? { schemaVersion: 1, ngExpressions: [] };
}

export async function writeExpressions(projectId: string, file: ExpressionsFile): Promise<void> {
  await safeWriteJson(expressionsJsonPath(projectId), file);
}

export async function readKnowledgeIndex(projectId: string): Promise<KnowledgeIndexFile> {
  const data = await readJsonFile<KnowledgeIndexFile>(knowledgeIndexJsonPath(projectId));
  return data ?? { schemaVersion: 1, files: [] };
}

export async function writeKnowledgeIndex(
  projectId: string,
  index: KnowledgeIndexFile
): Promise<void> {
  await ensureDir(knowledgeDir(projectId));
  await safeWriteJson(knowledgeIndexJsonPath(projectId), index);
}

export async function readKnowledgeContent(
  projectId: string,
  knowledgeId: string,
  extension: KnowledgeExtension
): Promise<string> {
  const text = await readTextFile(knowledgeContentPath(projectId, knowledgeId, extension));
  return text ?? '';
}

export async function knowledgeContentExists(
  projectId: string,
  knowledgeId: string,
  extension: KnowledgeExtension
): Promise<boolean> {
  try {
    const stat = await fs.stat(knowledgeContentPath(projectId, knowledgeId, extension));
    return stat.isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw err;
  }
}

export async function writeKnowledgeContent(
  projectId: string,
  knowledgeId: string,
  extension: KnowledgeExtension,
  text: string
): Promise<void> {
  await ensureDir(knowledgeDir(projectId));
  await safeWriteFile(knowledgeContentPath(projectId, knowledgeId, extension), text);
}

export async function deleteKnowledgeContent(
  projectId: string,
  knowledgeId: string,
  extension: KnowledgeExtension
): Promise<void> {
  await removeDataPath(knowledgeContentPath(projectId, knowledgeId, extension), { force: true });
}

export async function listKnowledgeContentFiles(projectId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(knowledgeDir(projectId), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^kb-[A-Za-z0-9_-]+\.(md|txt)$/.test(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
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
  await removeDataPath(refineSessionJsonPath(projectId), { force: true });
}

export async function readRefineAutomation(projectId: string): Promise<RefineAutomationStore | null> {
  return readJsonFile<RefineAutomationStore>(refineAutomationJsonPath(projectId));
}

export async function writeRefineAutomation(
  projectId: string,
  store: RefineAutomationStore
): Promise<void> {
  await safeWriteJson(refineAutomationJsonPath(projectId), store);
}

export async function deleteRefineAutomation(projectId: string): Promise<void> {
  await removeDataPath(refineAutomationJsonPath(projectId), { force: true });
}

export async function readWorld(projectId: string): Promise<WorldContent> {
  const text = await readTextFile(worldMdPath(projectId));
  return parseWorldMd(text ?? '');
}

export async function readWorldText(projectId: string): Promise<string> {
  return (await readTextFile(worldMdPath(projectId))) ?? '';
}

export async function readWorldPromptText(projectId: string): Promise<string> {
  const text = await readWorldText(projectId);
  const content = parseWorldMd(text);
  return content.foundation.trim() || content.initialSituation.trim() ? text : '';
}

export async function writeWorld(projectId: string, content: WorldContent): Promise<void> {
  const text = serializeWorldMd(content);
  if (!hasCompleteCanonicalWorldStructure(text)) {
    throw new Error('Invalid canonical world structure');
  }
  await safeWriteFile(worldMdPath(projectId), text);
}

// NOTE: refine の複数ファイル更新を巻き戻す時だけ使う。通常の保存は writeWorld を通す。
export async function restoreWorldText(projectId: string, text: string): Promise<void> {
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
  await withDataDirWrite(async () => {
    await ensureDir(generationsDir(projectId));
    const line = JSON.stringify(record) + '\n';
    await fs.appendFile(logPath, line, 'utf-8');
  });
}

export async function appendGenerationStatusLog(
  projectId: string,
  generationId: string,
  status: GenerationStatus
): Promise<void> {
  const logPath = generationLogPath(projectId);
  await withDataDirWrite(async () => {
    await ensureDir(generationsDir(projectId));
    const line =
      JSON.stringify({
        entryType: 'status',
        generationId,
        status,
        updatedAt: new Date().toISOString(),
      }) + '\n';
    await fs.appendFile(logPath, line, 'utf-8');
  });
}

export async function findGenerationRecord(
  projectId: string,
  generationId: string
): Promise<GenerationRecord | null> {
  const records = await findGenerationRecords(projectId, [generationId]);
  return records.get(generationId) ?? null;
}

// NOTE: 生成ログは追記型なので、複数 ID を一度に解決する場合も後方から 1 回だけ
// 走査する。各 ID の最新 status を先に拾い、その元レコードへ反映する。
export async function findGenerationRecords(
  projectId: string,
  generationIds: Iterable<string>
): Promise<Map<string, GenerationRecord>> {
  const targets = new Set(generationIds);
  if (targets.size === 0) return new Map();

  const text = await readTextFile(generationLogPath(projectId));
  if (!text) return new Map();

  const latestStatuses = new Map<string, GenerationStatus>();
  const records = new Map<string, GenerationRecord>();
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as Partial<GenerationRecord> & {
        entryType?: string;
        status?: GenerationStatus;
      };
      if (!entry.generationId || !targets.has(entry.generationId)) continue;
      if (entry.entryType === 'status' && isGenerationStatus(entry.status)) {
        if (!latestStatuses.has(entry.generationId)) {
          latestStatuses.set(entry.generationId, entry.status);
        }
        continue;
      }
      if (typeof entry.responseText === 'string' && !records.has(entry.generationId)) {
        const record = entry as GenerationRecord;
        const latestStatus = latestStatuses.get(entry.generationId);
        records.set(entry.generationId, latestStatus ? { ...record, status: latestStatus } : record);
        if (records.size === targets.size) break;
      }
    } catch {
      // 破損行は無視
    }
  }
  return records;
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
  await withDataDirWrite(async () => {
    await ensureDir(generationsDir(projectId));
    await safeWriteFile(generationMdPath(projectId, generationId), text);
  });
}

export async function writeGenerationPromptSnapshot(
  projectId: string,
  generationId: string,
  text: string
): Promise<void> {
  await withDataDirWrite(async () => {
    await ensureDir(generationsDir(projectId));
    await safeWriteFile(generationPromptPath(projectId, generationId), text);
  });
}

export async function readRoleplaySession(
  projectId: string,
  sessionId: string
): Promise<RoleplaySession | null> {
  return readJsonFile<RoleplaySession>(roleplaySessionJsonPath(projectId, sessionId));
}

export async function writeRoleplaySession(session: RoleplaySession): Promise<void> {
  await ensureDir(roleplaySessionsDir(session.projectId));
  await safeWriteJson(roleplaySessionJsonPath(session.projectId, session.sessionId), session);
}

export async function listRoleplaySessionIds(projectId: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(roleplaySessionsDir(projectId), { withFileTypes: true });
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

export async function roleplaySessionExists(
  projectId: string,
  sessionId: string
): Promise<boolean> {
  try {
    const stat = await fs.stat(roleplaySessionJsonPath(projectId, sessionId));
    return stat.isFile();
  } catch {
    return false;
  }
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
  await removeDataPath(projectDir(projectId), { recursive: true, force: true });
}

function isGenerationStatus(value: unknown): value is GenerationStatus {
  return value === 'draft' || value === 'accepted' || value === 'rejected' || value === 'superseded';
}

export { readTextFile };
