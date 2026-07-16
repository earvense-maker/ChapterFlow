import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { findBusyDevPorts, isPortFree } from '../../scripts/dev-preflight.mjs';

async function listenOnEphemeralPort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port assigned');
  return { server, port: address.port };
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('dev-preflight', () => {
  it('detects a busy port and its release', async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      expect(await isPortFree(port)).toBe(false);
    } finally {
      await closeServer(server);
    }
    expect(await isPortFree(port)).toBe(true);
  });

  it('reports busy dev ports based on env, without duplicates', async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
      const busy = await findBusyDevPorts({
        VITE_DEV_PORT: String(port),
        PORT: String(port),
      });
      expect(busy).toEqual([port]);
    } finally {
      await closeServer(server);
    }
  });

  it('returns empty when the configured ports are free', async () => {
    const { server, port } = await listenOnEphemeralPort();
    await closeServer(server);
    const busy = await findBusyDevPorts({
      VITE_DEV_PORT: String(port),
      PORT: String(port),
    });
    expect(busy).toEqual([]);
  });
});
