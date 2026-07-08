import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';

export interface SystemRouterOptions {
  onShutdownRequest?: () => void;
}

let cachedVersion: string | null = null;

export function createSystemRouter(options: SystemRouterOptions = {}): Router {
  const router = Router();

  router.get('/system/version', async (_req, res, next) => {
    try {
      res.json({ version: await readPackageVersion() });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: UI の「終了」ボタンから呼ばれる。dev モードは
  // concurrently -> npm -> dev-server.mjs -> tsx watch -> server という多段起動なので、
  // server だけを exit すると tsx watch が再起動として扱う。Electron では main
  // プロセス側に終了を渡し、未指定時は従来どおり親へ SIGTERM を投げる。
  router.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
      if (options.onShutdownRequest) {
        options.onShutdownRequest();
        return;
      }
      try {
        if (process.ppid) process.kill(process.ppid, 'SIGTERM');
      } catch {
        // 親が既に居ないケースは無視
      }
      process.exit(0);
    }, 150);
  });

  return router;
}

async function readPackageVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const packageJsonPath = path.resolve(PROJECT_ROOT, 'package.json');
  const raw = await fs.readFile(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  return cachedVersion;
}
