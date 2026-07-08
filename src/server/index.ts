import { DATA_DIR } from './config.js';
import {
  formatLanUrlsWithToken,
  listReachableUrls,
  startServer,
} from './server.js';
import { isLanAuthRequiredForHost } from './services/lanAuthService.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.YUMEWEAVING_HOST || '127.0.0.1';
const lanAuthRequired = isLanAuthRequiredForHost(HOST);

async function main() {
  const server = await startServer({
    port: PORT,
    host: HOST,
    onRuntimeError: (err) => {
      console.error('Yumeweaving server failed:', err);
      process.exit(1);
    },
  });

  console.log(`Yumeweaving server listening on http://${HOST}:${server.port}`);
  console.log(`Yumeweaving data directory: ${DATA_DIR}`);
  if (lanAuthRequired) {
    const lan = listReachableUrls(HOST, server.port);
    if (lan.length > 0) {
      console.log(
        server.lanAuthToken
          ? 'Open this token URL from your phone:'
          : 'Reachable from this network at:'
      );
      for (const url of formatLanUrlsWithToken(lan, server.lanAuthToken)) {
        console.log(`  ${url}`);
      }
    }
  }
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Yumeweaving could not start because port ${PORT} is already in use.`);
    console.error('既に Yumeweaving が起動していないか確認してください。');
    console.error('PowerShell で確認する例:');
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT}`);
    console.error('停止する例:');
    console.error(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force`);
    process.exit(1);
  }
  console.error('Failed to start server:', err);
  process.exit(1);
});
