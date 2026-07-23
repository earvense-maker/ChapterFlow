import { DATA_DIR } from './config.js';
import {
  formatLanUrlsWithToken,
  listReachableUrls,
  startServer,
} from './server.js';
import { isLanAuthRequiredForHost } from './services/lanAuthService.js';
import * as projectService from './services/projectService.js';
import { continuePostGenerationMaintenanceAfterAcceptance } from './services/postGenerationMaintenanceService.js';
import { readAndNormalizeMaintenance } from './services/refineAutomationGuard.js';
import { readEnvWithLegacyFallback } from './utils/env.js';

const PORT = Number(process.env.PORT ?? 3001);
const HOST = readEnvWithLegacyFallback('CHAPTERFLOW_HOST', 'YUMEWEAVING_HOST') ?? '127.0.0.1';
const lanAuthRequired = isLanAuthRequiredForHost(HOST);

async function main() {
  // NOTE: in-process の自動走査 job は再起動で失われる。サーバー起動時にも lease を
  // 点検して期限切れの blocking phase を failed に戻し、以後の生成を永久に止めない。
  const projects = await projectService.listProjects();
  const maintenanceStatuses = await Promise.all(
    projects.map(async (project) => {
      try {
        const status = await readAndNormalizeMaintenance(project.projectId);
        return { projectId: project.projectId, status };
      } catch (error) {
        console.warn('Failed to normalize post-generation maintenance lease', {
          projectId: project.projectId,
          error,
        });
        return { projectId: project.projectId, status: undefined };
      }
    })
  );
  for (const { projectId, status } of maintenanceStatuses) {
    const continuation = status?.postAcceptanceContinuation;
    if (!continuation) continue;
    void continuePostGenerationMaintenanceAfterAcceptance(projectId, continuation.generationId, status!.runId).catch(
      (error) => {
        console.warn('Failed to resume accepted post-generation maintenance', {
          projectId,
          runId: status!.runId,
          error,
        });
      }
    );
  }
  const server = await startServer({
    port: PORT,
    host: HOST,
    onRuntimeError: (err) => {
      console.error('ChapterFlow server failed:', err);
      process.exit(1);
    },
  });

  console.log(`ChapterFlow server listening on http://${HOST}:${server.port}`);
  console.log(`ChapterFlow data directory: ${DATA_DIR}`);
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
    console.error(`ChapterFlow could not start because port ${PORT} is already in use.`);
    console.error('既に ChapterFlow が起動していないか確認してください。');
    console.error('PowerShell で確認する例:');
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT}`);
    console.error('停止する例:');
    console.error(`  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force`);
    process.exit(1);
  }
  console.error('Failed to start server:', err);
  process.exit(1);
});
