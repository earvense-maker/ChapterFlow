import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as knowledgeService from './knowledgeService.js';
import {
  defaultModelForProvider,
  isSupportedProvider,
} from './modelInfoService.js';
import { createEmptyStoryState } from './storyStateService.js';
import { writeShortcut } from './shortcutService.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import { normalizeActivePresetIds } from '../../shared/presetMigration.js';
import {
  isValidCharacterInput,
  normalizeCharacterForStorage,
  normalizeCharactersForStorage,
} from '../../shared/characterSchema.js';
export { normalizeCharacterForStorage, normalizeCharactersForStorage };
import {
  DEFAULT_ACTIVE_PRESET_IDS,
  DEFAULT_PROJECT_TYPE,
  DEFAULT_ROLEPLAY_OUTPUT_CHARS,
  NEW_PROJECT_REFINE_AUTOMATION_SETTINGS,
  ROLEPLAY_LIMITS,
  SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS,
  normalizeProjectType,
  normalizeRefineAutomationSettings,
} from '../types/index.js';
import type {
  ActivePresets,
  Character,
  CreateProjectBody,
  PresetsFile,
  Project,
  ProjectState,
  ProjectSummary,
  ProjectType,
  RefineAutomationSettings,
  SamplingConfig,
  UpdateProjectBody,
  WorldContent,
} from '../types/index.js';

const DEFAULT_OUTPUT_LENGTH = 6000;
const DEFAULT_FREQUENCY_PENALTY = 0.1;
const DEFAULT_PRESENCE_PENALTY = 0;
const DEFAULT_TEMPERATURE = 0.9;
const DEFAULT_MODEL_PROVIDER = 'gemini';
const DEFAULT_MODEL_NAME = defaultModelForProvider(DEFAULT_MODEL_PROVIDER);
const DEFAULT_STREAMING_ENABLED = false;
const MIN_OUTPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 10000;
const ACTIVE_PRESET_KEYS = new Set<keyof ActivePresets>([
  'narration',
  'aftertaste',
  'emotionDisplay',
  'sceneProgression',
  'chapterEnding',
  'painLevel',
  'intimacy',
]);

function normalizeScenarioSeeds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    result.push(text.slice(0, ROLEPLAY_LIMITS.scenarioSeedChars));
    if (result.length >= ROLEPLAY_LIMITS.scenarioSeedsCount) break;
  }
  return result;
}

// NOTE: プロジェクト側の roleplay 用フィールド（projectType / scenarioSeeds /
// roleplayOutputChars）を、保存前に一括で正規化する。projectType はモデル出力を
// 信用せず、呼び出し側の intent（roleplay ならその値）を優先させる。
export function normalizeRoleplayProjectFields(input: {
  projectType?: unknown;
  scenarioSeeds?: unknown;
  roleplayOutputChars?: unknown;
}): { projectType: ProjectType; scenarioSeeds: string[]; roleplayOutputChars: number } {
  return {
    projectType: normalizeProjectType(input.projectType),
    scenarioSeeds: normalizeScenarioSeeds(input.scenarioSeeds),
    roleplayOutputChars: normalizeRoleplayOutputChars(input.roleplayOutputChars),
  };
}

// NOTE: 100〜500 の範囲に丸め、未指定なら DEFAULT_ROLEPLAY_OUTPUT_CHARS を返す。
export function normalizeRoleplayOutputChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_ROLEPLAY_OUTPUT_CHARS;
  }
  const rounded = Math.round(value);
  return Math.max(
    ROLEPLAY_LIMITS.outputCharsMin,
    Math.min(ROLEPLAY_LIMITS.outputCharsMax, rounded)
  );
}

