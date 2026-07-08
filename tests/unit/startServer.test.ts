import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../src/server/server';

const servers: RunningServer[] = [];
const originalAllowedOrigins = process.env.YUMEWEAVING_ALLOWED_ORIGINS;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
  if (originalAllowedOrigins === undefined) {
    delete process.env.YUMEWEAVING_ALLOWED_ORIGINS;
  } else {
    process.env.YUMEWEAVING_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});

describe('startServer', () => {
  it('starts on an ephemeral port and responds to API requests', async () => {
    const server = await track(startServer({ host: '127.0.0.1', port: 0 }));
    const origin = `http://127.0.0.1:${server.port}`;

    const res = await fetch(`${origin}/api/system/version`, {
      headers: { Origin: origin },
    });
    const body = (await res.json()) as { version?: string };

    expect(server.port).toBeGreaterThan(0);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
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
    process.env.YUMEWEAVING_ALLOWED_ORIGINS = 'http://allowed.example';
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
