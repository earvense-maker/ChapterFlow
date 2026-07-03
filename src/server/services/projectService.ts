import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type {
  ActivePresets,
  Character,
  CreateProjectBody,
  PresetsFile,
  Project,
  ProjectState,
  ProjectSummary,
  UpdateProjectBody,
} from '../types/index.js';

const DEFAULT_OUTPUT_LENGTH = 3000;
const DEFAULT_MODEL_PROVIDER = 'openai';
const DEFAULT_MODEL_NAME = 'gpt-4o-mini';
const DEFAULT_STREAMING_ENABLED = false;
const MIN_OUTPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 10000;
const SUPPORTED_MODEL_PROVIDERS = new Set(['openai', 'gemini']);

const DEFAULT_ACTIVE_PRESETS: ActivePresets = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  relationshipPacing: 'standard',
};

export async function createProject(body: CreateProjectBody): Promise<Project> {
  const projectId = generateTimestampId('proj');
  await storage.createProjectDir(projectId);

  let activePresetIds = { ...DEFAULT_ACTIVE_PRESETS };
  let title = body.title?.trim() || '無題の作品';

  if (body.duplicateFrom) {
    const source = await storage.readProject(body.duplicateFrom);
    if (source) {
      activePresetIds = { ...source.activePresetIds, ...(body.activePresetIds ?? {}) };
      title = body.title?.trim() || `${source.title} のコピー`;
      await copySettings(body.duplicateFrom, projectId);
    }
  } else if (body.activePresetIds) {
    activePresetIds = { ...DEFAULT_ACTIVE_PRESETS, ...body.activePresetIds };
  }

  const now = nowIso();
  const project: Project = {
    schemaVersion: 1,
    projectId,
    title,
    createdAt: now,
    updatedAt: now,
    activeModelProvider: DEFAULT_MODEL_PROVIDER,
    activeModelName: DEFAULT_MODEL_NAME,
    outputLength: DEFAULT_OUTPUT_LENGTH,
    streamingEnabled: DEFAULT_STREAMING_ENABLED,
    activePresetIds,
  };

  const state: ProjectState = {
    lastOpenedAt: now,
    currentEpisodeId: null,
    currentSceneId: null,
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    uiState: {
      readingPosition: 0,
      fontSize: 18,
    },
  };

  const presets: PresetsFile = {
    genrePreset: activePresetIds.genre,
    stylePreset: activePresetIds.style,
    povPreset: activePresetIds.pov,
    pacingPreset: activePresetIds.pacing,
    densityPreset: activePresetIds.density,
    conversationPreset: activePresetIds.conversation,
    relationshipPacingPreset: activePresetIds.relationshipPacing,
    distancePreset: activePresetIds.distance,
    constraintPreset: activePresetIds.constraint,
    userCustomPromptParts: [],
    customSystemPrompt: '',
  };

  await storage.writeProject(project);
  await storage.writeState(projectId, state);
  await storage.writePresets(projectId, presets);
  await storage.writeCharacters(projectId, []);
  await storage.writeMemories(projectId, []);
  await storage.writeWorld(projectId, '');

  return project;
}

async function copySettings(sourceId: string, destId: string): Promise<void> {
  const presets = await storage.readPresets(sourceId);
  if (presets) await storage.writePresets(destId, presets);

  const characters = await storage.readCharacters(sourceId);
  await storage.writeCharacters(destId, characters);

  const memories = await storage.readMemories(sourceId);
  await storage.writeMemories(destId, memories);

  const world = await storage.readWorld(sourceId);
  await storage.writeWorld(destId, world);
}

export async function getProject(projectId: string): Promise<Project | null> {
  return storage.readProject(projectId);
}

type ProjectUpdateInput = Omit<Partial<Project>, 'activePresetIds'> & {
  activePresetIds?: UpdateProjectBody['activePresetIds'];
};

