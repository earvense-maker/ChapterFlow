import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { withDataDirLock } from '../../src/server/services/dataDirLock';

const servers: RunningServer[] = [];
const createdProjectIds: string[] = [];
const originalAllowedOrigins = process.env.CHAPTERFLOW_ALLOWED_ORIGINS;
const originalLegacyAllowedOrigins = process.env.YUMEWEAVING_ALLOWED_ORIGINS;

beforeEach(() => {
  delete process.env.CHAPTERFLOW_ALLOWED_ORIGINS;
  delete process.env.YUMEWEAVING_ALLOWED_ORIGINS;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(createdProjectIds.splice(0).map((projectId) => storage.deleteProjectDir(projectId)));
  vi.restoreAllMocks();
  if (originalAllowedOrigins === undefined) {
    delete process.env.CHAPTERFLOW_ALLOWED_ORIGINS;
  } else {
    process.env.CHAPTERFLOW_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
  if (originalLegacyAllowedOrigins === undefined) {
    delete process.env.YUMEWEAVING_ALLOWED_ORIGINS;
  } else {
    process.env.YUMEWEAVING_ALLOWED_ORIGINS = originalLegacyAllowedOrigins;
  }
});

describe('startServer', () => {
  it('starts on an ephemeral port and responds to API requests', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));
    const origin = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${origin}/api/system/version`, {
      headers: { Origin: origin },
    });
    const body = (await res.json()) as { version?: string; runtime?: string };

    expect(server.port).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.runtime).toBe('server');
  });

  it('serves and validates the two-area world API shape', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));
    const project = await projectService.createProject({ title: 'World API' });
    createdProjectIds.push(project.projectId);
    const endpoint = `http://127.0.0.1:${server.port}/api/projects/${project.projectId}/world`;

    const invalid = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ foundation: '法則だけ' }),
    });
    expect(invalid.status).toBe(400);

    const world = {
      foundation: '```ts\nconst magic = true;',
      initialSituation: '王国は停戦中',
    };
    const updated = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(world),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual(world);

    const loaded = await fetch(endpoint);
    expect(loaded.status).toBe(200);
    await expect(loaded.json()).resolves.toEqual(world);

    const areaUpdated = await fetch(`${endpoint}/initialSituation`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '王国は開戦直前' }),
    });
    expect(areaUpdated.status).toBe(200);
    await expect(areaUpdated.json()).resolves.toEqual({
      foundation: world.foundation,
      initialSituation: '王国は開戦直前',
    });
  });

  it('does not allow unrelated CORS origins', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));

    const res = await fetch(`http://127.0.0.1:${server.port}/api/system/version`, {
      headers: { Origin: 'http://example.invalid' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not allow other localhost ports', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));
    const otherPort =
      [60000, 60001, 60002].find((port) => port !== server.port && port !== 5173) ?? 60003;

    const res = await fetch(`http://127.0.0.1:${server.port}/api/system/version`, {
      headers: { Origin: `http://127.0.0.1:${otherPort}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('honors explicitly configured CORS origins', async () => {
    process.env.CHAPTERFLOW_ALLOWED_ORIGINS = 'http://allowed.example';
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));

    const allowedRes = await fetch(`http://127.0.0.1:${server.port}/api/system/version`, {
      headers: { Origin: 'http://allowed.example' },
    });
    const sameHostRes = await fetch(`http://127.0.0.1:${server.port}/api/system/version`, {
      headers: { Origin: `http://127.0.0.1:${server.port}` },
    });

    expect(allowedRes.headers.get('access-control-allow-origin')).toBe('http://allowed.example');
    expect(sameHostRes.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('delegates shutdown requests when a callback is provided', async () => {
    const onShutdownRequest = vi.fn();
    const server = await track(
      startServer({ host: '127.0.0.1', port: 0, onShutdownRequest })
    );

    const res = await fetch(`http://127.0.0.1:${server.port}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(onShutdownRequest).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable 503 for write routes while the data directory is locked', async () => {
    const project = await projectService.createProject({ title: 'Locked Route Test' });
    createdProjectIds.push(project.projectId);
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));
    let releaseLock!: () => void;
    const lockPromise = withDataDirLock(
      () => new Promise<void>((resolve) => {
        releaseLock = resolve;
      })
    );

    try {
      await Promise.resolve();
      const res = await fetch(`http://127.0.0.1:${server.port}/api/projects/${project.projectId}/state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastOpenedAt: new Date().toISOString() }),
      });
      const body = (await res.json()) as { error?: string; code?: string; retryable?: boolean };

      expect(res.status).toBe(503);
      expect(body.code).toBe('data_dir_moving');
      expect(body.retryable).toBe(true);
      expect(body.error).toContain('データ移動中');
    } finally {
      releaseLock?.();
      await lockPromise.catch(() => undefined);
    }
  });

  it('rejects when the requested port is already in use', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));

    await expect(startServer({ host: '127.0.0.1', port: server.port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
  });
});

async function track(serverPromise: Promise<RunningServer>): Promise<RunningServer> {
  const server = await serverPromise;
  servers.push(server);
  return server;
}
