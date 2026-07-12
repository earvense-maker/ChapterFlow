import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import projectsRouter from './routes/projects.js';
import settingsRouter from './routes/settings.js';
import stateRouter from './routes/state.js';
import generateRouter from './routes/generate.js';
import expressionsRouter from './routes/expressions.js';
import memoriesRouter from './routes/memories.js';
import knowledgeRouter from './routes/knowledge.js';
import modelsRouter from './routes/models.js';
import setupSessionsRouter from './routes/setupSessions.js';
import { createSystemRouter } from './routes/system.js';
import refineRouter from './routes/refine.js';
import {
  createLanAuthMiddleware,
  isLanAuthRequiredForHost,
} from './services/lanAuthService.js';
import { DataDirLockedError } from './services/dataDirLock.js';

export interface CreateAppOptions {
  host: string;
  port: number;
  getActualPort?: () => number | null;
  lanAuthToken?: string | null;
  onShutdownRequest?: () => void;
  onRestartRequest?: () => void;
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const configuredCorsOrigins = process.env.YUMEWEAVING_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const corsPolicy = buildCorsPolicy({
    configuredCorsOrigins,
    host: options.host,
    port: options.port,
  });

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || isAllowedCorsOrigin(origin, corsPolicy, options.getActualPort)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
    })
  );
  if (isLanAuthRequiredForHost(options.host)) {
    app.use(createLanAuthMiddleware(() => options.lanAuthToken ?? null));
  }
  app.use(express.json({ limit: '10mb' }));

  app.use('/api/projects', projectsRouter);
  app.use('/api', settingsRouter);
  app.use('/api', stateRouter);
  app.use('/api', generateRouter);
  app.use('/api', expressionsRouter);
  app.use('/api', memoriesRouter);
  app.use('/api', knowledgeRouter);
  app.use('/api', modelsRouter);
  app.use('/api', setupSessionsRouter);
  app.use('/api', createSystemRouter({
    onShutdownRequest: options.onShutdownRequest,
    onRestartRequest: options.onRestartRequest,
  }));
  app.use('/api', refineRouter);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (err instanceof DataDirLockedError) {
        return res.status(503).json({
          error: err.message,
          code: 'data_dir_moving',
          retryable: true,
        });
      }
      next(err);
    }
  );

  const staticClientDir = path.resolve(PROJECT_ROOT, 'dist', 'client');
  if (existsSync(staticClientDir)) {
    app.use(express.static(staticClientDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(staticClientDir, 'index.html'));
    });
  }

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error(err);
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  );

  return app;
}

interface CorsPolicy {
  exactOrigins: Set<string>;
  loopbackPorts: Set<string>;
  allowLoopbackByPort: boolean;
}

function buildCorsPolicy({
  configuredCorsOrigins,
  host,
  port,
}: {
  configuredCorsOrigins?: string[];
  host: string;
  port: number;
}): CorsPolicy {
  const devClientPort = process.env.VITE_DEV_PORT || 5173;
  const exactOrigins = new Set(
    configuredCorsOrigins ?? [
      `http://localhost:${devClientPort}`,
      `http://127.0.0.1:${devClientPort}`,
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]
  );
  const loopbackPorts = new Set<string>();

  if (!configuredCorsOrigins) {
    loopbackPorts.add(String(devClientPort));
    if (port > 0) loopbackPorts.add(String(port));
  }

  // NOTE: HOST=0.0.0.0 の LAN 配信モードでは、スマホから http://<LAN_IP>:PORT を
  // 開いた時に same-origin fetch でも Origin ヘッダが付くケースがあるため、
  // 自分の LAN IPv4 を許可オリジンとして自動追加する。
  if (host === '0.0.0.0' && !configuredCorsOrigins) {
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const info of nets[name] ?? []) {
        if (info.family === 'IPv4' && !info.internal) {
          exactOrigins.add(`http://${info.address}:${port}`);
          exactOrigins.add(`http://${info.address}:${devClientPort}`);
        }
      }
    }
  }

  return {
    exactOrigins,
    loopbackPorts,
    allowLoopbackByPort: !configuredCorsOrigins,
  };
}

function isAllowedCorsOrigin(
  origin: string,
  policy: CorsPolicy,
  getActualPort?: () => number | null
): boolean {
  if (policy.exactOrigins.has(origin)) return true;
  if (!policy.allowLoopbackByPort) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      return false;
    }

    const actualPort = getActualPort?.();
    const allowedPorts = new Set(policy.loopbackPorts);
    if (actualPort && actualPort > 0) allowedPorts.add(String(actualPort));
    return allowedPorts.has(parsed.port || defaultPortForProtocol(parsed.protocol));
  } catch {
    return false;
  }
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'https:' ? '443' : '80';
}
