import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchDetachedBrowser, probeOnce } from '../../open-app-window.js';

const servers: http.Server[] = [];

async function startServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port assigned');
  return `http://127.0.0.1:${address.port}/`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('probeOnce', () => {
  it('treats a normal response as ready', async () => {
    const url = await startServer((_req, res) => res.end('ok'));
    expect(await probeOnce(url)).toBe(true);
  });

  it('treats 404 as ready, because it proves the server is reachable', async () => {
    const url = await startServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    expect(await probeOnce(url)).toBe(true);
  });

  it('treats 5xx as not ready, which is how the vite proxy reports a dead API', async () => {
    const url = await startServer((_req, res) => {
      res.statusCode = 502;
      res.end();
    });
    expect(await probeOnce(url)).toBe(false);
  });

  it('reports not ready instead of throwing when nothing is listening', async () => {
    expect(await probeOnce('http://127.0.0.1:9/')).toBe(false);
  });

  it('gives up on a hung server rather than blocking the startup loop', async () => {
    const url = await startServer(() => {
      // 応答を返さずぶら下げる
    });
    expect(await probeOnce(url, 300)).toBe(false);
  });

  it('reports not ready on a malformed url', async () => {
    expect(await probeOnce('not a url')).toBe(false);
  });
});

describe('open-app-window', () => {
  it('launches the app-mode browser detached and lets the parent exit naturally', () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    launchDetachedBrowser(
      'browser.exe',
      'http://localhost:5173',
      undefined,
      spawn as never
    );

    expect(spawn).toHaveBeenCalledWith(
      'browser.exe',
      ['--app=http://localhost:5173', '--window-size=1180,860'],
      { detached: true, stdio: 'ignore' }
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
