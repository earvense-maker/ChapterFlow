import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, DATA_DIR } from './config.js';
import { ensureDir } from './utils/safeWrite.js';
import projectsRouter from './routes/projects.js';
import settingsRouter from './routes/settings.js';
import stateRouter from './routes/state.js';
import generateRouter from './routes/generate.js';
import memoriesRouter from './routes/memories.js';
import modelsRouter from './routes/models.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/projects', projectsRouter);
app.use('/api', settingsRouter);
app.use('/api', stateRouter);
app.use('/api', generateRouter);
app.use('/api', memoriesRouter);
app.use('/api', modelsRouter);

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

async function main() {
  await ensureDir(DATA_DIR);
  app.listen(PORT, () => {
    console.log(`Yumeweaving server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
