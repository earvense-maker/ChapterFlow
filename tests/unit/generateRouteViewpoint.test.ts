import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';

// NOTE: 設計書 6.4 の invalid_viewpoint_character 受け入れ条件。
// 希望本文の文字列解析で視点を昇格させる旧実装の再発を防ぐため、
// request の viewpointCharacterId だけをサーバーが検証して 400 で返すことを固定する。

const servers: RunningServer[] = [];
const projectIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    projectIds.splice(0).map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
});

describe('generate route の視点人物検証（設計書 6.4）', () => {
  it('存在しない viewpointCharacterId は生成前 400 + code + retryable:false を返す', async () => {
    const project = await projectService.createProject({ title: 'Viewpoint route test' });
    projectIds.push(project.projectId);
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
    });
    const server = await startServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText');

    const response = await fetch(`${origin}/api/projects/${project.projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wish: '続き', mode: 'continue', viewpointCharacterId: 'char-ghost' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'invalid_viewpoint_character',
      retryable: false,
    });
    // 検証はモデル呼び出しより前に行われる。
    expect(generateText).not.toHaveBeenCalled();
  });

  it('generate-stream もヘッダー送信前に 400 を返し、SSE を開始しない', async () => {
    const project = await projectService.createProject({ title: 'Viewpoint stream test' });
    projectIds.push(project.projectId);
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
    });
    const server = await startServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;

    const response = await fetch(`${origin}/api/projects/${project.projectId}/generate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wish: '続き', mode: 'continue', viewpointCharacterId: 'char-ghost' }),
    });

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({
      code: 'invalid_viewpoint_character',
      retryable: false,
    });
  });

  it('作品に存在するIDは検証を通り、生成が実行される', async () => {
    const project = await projectService.createProject({
      title: 'Viewpoint valid test',
      characters: [
        {
          characterId: 'char-viewer',
          name: 'アキ',
          role: 'protagonist',
          description: '主人公',
          speechStyle: '',
        },
      ],
    });
    projectIds.push(project.projectId);
    await projectService.updateProject(project.projectId, {
      refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
    });
    const server = await startServer({ host: '127.0.0.1', port: 0 });
    servers.push(server);
    const origin = `http://127.0.0.1:${server.port}`;
    const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: 'アキ視点の本文',
      finishReason: 'stop',
      retryable: false,
    });

    const response = await fetch(`${origin}/api/projects/${project.projectId}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wish: '続き', mode: 'continue', viewpointCharacterId: 'char-viewer' }),
    });

    expect(response.status).toBe(200);
    const record = (await response.json()) as { responseText: string };
    expect(record.responseText).toBe('アキ視点の本文');
    expect(generateText).toHaveBeenCalledTimes(1);
  });
});
