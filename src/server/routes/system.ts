import { Router } from 'express';

const router = Router();

// NOTE: UI の「終了」ボタンから呼ばれる。dev モードでは tsx watch が自プロセス
// 終了を再起動として拾わないよう、親プロセス（tsx watch → concurrently）に
// SIGTERM を投げて連鎖終了させる。package.json 側で concurrently に -k を
// つけているので、siblings（vite, open-app-window）もそれで巻き込み終了する。
// prod モードでは自 process.exit だけで足りる（親は起動シェル）。
router.post('/shutdown', (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => {
    try {
      if (process.ppid) process.kill(process.ppid, 'SIGTERM');
    } catch {
      // 親が既に居ないケースは無視
    }
    process.exit(0);
  }, 150);
});

export default router;