export async function updateProject(projectId: string, updates: ProjectUpdateInput): Promise<Project> {
  const project = await storage.readProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const normalizedUpdates = validateProjectUpdates(updates);
  const { activePresetIds, ...rest } = normalizedUpdates;

  const updated: Project = {
    ...project,
    ...rest,
    activePresetIds: activePresetIds
      ? { ...project.activePresetIds, ...activePresetIds }
      : project.activePresetIds,
    projectId,
    updatedAt: nowIso(),
  };

  await storage.writeProject(updated);
  return updated;
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function validateProjectUpdates(updates: ProjectUpdateInput): ProjectUpdateInput {
  const normalized: ProjectUpdateInput = { ...updates };

  if ('outputLength' in updates && updates.outputLength !== undefined) {
    if (
      typeof updates.outputLength !== 'number' ||
      !Number.isFinite(updates.outputLength) ||
      updates.outputLength < MIN_OUTPUT_LENGTH ||
      updates.outputLength > MAX_OUTPUT_LENGTH
    ) {
      throw new ProjectValidationError(
        `outputLength must be a finite number between ${MIN_OUTPUT_LENGTH} and ${MAX_OUTPUT_LENGTH}`
      );
    }
    normalized.outputLength = Math.round(updates.outputLength);
  }

  if ('streamingEnabled' in updates && updates.streamingEnabled !== undefined) {
    if (typeof updates.streamingEnabled !== 'boolean') {
      throw new ProjectValidationError('streamingEnabled must be a boolean');
    }
  }

  if ('activeModelProvider' in updates && updates.activeModelProvider !== undefined) {
    if (
      typeof updates.activeModelProvider !== 'string' ||
      !SUPPORTED_MODEL_PROVIDERS.has(updates.activeModelProvider)
    ) {
      throw new ProjectValidationError('activeModelProvider is not supported');
    }
  }

  if ('activeModelName' in updates && updates.activeModelName !== undefined) {
    if (typeof updates.activeModelName !== 'string' || !updates.activeModelName.trim()) {
      throw new ProjectValidationError('activeModelName must be a non-empty string');
    }
    normalized.activeModelName = updates.activeModelName.trim();
  }

  if ('activePresetIds' in updates && updates.activePresetIds !== undefined) {
    if (
      typeof updates.activePresetIds !== 'object' ||
      updates.activePresetIds === null ||
      Array.isArray(updates.activePresetIds)
    ) {
      throw new ProjectValidationError('activePresetIds must be an object');
    }

    for (const [key, value] of Object.entries(updates.activePresetIds)) {
      if (value !== undefined && typeof value !== 'string') {
        throw new ProjectValidationError(`activePresetIds.${key} must be a string`);
      }
    }
  }

  return normalized;
}

export async function deleteProject(projectId: string): Promise<void> {
  await storage.deleteProjectDir(projectId);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const ids = await storage.listProjectIds();
  const summaries: ProjectSummary[] = [];

  for (const id of ids) {
    const project = await storage.readProject(id);
    const state = await storage.readState(id);
    if (!project || !state) continue;

    summaries.push({
      projectId: id,
      title: project.title,
      updatedAt: project.updatedAt,
      lastOpenedAt: state.lastOpenedAt,
      activePresetIds: project.activePresetIds,
      lastExcerpt: await buildLastExcerpt(id, state.currentEpisodeId),
    });
  }

  return summaries.sort((a, b) => new Date(b.lastOpenedAt).getTime() - new Date(a.lastOpenedAt).getTime());
}

async function buildLastExcerpt(projectId: string, episodeId: string | null): Promise<string> {
  if (!episodeId) return '';
  const text = await storage.readEpisodeText(projectId, episodeId);
  return text.slice(-120).replace(/\s+/g, ' ');
}

export async function touchProject(projectId: string): Promise<void> {
  const state = await storage.readState(projectId);
  if (!state) return;
  await storage.writeState(projectId, { ...state, lastOpenedAt: nowIso() });
}

export async function updateActivePresets(projectId: string, updates: Partial<ActivePresets>): Promise<void> {
  const project = await storage.readProject(projectId);
  const presets = await storage.readPresets(projectId);
  if (!project || !presets) throw new Error(`Project not found: ${projectId}`);

  const next: ActivePresets = { ...project.activePresetIds, ...updates };

  await updateProject(projectId, { activePresetIds: next });
  await storage.writePresets(projectId, {
    ...presets,
    genrePreset: next.genre,
    stylePreset: next.style,
    povPreset: next.pov,
    pacingPreset: next.pacing,
    densityPreset: next.density,
    conversationPreset: next.conversation,
    relationshipPacingPreset: next.relationshipPacing,
    distancePreset: next.distance,
    constraintPreset: next.constraint,
  });
}

export function getDefaultActivePresets(): ActivePresets {
  return { ...DEFAULT_ACTIVE_PRESETS };
}
