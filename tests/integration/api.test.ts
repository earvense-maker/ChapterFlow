import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { adapterMap } from '../../src/server/adapters/index';
import { withDataDirLock } from '../../src/server/services/dataDirLock';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  // 生成・採用のHTTP統合テストでは、実際のプロバイダーやAPIキーに依存しない。
  vi.spyOn(adapterMap.gemini, 'generateText').mockImplementation(async (request) => ({
    // 採用後の物語状態更新はJSONを要求するため、通常生成とは別の正しい応答を返す。
    text: request.responseMimeType === 'application/json' ? '{}' : '統合テスト用の生成本文',
    finishReason: 'stop',
    retryable: false,
  }));
  const app = createApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーを起動できませんでした');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  vi.restoreAllMocks();
});

describe('projects API', () => {
  it('creates a project, returns its normalized settings, and persists its initial content', async () => {
    let projectId: string | undefined;
    try {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: ' API Created Project ',
          outputLength: 2345,
          streamingEnabled: false,
          world: {
            foundation: 'A city suspended above the sea.',
            initialSituation: 'The archive bell rings at midnight.',
          },
          characters: [
            {
              characterId: 'api-created-hero',
              name: 'Iris',
              role: 'protagonist',
              description: 'A careful archivist.',
              traits: [{ label: 'Goal', text: 'Protect the archive.' }],
            },
          ],
        }),
      });

      expect(response.status).toBe(201);
      const project = (await response.json()) as {
        projectId: string;
        title: string;
        outputLength: number;
        streamingEnabled: boolean;
        projectType: string;
      };
      projectId = project.projectId;
      expect(project).toMatchObject({
        title: 'API Created Project',
        outputLength: 2345,
        streamingEnabled: false,
        projectType: 'novel',
      });
      expect(project.projectId).toMatch(/^proj-/);

      const loaded = await fetch(`${baseUrl}/api/projects/${project.projectId}`);
      expect(loaded.status).toBe(200);
      await expect(loaded.json()).resolves.toMatchObject({
        projectId: project.projectId,
        title: 'API Created Project',
        outputLength: 2345,
        streamingEnabled: false,
      });
      await expect(storage.readWorld(project.projectId)).resolves.toEqual({
        foundation: 'A city suspended above the sea.',
        initialSituation: 'The archive bell rings at midnight.',
      });
      await expect(storage.readCharacters(project.projectId)).resolves.toEqual([
        expect.objectContaining({
          characterId: 'api-created-hero',
          name: 'Iris',
          traits: [{ label: 'Goal', text: 'Protect the archive.' }],
        }),
      ]);
    } finally {
      if (projectId) await storage.deleteProjectDir(projectId);
    }
  });

  it('lists projects created through the API', async () => {
    const projectIds: string[] = [];
    const titles = ['API List Project One', 'API List Project Two'];
    try {
      for (const title of titles) {
        const created = await fetch(`${baseUrl}/api/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        expect(created.status).toBe(201);
        const project = (await created.json()) as { projectId: string };
        projectIds.push(project.projectId);
      }

      const response = await fetch(`${baseUrl}/api/projects`);
      expect(response.status).toBe(200);
      const projects = (await response.json()) as Array<{
        projectId: string;
        title: string;
        projectType: string;
        lastExcerpt: string;
      }>;
      expect(projects).toEqual(
        expect.arrayContaining(
          projectIds.map((projectId, index) =>
            expect.objectContaining({
              projectId,
              title: titles[index],
              projectType: 'novel',
              lastExcerpt: '',
            })
          )
        )
      );
    } finally {
      await Promise.all(projectIds.map((projectId) => storage.deleteProjectDir(projectId)));
    }
  });

  it('returns a client error for malformed JSON and invalid project fields', async () => {
    const malformedJson = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":',
    });
    expect(malformedJson.status).toBe(400);
    await expect(malformedJson.json()).resolves.toMatchObject({ code: 'invalid_json' });

    const invalidFields = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 123, customSystemPrompt: { invalid: true } }),
    });
    expect(invalidFields.status).toBe(400);

    const invalidCharacters = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ characters: [{ name: 'IDなし' }] }),
    });
    expect(invalidCharacters.status).toBe(400);
  });
});

describe('characters API', () => {
  it('accepts legacy/new traits, returns normalized data, and rejects malformed traits', async () => {
    const project = await projectService.createProject({ title: 'Characters API Test' });
    try {
      const response = await fetch(`${baseUrl}/api/projects/${project.projectId}/characters`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            characterId: 'char-1',
            name: 'ユイ',
            role: 'protagonist',
            description: '旅人',
            want: '故郷へ帰りたい',
            fear: '仲間を失うこと',
            traits: [
              { label: 'こだわり', text: '約束は必ず守る' },
              { label: '', text: '不完全な行' },
            ],
          },
        ]),
      });

      expect(response.status).toBe(200);
      const saved = (await response.json()) as Array<Record<string, unknown>>;
      expect(saved[0]).toMatchObject({
        traits: [
          { label: 'こだわり', text: '約束は必ず守る' },
          { label: '望み', text: '故郷へ帰りたい' },
          { label: '恐れ', text: '仲間を失うこと' },
        ],
      });
      expect(saved[0]).not.toHaveProperty('want');
      expect(saved[0]).not.toHaveProperty('fear');

      const malformed = await fetch(`${baseUrl}/api/projects/${project.projectId}/characters`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            characterId: 'char-1',
            name: 'ユイ',
            role: 'protagonist',
            description: '旅人',
            traits: ['broken'],
          },
        ]),
      });
      expect(malformed.status).toBe(400);
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });
});

describe('generation API', () => {
  it('rejects malformed modes and oversized wishes before starting generation', async () => {
    const invalidMode = await fetch(`${baseUrl}/api/projects/missing/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wish: '', mode: 'unknown' }),
    });
    expect(invalidMode.status).toBe(400);
    await expect(invalidMode.json()).resolves.toMatchObject({
      code: 'invalid_generate_request',
    });

    const oversized = await fetch(`${baseUrl}/api/projects/missing/generate-stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wish: 'あ'.repeat(20_001), mode: 'continue' }),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.headers.get('content-type')).toContain('application/json');
    await expect(oversized.json()).resolves.toMatchObject({
      code: 'invalid_generate_request',
    });
  });

  it('generates a scene with a mocked adapter and persists it as a draft', async () => {
    const project = await projectService.createProject({ title: 'Generation API Test' });
    try {
      const response = await fetch(`${baseUrl}/api/projects/${project.projectId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wish: '雨上がりの場面から続ける', mode: 'continue' }),
      });

      expect(response.status).toBe(200);
      const record = (await response.json()) as {
        generationId: string;
        sceneId: string;
        status: string;
        responseText: string;
      };
      expect(record).toMatchObject({
        status: 'draft',
        responseText: '統合テスト用の生成本文',
      });

      const readerResponse = await fetch(
        `${baseUrl}/api/projects/${project.projectId}/reader-state`
      );
      expect(readerResponse.status).toBe(200);
      await expect(readerResponse.json()).resolves.toMatchObject({
        state: { selectedDraftGenerationId: record.generationId },
        currentScene: { sceneId: record.sceneId, acceptedGenerationId: null },
        currentGeneration: { generationId: record.generationId, status: 'draft' },
      });
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });

  it('accepts a generated draft through the API and exposes it as the current accepted scene', async () => {
    const project = await projectService.createProject({ title: 'Generation Acceptance API Test' });
    try {
      const generatedResponse = await fetch(`${baseUrl}/api/projects/${project.projectId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wish: '場面を生成する', mode: 'continue' }),
      });
      expect(generatedResponse.status).toBe(200);
      const generated = (await generatedResponse.json()) as {
        generationId: string;
        sceneId: string;
      };

      const acceptedResponse = await fetch(`${baseUrl}/api/projects/${project.projectId}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ generationId: generated.generationId }),
      });
      expect(acceptedResponse.status).toBe(200);
      await expect(acceptedResponse.json()).resolves.toMatchObject({
        generationId: generated.generationId,
        status: 'accepted',
      });

      const readerResponse = await fetch(
        `${baseUrl}/api/projects/${project.projectId}/reader-state`
      );
      expect(readerResponse.status).toBe(200);
      await expect(readerResponse.json()).resolves.toMatchObject({
        state: {
          selectedDraftGenerationId: generated.generationId,
          lastAcceptedGenerationId: generated.generationId,
        },
        currentScene: {
          sceneId: generated.sceneId,
          acceptedGenerationId: generated.generationId,
        },
        currentGeneration: { generationId: generated.generationId, status: 'accepted' },
      });

      await settleBackgroundStoryStateRefresh();
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });

  it('rejects /generate with a 409 while a maintenance phase blocks generation', async () => {
    const project = await projectService.createProject({ title: 'Maintenance Guard API Test' });
    try {
      const state = await storage.readState(project.projectId);
      if (!state) throw new Error('state missing');
      await storage.writeState(project.projectId, {
        ...state,
        refineMaintenance: {
          runId: 'autorun-api-test',
          generationId: 'gen-api-test',
          phase: 'applying',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          appliedPatchIds: [],
          pendingPatchIds: [],
          reviewPatchIds: [],
        },
      });

      const response = await fetch(`${baseUrl}/api/projects/${project.projectId}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wish: '', mode: 'continue' }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: 'post_generation_maintenance_in_progress',
        retryable: true,
      });
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });

  it('preflights /generate-stream with a plain JSON 409 before sending SSE headers', async () => {
    const project = await projectService.createProject({ title: 'Maintenance Guard Stream API Test' });
    try {
      const state = await storage.readState(project.projectId);
      if (!state) throw new Error('state missing');
      await storage.writeState(project.projectId, {
        ...state,
        refineMaintenance: {
          runId: 'autorun-api-stream-test',
          generationId: 'gen-api-stream-test',
          phase: 'scanning',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          appliedPatchIds: [],
          pendingPatchIds: [],
          reviewPatchIds: [],
        },
      });

      const response = await fetch(`${baseUrl}/api/projects/${project.projectId}/generate-stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wish: '', mode: 'continue' }),
      });
      // NOTE: preflight は res.writeHead より前に走るため、SSE ではなく通常の
      // HTTP 409 JSON が返る（設計書 4.2）。
      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain('application/json');
      await expect(response.json()).resolves.toMatchObject({
        code: 'post_generation_maintenance_in_progress',
        retryable: true,
      });
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });
});

