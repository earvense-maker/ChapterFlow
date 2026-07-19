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
  it('stores an editable base prompt and uses it in the combined preview', async () => {
    const project = await projectService.createProject({ title: 'Editable base prompt API' });
    projectIds.push(project.projectId);
    await storage.writeProject({ ...project, updatedAt: '2000-01-01T00:00:00.000Z' });
    const server = await startServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);

    const updateResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/projects/${project.projectId}/presets`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseSystemPrompt: '編集した基本プロンプト' }),
      }
    );
    expect(updateResponse.status).toBe(200);
    expect(await updateResponse.json()).toMatchObject({
      baseSystemPrompt: '編集した基本プロンプト',
    });

    const previewResponse = await fetch(
      `http://127.0.0.1:${server.port}/api/projects/${project.projectId}/system-prompt/preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presets: {} }),
      }
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      baseSystemPrompt: '編集した基本プロンプト',
    });
    expect(preview.systemPrompt).toContain('編集した基本プロンプト');
    expect((await storage.readProject(project.projectId))?.updatedAt).not.toBe(
      '2000-01-01T00:00:00.000Z'
    );
  });

  it('stores and returns normalized additional instructions', async () => {
    const project = await projectService.createProject({ title: 'Prompt normalization API' });
    projectIds.push(project.projectId);
    const generated = await buildGeneratedSystemPrompt(project.activePresetIds);
    const legacyCombinedPrompt = `${generated}\n\n---\n\n【作品固有の追加指示】\n会話文を短く保つ。`;
    const storedPresets = await storage.readPresets(project.projectId);
    if (!storedPresets) throw new Error('Presets were not created');
    await storage.writePresets(project.projectId, storedPresets);
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
    expect((await projectService.getProject(project.projectId))?.activePresetIds).toEqual(
      project.activePresetIds
    );
  });
});
