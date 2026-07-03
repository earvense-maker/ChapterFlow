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
    expect(stored?.activeModelProvider).toBe('openai');
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
});