describe('memories API', () => {
  it('validates request bodies and does not allow immutable fields to be overwritten', async () => {
    const project = await projectService.createProject({ title: 'Memories API Test' });
    try {
      const nullBody = await fetch(`${baseUrl}/api/projects/${project.projectId}/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'null',
      });
      expect(nullBody.status).toBe(400);

      const createdResponse = await fetch(
        `${baseUrl}/api/projects/${project.projectId}/memories`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'storyFact', content: '最初の内容' }),
        }
      );
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as {
        memoryId: string;
        createdAt: string;
      };

      const updatedResponse = await fetch(
        `${baseUrl}/api/projects/${project.projectId}/memories/${created.memoryId}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            content: '更新後',
            memoryId: 'forged-id',
            createdAt: 'forged-date',
          }),
        }
      );
      expect(updatedResponse.status).toBe(200);
      await expect(updatedResponse.json()).resolves.toMatchObject({
        memoryId: created.memoryId,
        createdAt: created.createdAt,
        content: '更新後',
      });
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });
});

describe('project state API', () => {
  it('rejects malformed updates and preserves fields outside the allowed patch', async () => {
    const project = await projectService.createProject({ title: 'State API Test' });
    try {
      const invalid = await fetch(`${baseUrl}/api/projects/${project.projectId}/state`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '[]',
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ code: 'invalid_project_state' });

      const before = await storage.readState(project.projectId);
      const updatedResponse = await fetch(
        `${baseUrl}/api/projects/${project.projectId}/state`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            uiState: { fontSize: 24 },
            storyStateBacklogCount: 999,
          }),
        }
      );
      expect(updatedResponse.status).toBe(200);
      const updated = (await updatedResponse.json()) as {
        storyStateBacklogCount?: number;
        uiState: { fontSize: number; readingPosition: number };
      };
      expect(updated.uiState).toEqual({
        fontSize: 24,
        readingPosition: before?.uiState.readingPosition,
      });
      expect(updated.storyStateBacklogCount).toBeUndefined();
    } finally {
      await storage.deleteProjectDir(project.projectId);
    }
  });
});

async function settleBackgroundStoryStateRefresh(): Promise<void> {
  // accept は本文保存をブロックしないため、次の書き込みが作品削除と競合しないよう待つ。
  await new Promise((resolve) => setTimeout(resolve, 0));
  await withDataDirLock(async () => undefined);
}
