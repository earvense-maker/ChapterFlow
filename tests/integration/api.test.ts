import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
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
});

describe('projects API', () => {
  it.todo('creates a project and returns it');
  it.todo('lists created projects');
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
  it.todo('generates a scene with mocked adapter');
  it.todo('accepts a generated draft');
});
