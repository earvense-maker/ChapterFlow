import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import {
  defaultModelForProvider,
  isSupportedProvider,
} from './modelInfoService.js';
import { createEmptyStoryState } from './storyStateService.js';
import type {
  ActivePresets,
  Character,
  CreateProjectBody,
  PresetsFile,
  Project,
  ProjectState,
  ProjectSummary,
  SamplingConfig,
  UpdateProjectBody,
} from '../types/index.js';

const DEFAULT_OUTPUT_LENGTH = 3000;
const DEFAULT_MODEL_PROVIDER = 'gemini';
const DEFAULT_MODEL_NAME = defaultModelForProvider(DEFAULT_MODEL_PROVIDER);
const DEFAULT_STREAMING_ENABLED = false;
const MIN_OUTPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 10000;

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
  try {
  await storage.createProjectDir(projectId);

  let activePresetIds = { ...DEFAULT_ACTIVE_PRESETS };
  let title = body.title?.trim() || '無題の作品';
  let sourceProject: Project | null = null;
  let sourcePresets: PresetsFile | null = null;
  let sourceCharacters: Character[] = [];
  let sourceWorld = '';
  let sourceStoryState = createEmptyStoryState();

  if (body.duplicateFrom) {
    sourceProject = await storage.readProject(body.duplicateFrom);
    if (sourceProject) {
      sourcePresets = await storage.readPresets(body.duplicateFrom);
      sourceCharacters = await storage.readCharacters(body.duplicateFrom);
      sourceWorld = await storage.readWorld(body.duplicateFrom);
      sourceStoryState = (await storage.readStoryState(body.duplicateFrom)) ?? sourceStoryState;
      activePresetIds = { ...sourceProject.activePresetIds, ...(body.activePresetIds ?? {}) };
      title = body.title?.trim() || `${sourceProject.title} のコピー`;
    }
  } else if (body.activePresetIds) {
    activePresetIds = { ...DEFAULT_ACTIVE_PRESETS, ...body.activePresetIds };
  }

  const provider =
    body.activeModelProvider ?? sourceProject?.activeModelProvider ?? DEFAULT_MODEL_PROVIDER;
  const modelName =
    body.activeModelName ?? sourceProject?.activeModelName ?? defaultModelForProvider(provider);
  const normalizedSettings = validateProjectUpdates({
    outputLength: body.outputLength ?? sourceProject?.outputLength ?? DEFAULT_OUTPUT_LENGTH,
    streamingEnabled:
      body.streamingEnabled ?? sourceProject?.streamingEnabled ?? DEFAULT_STREAMING_ENABLED,
    activeModelProvider: provider,
    activeModelName: modelName,
    samplingConfig: body.samplingConfig ?? sourceProject?.samplingConfig,
  });

  const now = nowIso();
  const project: Project = {
    schemaVersion: 1,
    projectId,
    title,
    createdAt: now,
    updatedAt: now,
    activeModelProvider: normalizedSettings.activeModelProvider ?? DEFAULT_MODEL_PROVIDER,
    activeModelName: normalizedSettings.activeModelName ?? DEFAULT_MODEL_NAME,
    outputLength: normalizedSettings.outputLength ?? DEFAULT_OUTPUT_LENGTH,
    streamingEnabled: normalizedSettings.streamingEnabled ?? DEFAULT_STREAMING_ENABLED,
    activePresetIds,
    ...(normalizedSettings.samplingConfig
      ? {
          samplingConfig: {
            frequencyPenalty: normalizedSettings.samplingConfig.frequencyPenalty ?? 0,
            presencePenalty: normalizedSettings.samplingConfig.presencePenalty ?? 0,
          },
        }
      : {}),
  };

  const state: ProjectState = {
    lastOpenedAt: now,
    currentEpisodeId: null,
    currentSceneId: null,
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    storyStateRefresh: {
      status: 'fresh',
      generationId: null,
      updatedAt: now,
    },
    uiState: {
      readingPosition: 0,
      fontSize: 18,
    },
  };

  const presets: PresetsFile = {
    ...(sourcePresets ?? {}),
    genrePreset: activePresetIds.genre,
    stylePreset: activePresetIds.style,
    povPreset: activePresetIds.pov,
    pacingPreset: activePresetIds.pacing,
    densityPreset: activePresetIds.density,
    conversationPreset: activePresetIds.conversation,
    relationshipPacingPreset: activePresetIds.relationshipPacing,
    distancePreset: activePresetIds.distance,
    constraintPreset: activePresetIds.constraint,
    userCustomPromptParts: sourcePresets?.userCustomPromptParts ?? [],
    customSystemPrompt: body.customSystemPrompt ?? sourcePresets?.customSystemPrompt ?? '',
  };
  const characters = body.characters ?? sourceCharacters;
  const worldText = body.worldText ?? sourceWorld;

  await storage.writeProject(project);
  await storage.writeState(projectId, state);
  await storage.writePresets(projectId, presets);
  await storage.writeCharacters(projectId, characters);
  await storage.writeMemories(projectId, []);
  await storage.writeWorld(projectId, worldText);
  await storage.writeStoryState(projectId, { ...sourceStoryState, updatedAt: now });

  return project;
  } catch (err) {
    await storage.deleteProjectDir(projectId).catch(() => undefined);
    throw err;
  }
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

  const storyState = await storage.readStoryState(sourceId);
  if (storyState) await storage.writeStoryState(destId, storyState);
}

export async function getProject(projectId: string): Promise<Project | null> {
  return storage.readProject(projectId);
}

type ProjectUpdateInput = Omit<Partial<Project>, 'activePresetIds' | 'samplingConfig'> & {
  activePresetIds?: UpdateProjectBody['activePresetIds'];
  samplingConfig?: Partial<SamplingConfig>;
};

export async function updateProject(projectId: string, updates: ProjectUpdateInput): Promise<Project> {
  const project = await storage.readProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const normalizedUpdates = validateProjectUpdates(updates);
  const { activePresetIds, samplingConfig, ...rest } = normalizedUpdates;

  const updated: Project = {
    ...project,
    ...rest,
    activePresetIds: activePresetIds
      ? { ...project.activePresetIds, ...activePresetIds }
      : project.activePresetIds,
    samplingConfig: samplingConfig
      ? {
          frequencyPenalty:
            samplingConfig.frequencyPenalty ?? project.samplingConfig?.frequencyPenalty ?? 0,
          presencePenalty:
            samplingConfig.presencePenalty ?? project.samplingConfig?.presencePenalty ?? 0,
        }
      : project.samplingConfig,
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
      !isSupportedProvider(updates.activeModelProvider)
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

  if ('samplingConfig' in updates && updates.samplingConfig !== undefined) {
    if (typeof updates.samplingConfig !== 'object' || updates.samplingConfig === null) {
      throw new ProjectValidationError('samplingConfig must be an object');
    }
    normalized.samplingConfig = {
      frequencyPenalty: normalizePenalty(
        updates.samplingConfig.frequencyPenalty,
        'frequencyPenalty'
      ),
      presencePenalty: normalizePenalty(
        updates.samplingConfig.presencePenalty,
        'presencePenalty'
      ),
    };
  }

  return normalized;
}

function normalizePenalty(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectValidationError(`${name} must be a finite number`);
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
