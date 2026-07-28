import { readWebConfig } from './config.js';
import { startWebServer } from './server.js';

const config = readWebConfig();
const server = await startWebServer(config);

process.stdout.write(
  `${JSON.stringify({
    type: 'startup',
    port: server.port,
    requireHttps: config.requireHttps,
    trustProxy: config.trustProxy,
    sseProbeEnabled: config.sseProbeToken !== null,
  })}\n`
);

// NOTE: デプロイ基盤がコンテナを停止するときの正常終了。Electron 版のような
// アプリ内からの終了・再起動APIは公開版に持たない（設計書 10.2）。
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
