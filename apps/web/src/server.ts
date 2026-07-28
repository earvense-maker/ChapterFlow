import type { Server } from 'node:http';
import { createWebApp } from './app.js';
import { readWebConfig, type WebConfig } from './config.js';

export interface RunningWebServer {
  port: number;
  close(): Promise<void>;
}

export async function startWebServer(
  config: WebConfig = readWebConfig()
): Promise<RunningWebServer> {
  const app = createWebApp(config);
  const server = await listen(app, config.port, config.host);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // NOTE: SSE の常時接続があると close だけでは終わらない。デプロイ基盤の
        // 停止シグナルで確実に落とすため、既存接続も切る。
        server.closeAllConnections?.();
      }),
  };
}

function listen(
  app: ReturnType<typeof createWebApp>,
  port: number,
  host: string
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
    server.once('error', reject);
  });
}
