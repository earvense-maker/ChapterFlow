import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';

const servers: RunningServer[] = [];
const createdProjectIds: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(createdProjectIds.splice(0).map((id) => storage.deleteProjectDir(id)));
});

async function startOrigin(): Promise<string> {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Refine Automation API Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

function jsonRequest(url: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('refine automation API', () => {
  it('GET returns the safe/when-needed default settings for a newly created project', async () => {
    // NOTE: 新規プロジェクトは safe/when-needed を既定保存する。undefined（未保存）に
    // なるのは、この機能追加前から存在する既存プロジェクトだけ（設計書 5.2）。
    const origin = await startOrigin();
    const projectId = await createTrackedProject();

    const res = await fetch(`${origin}/api/projects/${projectId}/refine/automation`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      settings: { mode: 'safe', scanPolicy: 'when-needed' },
      status: null,
    });
  });

  it('GET returns null settings for a pre-existing project that has never saved automation settings', async () => {
    // NOTE: 機能追加前から存在するプロジェクトを模する。project.json に
    // refineAutomation フィールド自体が無い状態を直接作る。
    const origin = await startOrigin();
    const projectId = await createTrackedProject();
    const project = await storage.readProject(projectId);
    if (!project) throw new Error('project missing');
    const { refineAutomation: _refineAutomation, ...withoutAutomation } = project;
    await storage.writeProject(withoutAutomation);

    const res = await fetch(`${origin}/api/projects/${projectId}/refine/automation`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ settings: null, status: null });
  });

  it('PUT saves valid settings and GET reflects them afterward', async () => {
    const origin = await startOrigin();
    const projectId = await createTrackedProject();

    const putRes = await jsonRequest(`${origin}/api/projects/${projectId}/refine/automation`, 'PUT', {
      mode: 'all',
      scanPolicy: 'always',
    });
    expect(putRes.status).toBe(200);
    await expect(putRes.json()).resolves.toEqual({ mode: 'all', scanPolicy: 'always' });

    const getRes = await fetch(`${origin}/api/projects/${projectId}/refine/automation`);
    await expect(getRes.json()).resolves.toMatchObject({
      settings: { mode: 'all', scanPolicy: 'always' },
    });
  });

  it('PUT rejects an invalid mode with a 400', async () => {
    const origin = await startOrigin();
    const projectId = await createTrackedProject();

    const res = await jsonRequest(`${origin}/api/projects/${projectId}/refine/automation`, 'PUT', {
      mode: 'not-a-real-mode',
      scanPolicy: 'when-needed',
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'invalid_refine_automation_settings' });
  });

  it('GET runs returns an empty array for a project with no automation history', async () => {
    const origin = await startOrigin();
    const projectId = await createTrackedProject();

    const res = await fetch(`${origin}/api/projects/${projectId}/refine/automation/runs`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it('retry returns 404 when there is no failed run to retry', async () => {
    const origin = await startOrigin();
    const projectId = await createTrackedProject();
    await jsonRequest(`${origin}/api/projects/${projectId}/refine/automation`, 'PUT', {
      mode: 'safe',
      scanPolicy: 'when-needed',
    });

    const res = await jsonRequest(`${origin}/api/projects/${projectId}/refine/automation/retry`, 'POST');
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'no_failed_automation_run' });
  });

  it('revert returns 404 when the target run does not exist', async () => {
    const origin = await startOrigin();
    const projectId = await createTrackedProject();

    const res = await jsonRequest(
      `${origin}/api/projects/${projectId}/refine/automation/runs/nonexistent-run/revert`,
      'POST'
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'automation_run_not_found' });
  });

  it('GET returns 404 for a project that does not exist', async () => {
    const origin = await startOrigin();
    const res = await fetch(`${origin}/api/projects/does-not-exist/refine/automation`);
    expect(res.status).toBe(404);
  });
});
