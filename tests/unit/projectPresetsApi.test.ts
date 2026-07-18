import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';
import { buildGeneratedSystemPrompt } from '../../src/server/prompts/systemPrompt';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';

const servers: RunningServer[] = [];
const projectIds: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(projectIds.splice(0).map((projectId) => storage.deleteProjectDir(projectId)));
});

describe('project presets API', () => {
  it('stores and returns normalized additional instructions', async () => {
    const project = await projectService.createProject({ title: 'Prompt normalization API' });
    projectIds.push(project.projectId);
    const generated = await buildGeneratedSystemPrompt(project.activePresetIds);
    const legacyCombinedPrompt = `${generated}\n\n---\n\n【作品固有の追加指示】\n会話文を短く保つ。`;
    const storedPresets = await storage.readPresets(project.projectId);
    if (!storedPresets) throw new Error('Presets were not created');
    const legacyPresets = { ...storedPresets };
    delete legacyPresets.intimacyPreset;
    await storage.writePresets(project.projectId, legacyPresets);
    const server = await startServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/projects/${project.projectId}/presets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customSystemPrompt: legacyCombinedPrompt }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      customSystemPrompt: '会話文を短く保つ。',
    });
    expect((await storage.readPresets(project.projectId))?.customSystemPrompt).toBe(
      '会話文を短く保つ。'
    );
    expect((await projectService.getProject(project.projectId))?.activePresetIds.intimacy).toBe(
      project.activePresetIds.intimacy
    );
  });
});
