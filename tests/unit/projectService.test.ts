import { afterEach, describe, expect, it } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';

const createdProjectIds: string[] = [];

async function createTrackedProject() {
  const project = await projectService.createProject({ title: 'Validation Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('project settings validation', () => {
  it('rejects unsupported model providers without persisting them', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, { activeModelProvider: 'unsupported' })
    ).rejects.toThrow(projectService.ProjectValidationError);

    const stored = await projectService.getProject(project.projectId);
    expect(stored?.activeModelProvider).toBe('gemini');
  });

  it('rolls back a newly created project directory when creation validation fails', async () => {
    await expect(
      projectService.createProject({
        title: 'Invalid Start',
        activeModelProvider: 'unsupported',
      })
    ).rejects.toThrow(projectService.ProjectValidationError);

    const after = await storage.listProjectIds();
    const projects = await Promise.all(after.map((projectId) => storage.readProject(projectId)));
    expect(projects.filter(Boolean).some((project) => project?.title === 'Invalid Start')).toBe(
      false
    );
  });

  it('rejects output lengths outside the supported range', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, { outputLength: 10001 })
    ).rejects.toThrow(projectService.ProjectValidationError);
  });

  it('normalizes valid model settings before saving', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'gemini',
      activeModelName: ' gemini-1.5-flash ',
      outputLength: 2500.4,
      streamingEnabled: true,
    });

    expect(updated.activeModelProvider).toBe('gemini');
    expect(updated.activeModelName).toBe('gemini-1.5-flash');
    expect(updated.outputLength).toBe(2500);
    expect(updated.streamingEnabled).toBe(true);
  });

  it('trims titles and rejects blank title updates', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      title: '  Renamed Story  ',
    });
    expect(updated.title).toBe('Renamed Story');

    await expect(
      projectService.updateProject(project.projectId, { title: '   ' })
    ).rejects.toThrow(projectService.ProjectValidationError);
    expect((await projectService.getProject(project.projectId))?.title).toBe('Renamed Story');
  });

  it('normalizes samplingConfig penalties to 0..1', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: -0.5, presencePenalty: 1.5 },
    });

    expect(updated.samplingConfig).toEqual({
      frequencyPenalty: 0,
      presencePenalty: 1,
      temperature: 0.7,
    });
  });

  it('preserves an existing samplingConfig field when partially updating the other', async () => {
    const project = await createTrackedProject();

    await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: 0.6, presencePenalty: 0.2 },
    });
    const updated = await projectService.updateProject(project.projectId, {
      samplingConfig: { presencePenalty: 0.4 },
    });

    expect(updated.samplingConfig).toEqual({
      frequencyPenalty: 0.6,
      presencePenalty: 0.4,
      temperature: 0.7,
    });
  });

  it('copies samplingConfig when duplicating a project', async () => {
    const source = await createTrackedProject();
    await projectService.updateProject(source.projectId, {
      samplingConfig: { frequencyPenalty: 0.3, presencePenalty: 0.5 },
    });

    const duplicate = await projectService.createProject({
      duplicateFrom: source.projectId,
      title: 'Copied Settings',
    });
    createdProjectIds.push(duplicate.projectId);

    expect(duplicate.samplingConfig).toEqual({
      frequencyPenalty: 0.3,
      presencePenalty: 0.5,
      temperature: 0.7,
    });
  });

  it('rejects invalid samplingConfig values', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, {
        samplingConfig: { frequencyPenalty: NaN },
      })
    ).rejects.toThrow(projectService.ProjectValidationError);
  });

  it('accepts DeepSeek as a supported provider', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'deepseek',
      activeModelName: ' deepseek-v4-flash ',
    });

    expect(updated.activeModelProvider).toBe('deepseek');
    expect(updated.activeModelName).toBe('deepseek-v4-flash');
  });

  it('creates a project with initial detailed settings', async () => {
    const project = await projectService.createProject({
      title: 'Detailed Start',
      outputLength: 4500.4,
      streamingEnabled: true,
      activeModelProvider: 'gemini',
      activeModelName: ' gemini-1.5-flash ',
      activePresetIds: { genre: 'romance' },
      worldText: '静かな管理都市',
      characters: [
        {
          characterId: 'char-test',
          name: 'レン',
          role: 'protagonist',
          description: '都市監査員',
        },
      ],
      customSystemPrompt: '本文だけを書く',
    });
    createdProjectIds.push(project.projectId);

    const [worldText, characters, presets] = await Promise.all([
      storage.readWorld(project.projectId),
      storage.readCharacters(project.projectId),
      storage.readPresets(project.projectId),
    ]);

    expect(project.outputLength).toBe(4500);
    expect(project.streamingEnabled).toBe(true);
    expect(project.activeModelProvider).toBe('gemini');
    expect(project.activeModelName).toBe('gemini-1.5-flash');
    expect(project.activePresetIds.genre).toBe('romance');
    const state = await storage.readState(project.projectId);
    expect(state?.storyStateRefresh).toMatchObject({
      status: 'fresh',
      generationId: null,
    });
    expect(worldText).toBe('静かな管理都市');
    expect(characters).toHaveLength(1);
    expect(presets?.customSystemPrompt).toBe('本文だけを書く');
  });
});
