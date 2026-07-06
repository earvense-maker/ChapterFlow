import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT, DATA_DIR } from './config.js';
import { ensureDir } from './utils/safeWrite.js';
import projectsRouter from './routes/projects.js';
import settingsRouter from './routes/settings.js';
import stateRouter from './routes/state.js';
import generateRouter from './routes/generate.js';
import expressionsRouter from './routes/expressions.js';
import memoriesRouter from './routes/memories.js';
import modelsRouter from './routes/models.js';
import setupSessionsRouter from './routes/setupSessions.js';
import systemRouter from './routes/system.js';
import refineRouter from './routes/refine.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.YUMEWEAVING_HOST || '127.0.0.1';
const DEV_CLIENT_PORT = process.env.VITE_DEV_PORT || 5173;
const configuredCorsOrigins = process.env.YUMEWEAVING_ALLOWED_ORIGINS
  ?.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedCorsOrigins = new Set(
  configuredCorsOrigins ?? [
    `http://localhost:${DEV_CLIENT_PORT}`,
    `http://127.0.0.1:${DEV_CLIENT_PORT}`,
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
  ]
);

// NOTE: HOST=0.0.0.0 の LAN 配信モードでは、スマホから http://<LAN_IP>:PORT を
// 開いた際に same-origin fetch でも Origin ヘッダが付くケースがあるため、
// 自分の LAN IPv4 を許可オリジンとして自動追加する。
if (HOST === '0.0.0.0' && !configuredCorsOrigins) {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        allowedCorsOrigins.add(`http://${info.address}:${PORT}`);
        allowedCorsOrigins.add(`http://${info.address}:${DEV_CLIENT_PORT}`);
      }
    }
  }
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  })
);
app.use(express.json({ limit: '10mb' }));

app.use('/api/projects', projectsRouter);
app.use('/api', settingsRouter);
app.use('/api', stateRouter);
app.use('/api', generateRouter);
app.use('/api', expressionsRouter);
app.use('/api', memoriesRouter);
app.use('/api', modelsRouter);
app.use('/api', setupSessionsRouter);
app.use('/api', systemRouter);
app.use('/api', refineRouter);

// 本番ビルド時はdist/clientを静的配信
const staticClientDir = path.resolve(PROJECT_ROOT, 'dist', 'client');
if (existsSync(staticClientDir)) {
  app.use(express.static(staticClientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(staticClientDir, 'index.html'));
  });
}

// エラーハンドリング
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

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

async function main() {
  await ensureDir(DATA_DIR);
  app.listen(PORT, HOST, () => {
    console.log(`Yumeweaving server listening on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0') {
      const lan = listLanUrls(PORT);
      if (lan.length > 0) {
        console.log('Reachable from this network at:');
        for (const url of lan) console.log(`  ${url}`);
      }
    }
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
