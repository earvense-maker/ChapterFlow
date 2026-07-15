import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT_PRESETS_PATH } from '../../src/server/config';
import { startServer, type RunningServer } from '../../src/server/server';
import type { SystemPromptPreset } from '../../src/shared/types';

const servers: RunningServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await fs.rm(SYSTEM_PROMPT_PRESETS_PATH, { force: true });
});

describe('system prompt preset API', () => {
  it('supports listing, creating, updating, and deleting presets', async () => {
    const origin = await startOrigin();

    const empty = await fetch(`${origin}/api/system-prompt-presets`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [] });

    const createdResponse = await jsonRequest(`${origin}/api/system-prompt-presets`, 'POST', {
      name: '静かな文体',
      prompt: '静かな三人称で書く。',
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as SystemPromptPreset;

    const updatedResponse = await jsonRequest(
      `${origin}/api/system-prompt-presets/${created.id}`,
      'PUT',
      {
        name: '静かな一人称',
        prompt: '静かな一人称で書く。',
        expectedUpdatedAt: created.updatedAt,
      }
    );
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json()).toMatchObject({
      id: created.id,
      name: '静かな一人称',
      prompt: '静かな一人称で書く。',
    });

    const list = await fetch(`${origin}/api/system-prompt-presets`);
    const listBody = (await list.json()) as { items: SystemPromptPreset[] };
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].id).toBe(created.id);

    const deleted = await fetch(`${origin}/api/system-prompt-presets/${created.id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    await expect(fetch(`${origin}/api/system-prompt-presets`).then((res) => res.json())).resolves.toEqual({
      items: [],
    });
  });

  it('returns client errors for invalid input and missing presets', async () => {
    const origin = await startOrigin();
    const invalid = await jsonRequest(`${origin}/api/system-prompt-presets`, 'POST', {
      name: '',
      prompt: '本文',
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(invalid.status).toBe(400);

    const missing = await jsonRequest(`${origin}/api/system-prompt-presets/missing-id`, 'PUT', {
      name: '名前',
      prompt: '本文',
      expectedUpdatedAt: new Date().toISOString(),
    });
    expect(missing.status).toBe(404);
  });
});

async function startOrigin(): Promise<string> {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

function jsonRequest(url: string, method: 'POST' | 'PUT', body: unknown): Promise<Response> {
  return fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
