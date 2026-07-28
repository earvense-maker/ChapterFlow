import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

/** プローブが一度に張れる接続の上限秒数。生成の実測上限より少し長く取る。 */
const MAX_PROBE_SECONDS = 900;
const DEFAULT_PROBE_SECONDS = 120;
const PROBE_INTERVAL_MS = 1000;

/**
 * SSE 耐久検証用のプローブ（設計書 Phase 0「本番同等のプロキシを通した長時間SSEの検証」）。
 *
 * NOTE: 検証専用であって製品機能ではない。トークン未設定の環境では
 * ルーター自体をマウントしない（app.ts 側の分岐）。長時間接続を無認証で開けると
 * そのままDoSの的になるため、公開ベータの一般開放前に必ず無効化すること。
 *
 * NOTE: ヘッダは本番の生成ストリーム（src/server/routes/generate.ts）と合わせてある。
 * ここだけ `X-Accel-Buffering: no` などを足すと、実際の生成で起きるバッファリングを
 * 検証で見逃す。
 */
export function createSseProbeRouter(expectedToken: string): Router {
  const router = Router();

  router.get('/sse', (req, res) => {
    if (!hasValidProbeToken(req, expectedToken)) {
      res.status(404).json({ code: 'not_found' });
      return;
    }

    const seconds = readSeconds(req.query.seconds);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();

    startProbeStream(res, seconds);
  });

  return router;
}

function startProbeStream(res: Response, seconds: number): void {
  const startedAt = Date.now();
  let sequence = 0;
  let closed = false;

  const send = (event: string, data: Record<string, unknown>): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    process.stdout.write(
      `${JSON.stringify({
        type: 'sse-probe',
        reason,
        sequence,
        elapsedMs: Date.now() - startedAt,
      })}\n`
    );
    if (reason === 'completed') {
      send('done', { sequence, elapsedMs: Date.now() - startedAt });
      res.end();
    }
  };

  const timer = setInterval(() => {
    sequence += 1;
    const elapsedMs = Date.now() - startedAt;
    send('tick', { sequence, elapsedMs, serverTime: new Date().toISOString() });
    if (elapsedMs >= seconds * 1000) finish('completed');
  }, PROBE_INTERVAL_MS);

  // NOTE: 切断の検知そのものが検証対象。ホスティングによってはプロキシが接続を
  // 保持し続けて 'close' が届かないことがあり、その場合は生成の中断判定が作れない
  // （設計書 5.3 の最後の項目）。ログへ理由を残して後から突き合わせる。
  res.on('close', () => finish('client-closed'));
  res.on('error', () => finish('stream-error'));

  send('start', { seconds, serverTime: new Date().toISOString() });
}

function readSeconds(value: unknown): number {
  const raw = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_PROBE_SECONDS;
  return Math.min(raw, MAX_PROBE_SECONDS);
}

function hasValidProbeToken(req: Request, expectedToken: string): boolean {
  const provided = req.header('x-probe-token');
  if (!provided) return false;
  // NOTE: 長さが違うと timingSafeEqual が投げるので、先にハッシュ化して幅を揃える。
  const providedDigest = crypto.createHash('sha256').update(provided).digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}