export async function createProject(body: CreateProjectBody): Promise<Project> {
  if (
    body.characters !== undefined &&
    (!Array.isArray(body.characters) || !body.characters.every(isValidCharacterInput))
  ) {
    throw new ProjectValidationError('characters must be a valid character array');
  }
  if (
    body.world !== undefined &&
    (typeof body.world !== 'object' ||
      body.world === null ||
      Array.isArray(body.world) ||
      typeof body.world.foundation !== 'string' ||
      typeof body.world.initialSituation !== 'string')
  ) {
    throw new ProjectValidationError('world must contain foundation and initialSituation strings');
  }
  const validatedInput = validateProjectUpdates({
    title:
      typeof body.title === 'string' && !body.title.trim()
        ? undefined
        : body.title,
    outputLength: body.outputLength,
    streamingEnabled: body.streamingEnabled,
    activeModelProvider: body.activeModelProvider,
    activeModelName: body.activeModelName,
    activePresetIds: body.activePresetIds,
    samplingConfig: body.samplingConfig,
    coreConcept: body.coreConcept,
    firstWishSuggestion: body.firstWishSuggestion,
    styleSample: body.styleSample,
  });
  const customSystemPromptInput = normalizeInitialSystemPrompt(body.customSystemPrompt);
  if (
    body.duplicateFrom !== undefined &&
    (typeof body.duplicateFrom !== 'string' || !/^[A-Za-z0-9_-]+$/.test(body.duplicateFrom))
  ) {
    throw new ProjectValidationError('duplicateFrom must be a valid project ID');
  }
  if (
    body.projectType !== undefined &&
    body.projectType !== 'novel' &&
    body.projectType !== 'roleplay'
  ) {
    throw new ProjectValidationError("projectType must be 'novel' or 'roleplay'");
  }
  const projectId = generateTimestampId('proj');
  try {
  await storage.createProjectDir(projectId);

  const initialPresetIds = DEFAULT_ACTIVE_PRESET_IDS;
  let activePresetIds: ActivePresets = { ...initialPresetIds };
  let title = validatedInput.title || '無題の作品';
  let sourceProject: Project | null = null;
  let sourcePresets: PresetsFile | null = null;
  let sourceCharacters: Character[] = [];
  let sourceWorld: WorldContent = { foundation: '', initialSituation: '' };
  let sourceStoryState = createEmptyStoryState();

  if (body.duplicateFrom) {
    sourceProject = await storage.readProject(body.duplicateFrom);
    if (sourceProject) {
      sourcePresets = await storage.readPresets(body.duplicateFrom);
      sourceCharacters = await storage.readCharacters(body.duplicateFrom);
      sourceWorld = await storage.readWorld(body.duplicateFrom);
      sourceStoryState = (await storage.readStoryState(body.duplicateFrom)) ?? sourceStoryState;
      activePresetIds = normalizeActivePresetIds({
        ...normalizeActivePresetIds(sourceProject.activePresetIds),
        ...(validatedInput.activePresetIds ?? {}),
      });
      title = validatedInput.title || `${sourceProject.title} のコピー`;
    }
  } else if (validatedInput.activePresetIds) {
    activePresetIds = normalizeActivePresetIds({
      ...initialPresetIds,
      ...validatedInput.activePresetIds,
    });
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

  const roleplayFields = normalizeRoleplayProjectFields({
    projectType: body.projectType ?? sourceProject?.projectType,
    scenarioSeeds: body.scenarioSeeds ?? sourceProject?.scenarioSeeds,
    roleplayOutputChars: body.roleplayOutputChars ?? sourceProject?.roleplayOutputChars,
  });
  const { baseSystemPrompt, customSystemPrompt } = await resolveSystemPrompt(
    activePresetIds,
    customSystemPromptInput ?? sourcePresets?.customSystemPrompt ?? '',
    sourcePresets?.baseSystemPrompt
  );

  const now = nowIso();
  const project: Project = {
    schemaVersion: 1,
    projectId,
    title,
    coreConcept: normalizeOptionalText(body.coreConcept ?? sourceProject?.coreConcept, 300),
    firstWishSuggestion: normalizeOptionalText(
      body.firstWishSuggestion ?? sourceProject?.firstWishSuggestion,
      300
    ),
    styleSample: normalizeOptionalText(body.styleSample ?? sourceProject?.styleSample, 1000),
    createdAt: now,
    updatedAt: now,
    activeModelProvider: normalizedSettings.activeModelProvider ?? DEFAULT_MODEL_PROVIDER,
    activeModelName: normalizedSettings.activeModelName ?? DEFAULT_MODEL_NAME,
    outputLength: normalizedSettings.outputLength ?? DEFAULT_OUTPUT_LENGTH,
    streamingEnabled: normalizedSettings.streamingEnabled ?? DEFAULT_STREAMING_ENABLED,
    activePresetIds,
    samplingConfig: {
      frequencyPenalty:
        normalizedSettings.samplingConfig?.frequencyPenalty ?? DEFAULT_FREQUENCY_PENALTY,
      presencePenalty:
        normalizedSettings.samplingConfig?.presencePenalty ?? DEFAULT_PRESENCE_PENALTY,
      temperature: normalizedSettings.samplingConfig?.temperature ?? DEFAULT_TEMPERATURE,
    },
    projectType: roleplayFields.projectType,
    scenarioSeeds: roleplayFields.scenarioSeeds,
    roleplayOutputChars: roleplayFields.roleplayOutputChars,
    // NOTE: 複製時は複製元の自動レビュー設定を引き継がず、既存作品同様「未保存」
    // （実効的に off）として扱う。新規作成時だけ safe/when-needed を既定保存する
    // （設計書 5.2 の移行方針）。
    refineAutomation: body.duplicateFrom ? undefined : NEW_PROJECT_REFINE_AUTOMATION_SETTINGS,
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
    userCustomPromptParts: sourcePresets?.userCustomPromptParts ?? [],
    baseSystemPrompt,
    customSystemPrompt,
  };
  const characters = normalizeCharactersForStorage(body.characters ?? sourceCharacters);
  const world = body.world ?? sourceWorld;

  await storage.writeProject(project);
  await storage.writeState(projectId, state);
  await storage.writePresets(projectId, presets);
  await storage.writeCharacters(projectId, characters);
  await storage.writeMemories(projectId, []);
  await storage.writeWorld(projectId, world);
  await storage.writeStoryState(projectId, { ...sourceStoryState, updatedAt: now });
  if (body.duplicateFrom && sourceProject) {
    // NOTE: 複製元の knowledge はコピーするが、roleplay/sessions は複製元だけに残す
    // （設計書 2.4）。ここでは何もしない。将来 sessions のコピーが必要になったら
    // 明示的なオプトインで扱う。
    await knowledgeService.copyKnowledgeFromProject(body.duplicateFrom, projectId);
  }

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
  const project = await storage.readProject(projectId);
  if (!project) return null;
  // NOTE: API 境界で projectType を必ず正規化して返す。UI 側の遷移振り分けが
  // undefined を扱わなくて済む。refineAutomation は未保存(undefined)と壊れた値を
  // 区別する必要があるため、normalizeRefineAutomationSettings で undefined はそのまま
  // 通す（実効既定は effectiveRefineAutomationMode 側で 'off' に解釈する）。
  return {
    ...project,
    activePresetIds: normalizeActivePresetIds(project.activePresetIds),
    projectType: normalizeProjectType(project.projectType),
    refineAutomation: normalizeRefineAutomationSettings(project.refineAutomation),
  };
}

type ProjectUpdateInput = Omit<Partial<Project>, 'activePresetIds' | 'samplingConfig'> & {
  activePresetIds?: UpdateProjectBody['activePresetIds'];
  samplingConfig?: Partial<SamplingConfig>;
};

export async function updateProject(projectId: string, updates: ProjectUpdateInput): Promise<Project> {
  const storedProject = await storage.readProject(projectId);
  if (!storedProject) throw new Error(`Project not found: ${projectId}`);
  const project = {
    ...storedProject,
    activePresetIds: normalizeActivePresetIds(storedProject.activePresetIds),
  };

  const normalizedUpdates = validateProjectUpdates(updates);
  const { activePresetIds, samplingConfig, ...rest } = normalizedUpdates;

  // NOTE: projectType の後変更は禁止（設計書 2.1）。updates に含まれていても
  // 既存の値で上書きする。scenarioSeeds は編集可能で、validateProjectUpdates で
  // 上限が適用されている。
  if ('projectType' in rest) delete (rest as Record<string, unknown>).projectType;

  const updated: Project = {
    ...project,
    ...rest,
    activePresetIds: activePresetIds
      ? normalizeActivePresetIds({ ...project.activePresetIds, ...activePresetIds })
      : project.activePresetIds,
    samplingConfig: samplingConfig
      ? {
          frequencyPenalty:
            samplingConfig.frequencyPenalty ?? project.samplingConfig?.frequencyPenalty ?? 0,
          presencePenalty:
            samplingConfig.presencePenalty ?? project.samplingConfig?.presencePenalty ?? 0,
          ...(samplingConfig.temperature !== undefined ||
          project.samplingConfig?.temperature !== undefined
            ? {
                temperature:
                  samplingConfig.temperature ?? project.samplingConfig?.temperature,
              }
            : {}),
        }
      : project.samplingConfig,
    projectId,
    projectType: normalizeProjectType(project.projectType),
    updatedAt: nowIso(),
  };

  await storage.writeProject(updated);
  if (typeof rest.title === 'string' && rest.title !== project.title) {
    await writeProjectShortcut(updated).catch((err) => {
      console.warn('Project shortcut update failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return updated;
}

async function writeProjectShortcut(project: Project): Promise<void> {
  await writeShortcut(project.projectId, project.title);
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function validateProjectUpdates(updates: ProjectUpdateInput): ProjectUpdateInput {
  // NOTE: API の型は実行時には消えるため、既知の編集可能フィールドだけを拾う。
  // createdAt や未知キーを spread すると、任意の永続フィールドを上書きできてしまう。
  const normalized: ProjectUpdateInput = {};

  if ('title' in updates && updates.title !== undefined) {
    if (
      typeof updates.title !== 'string' ||
      !updates.title.trim() ||
      updates.title.trim().length > 100
    ) {
      throw new ProjectValidationError('title must be a non-empty string of at most 100 characters');
    }
    normalized.title = updates.title.trim();
  }

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
    normalized.streamingEnabled = updates.streamingEnabled;
  }

  if ('activeModelProvider' in updates && updates.activeModelProvider !== undefined) {
    if (
      typeof updates.activeModelProvider !== 'string' ||
      !isSupportedProvider(updates.activeModelProvider)
    ) {
      throw new ProjectValidationError('activeModelProvider is not supported');
    }
    normalized.activeModelProvider = updates.activeModelProvider;
  }

  if ('activeModelName' in updates && updates.activeModelName !== undefined) {
    if (
      typeof updates.activeModelName !== 'string' ||
      !updates.activeModelName.trim() ||
      updates.activeModelName.trim().length > 200
    ) {
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

    const activePresetIds: Partial<ActivePresets> = {};
    for (const [key, value] of Object.entries(updates.activePresetIds)) {
      if (!ACTIVE_PRESET_KEYS.has(key as keyof ActivePresets)) continue;
      if (key === 'aftertaste') {
        if (
          value !== undefined &&
          (!Array.isArray(value) ||
            value.length > 2 ||
            value.some((item) => typeof item !== 'string' || item.length > 200))
        ) {
          throw new ProjectValidationError(
            'activePresetIds.aftertaste must be an array of at most 2 strings'
          );
        }
        activePresetIds.aftertaste = value as string[] | undefined;
        continue;
      }
      if (value !== undefined && typeof value !== 'string') {
        throw new ProjectValidationError(`activePresetIds.${key} must be a string`);
      }
      if (typeof value === 'string' && value.length > 200) {
        throw new ProjectValidationError(`activePresetIds.${key} is too long`);
      }
      (activePresetIds as Record<string, unknown>)[key] = value;
    }
    normalized.activePresetIds = activePresetIds;
  }

  if ('samplingConfig' in updates && updates.samplingConfig !== undefined) {
    if (
      typeof updates.samplingConfig !== 'object' ||
      updates.samplingConfig === null ||
      Array.isArray(updates.samplingConfig)
    ) {
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
      temperature: normalizeTemperature(updates.samplingConfig.temperature),
    };
  }

  if ('coreConcept' in updates) {
    normalized.coreConcept = normalizeOptionalText(updates.coreConcept, 300);
  }
  if ('firstWishSuggestion' in updates) {
    normalized.firstWishSuggestion = normalizeOptionalText(updates.firstWishSuggestion, 300);
  }
  if ('styleSample' in updates) {
    normalized.styleSample = normalizeOptionalText(updates.styleSample, 1000);
  }

  if ('scenarioSeeds' in updates) {
    if (updates.scenarioSeeds !== undefined && !Array.isArray(updates.scenarioSeeds)) {
      throw new ProjectValidationError('scenarioSeeds must be an array of strings');
    }
    normalized.scenarioSeeds = normalizeScenarioSeeds(updates.scenarioSeeds);
  }

  if ('roleplayOutputChars' in updates) {
    if (
      updates.roleplayOutputChars !== undefined &&
      (typeof updates.roleplayOutputChars !== 'number' ||
        !Number.isFinite(updates.roleplayOutputChars))
    ) {
      throw new ProjectValidationError('roleplayOutputChars must be a finite number');
    }
    normalized.roleplayOutputChars = normalizeRoleplayOutputChars(updates.roleplayOutputChars);
  }

  if ('refineAutomation' in updates && updates.refineAutomation !== undefined) {
    normalized.refineAutomation = validateRefineAutomationSettings(updates.refineAutomation);
  }

  return normalized;
}

function validateRefineAutomationSettings(value: unknown): RefineAutomationSettings {
  if (typeof value !== 'object' || value === null) {
    throw new ProjectValidationError('refineAutomation must be an object');
  }
  const raw = value as { mode?: unknown; scanPolicy?: unknown };
  if (raw.mode !== 'off' && raw.mode !== 'suggest' && raw.mode !== 'safe' && raw.mode !== 'all') {
    throw new ProjectValidationError("refineAutomation.mode must be 'off' | 'suggest' | 'safe' | 'all'");
  }
  if (raw.scanPolicy !== 'when-needed' && raw.scanPolicy !== 'always') {
    throw new ProjectValidationError("refineAutomation.scanPolicy must be 'when-needed' | 'always'");
  }
  return { mode: raw.mode, scanPolicy: raw.scanPolicy };
}

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProjectValidationError('text fields must be strings');
  }
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeInitialSystemPrompt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ProjectValidationError('customSystemPrompt must be a string');
  }
  if (value.length > SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS) {
    throw new ProjectValidationError(
      `customSystemPrompt must be at most ${SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS} characters`
    );
  }
  return value;
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

// NOTE: DeepSeek / OpenAI は 2.0 まで、Gemini は 1.0 まで受けるが、実用上 1.3 を
// 超えると日本語が崩れやすいので 0〜1.3 に丸める。
function normalizeTemperature(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectValidationError('temperature must be a finite number');
  }
  if (value < 0) return 0;
  if (value > 1.3) return 1.3;
  return value;
}

export async function deleteProject(projectId: string): Promise<void> {
  await storage.deleteProjectDir(projectId);
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const ids = await storage.listProjectIds();
  const summaries: ProjectSummary[] = [];

  for (const id of ids) {
    try {
      const project = await storage.readProject(id);
      const state = await storage.readState(id);
      if (!project || !state) continue;

      summaries.push({
        projectId: id,
        title: project.title,
        updatedAt: project.updatedAt,
        lastOpenedAt: state.lastOpenedAt,
        activePresetIds: normalizeActivePresetIds(project.activePresetIds),
        lastExcerpt: await buildLastExcerpt(id, state.currentEpisodeId),
        projectType: normalizeProjectType(project.projectType),
      });
    } catch (err) {
      // NOTE: 1作品のJSON破損で一覧全体が開けなくなると、正常な作品まで利用不能になる。
      // 壊れた作品だけを除外し、ログには復旧用のIDと原因を残す。
      console.warn('Skipping unreadable project while building project list', {
        projectId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const current = normalizeActivePresetIds(project.activePresetIds);
  await updateProject(projectId, { activePresetIds: { ...current, ...updates } });
}

export function getDefaultActivePresets(): ActivePresets {
  return { ...DEFAULT_ACTIVE_PRESET_IDS };
}
