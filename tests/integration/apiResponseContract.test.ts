import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';

/**
 * 公開Web版へ流用するAPIレスポンス型の契約テスト（設計書 Phase 0）。
 *
 * NOTE: 値そのものではなく「Web版が再実装しても保たなければならない形」を固定する。
 * 設計書 4.2 の「既存APIのURLとレスポンス型は可能な限り維持する」を、Phase 2 の
 * WebStorage 移行で壊した時に気づけるようにするのが目的。
 * ここが落ちたら、実装ではなくクライアント側の互換性を先に確認すること。
 */
let server: Server;
let baseUrl = '';
let projectId = '';

beforeAll(async () => {
  const app = createApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーを起動できませんでした');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '契約テスト用の作品' }),
  });
  projectId = ((await created.json()) as { projectId: string }).projectId;
});

afterAll(async () => {
  if (projectId) {
    await fetch(`${baseUrl}/api/projects/${projectId}`, { method: 'DELETE' });
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function getJson(route: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${route}`);
  expect(response.status, `${route} が 200 を返さなかった`).toBe(200);
  return response.json();
}

function expectTypes(value: unknown, types: Record<string, string>): void {
  expect(value).toBeTypeOf('object');
  const record = value as Record<string, unknown>;
  for (const [key, expectedType] of Object.entries(types)) {
    const actual = Array.isArray(record[key]) ? 'array' : typeof record[key];
    expect(actual, `${key} の型が契約と違う`).toBe(expectedType);
  }
}

describe('システムAPIの契約', () => {
  // NOTE: 公開Web版は同じ形で runtime だけ 'web' を返す（設計書 10.2）。
  it('GET /api/system/version', async () => {
    const body = await getJson('/api/system/version');
    expectTypes(body, { version: 'string', runtime: 'string' });
    expect(['electron', 'server']).toContain((body as { runtime: string }).runtime);
  });
});

describe('作品APIの契約', () => {
  it('GET /api/projects は一覧の要約を返す', async () => {
    const body = await getJson('/api/projects');
    expect(Array.isArray(body)).toBe(true);
    const summary = (body as unknown[]).find(
      (item) => (item as { projectId?: string }).projectId === projectId
    );
    expectTypes(summary, {
      projectId: 'string',
      title: 'string',
      updatedAt: 'string',
      lastOpenedAt: 'string',
      activePresetIds: 'object',
      lastExcerpt: 'string',
      projectType: 'string',
    });
  });

  it('GET /api/projects/:id は作品を返す', async () => {
    const body = await getJson(`/api/projects/${projectId}`);
    expectTypes(body, {
      schemaVersion: 'number',
      projectId: 'string',
      title: 'string',
      createdAt: 'string',
      updatedAt: 'string',
      activeModelProvider: 'string',
      activeModelName: 'string',
      outputLength: 'number',
      streamingEnabled: 'boolean',
      activePresetIds: 'object',
      samplingConfig: 'object',
      projectType: 'string',
      scenarioSeeds: 'array',
    });
  });

  it('GET /api/projects/:id/state は作品状態を返す', async () => {
    const body = await getJson(`/api/projects/${projectId}/state`);
    expectTypes(body, {
      lastOpenedAt: 'string',
      pendingMemoryCandidateIds: 'array',
      storyStateRefresh: 'object',
      uiState: 'object',
    });
    expectTypes((body as { uiState: unknown }).uiState, {
      readingPosition: 'number',
      fontSize: 'number',
    });
  });

  it('GET /api/projects/:id/characters と /world', async () => {
    expect(Array.isArray(await getJson(`/api/projects/${projectId}/characters`))).toBe(true);
    expectTypes(await getJson(`/api/projects/${projectId}/world`), {
      foundation: 'string',
      initialSituation: 'string',
    });
  });

  it('GET /api/projects/:id/memories は配列を返す', async () => {
    expect(Array.isArray(await getJson(`/api/projects/${projectId}/memories`))).toBe(true);
  });

  // NOTE: 公開版では「他人の作品」も同じ 404 に揃える（設計書 6.1）。存在しないIDと
  // 所有権のないIDが区別できると、作品IDの存在有無が漏れる。
  it('存在しない作品は 404 を返す', async () => {
    const response = await fetch(`${baseUrl}/api/projects/proj-does-not-exist`);
    expect(response.status).toBe(404);
  });
});

describe('エラー応答の契約', () => {
  it('不正な作品更新は 400 とメッセージを返す', async () => {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '' }),
    });
    expect(response.status).toBe(400);
    expectTypes(await response.json(), { error: 'string' });
  });

  it('壊れたJSONは code 付きで拒否される', async () => {
    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ broken',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_json' });
  });
});
