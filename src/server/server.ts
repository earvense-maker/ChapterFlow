import type { Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { DATA_DIR } from './config.js';
import { createApp } from './app.js';
import { ensureDir } from './utils/safeWrite.js';
import {
  appendTokenToUrl,
  ensureLanToken,
  isLanAuthRequiredForHost,
} from './services/lanAuthService.js';
import { ensureShortcutsDir } from './services/shortcutService.js';

export interface StartServerOptions {
  port?: number;
  host?: string;
  onShutdownRequest?: () => void;
  onRestartRequest?: () => void;
  onRuntimeError?: (err: NodeJS.ErrnoException) => void;
}

export interface RunningServer {
  port: number;
  host: string;
  lanAuthToken: string | null;
  close(options?: CloseServerOptions): Promise<void>;
}

export interface CloseServerOptions {
  force?: boolean;
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const port = options.port ?? 3001;
  const host = options.host ?? '127.0.0.1';
  const lanAuthRequired = isLanAuthRequiredForHost(host);
  const lanAuthToken = lanAuthRequired ? await ensureLanToken() : null;
  let actualPort: number | null = port > 0 ? port : null;

  await ensureDir(DATA_DIR);
  await ensureShortcutsDir();

  const app = createApp({
    host,
    port,
    getActualPort: () => actualPort,
    lanAuthToken,
    onShutdownRequest: options.onShutdownRequest,
    onRestartRequest: options.onRestartRequest,
  });
  const server = await listen(app.listen.bind(app), port, host);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (options.onRuntimeError) {
      options.onRuntimeError(err);
      return;
    }
    console.error('ChapterFlow server runtime error:', err);
  });
  const address = server.address();
  actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: actualPort,
    host,
    lanAuthToken,
    close: (closeOptions) => closeServer(server, closeOptions),
  };
}

export function listReachableUrls(host: string, port: number): string[] {
  if (host === '0.0.0.0' || host === '::') return listLanUrls(port);
  return [`http://${formatHostForUrl(host)}:${port}`];
}

export function formatLanUrlsWithToken(
  urls: string[],
  lanAuthToken: string | null
): string[] {
  return urls.map((url) => (lanAuthToken ? appendTokenToUrl(url, lanAuthToken) : url));
}

function listen(
  appListen: (port: number, host: string, callback?: () => void) => Server,
  port: number,
  host: string
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = appListen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}

function closeServer(server: Server, options: CloseServerOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
    if (options.force) {
      closeAllConnections(server);
    }
  });
}

function closeAllConnections(server: Server): void {
  const maybeServer = server as Server & { closeAllConnections?: () => void };
  maybeServer.closeAllConnections?.();
}

function listLanUrls(port: number): string[] {
  const urls: string[] = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        urls.push(`http://${info.address}:${port}`);
      }
    }
  }
  return urls;
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
