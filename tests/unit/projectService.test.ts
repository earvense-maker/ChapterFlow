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
    const before = new Set(await storage.listProjectIds());

    await expect(
      projectService.createProject({
        title: 'Invalid Start',
        activeModelProvider: 'unsupported',
      })
    ).rejects.toThrow(projectService.ProjectValidationError);

    const after = await storage.listProjectIds();
    const added = after.filter((projectId) => !before.has(projectId));
    await Promise.all(
      added.map(async (projectId) => {
        await expect(storage.readProject(projectId)).resolves.not.toBeNull();
      })
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
