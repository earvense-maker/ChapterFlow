import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { readWebVersion, type WebConfig } from './config.js';
import { logError, logRequest, stripQuery } from './log.js';
import { createSseProbeRouter } from './sseProbe.js';

/**
 * 公開Web版の起動系（設計書 Phase 0「Web版の別エントリ」）。
 *
 * NOTE: Phase 0 では作品データを一切扱わない。認証と所有者付き保存は同じ公開単位で
 * 完成させる決まりなので（設計書 17）、認証が入るまで `/api` は 501 を返し、
 * 既存の `DATA_DIR` を読むルートを1つも生やさない。
 *
 * NOTE: Electron 版の `createApp` を再利用していないのは、あちらが CORS 自動許可と
 * LAN トークン認証を前提にしているため（設計書 10.1）。共有するのは純粋ロジックだけに留める。
 */
export function createWebApp(config: WebConfig): express.Express {
  const app = express();

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(assignRequestId);
  app.use(securityHeaders(config));
  if (config.requireHttps) {
    app.use(redirectToHttps);
  }
  app.use(accessLog);
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/system/version', async (_req, res, next) => {
    try {
      res.json({ version: await readWebVersion(), runtime: 'web' });
    } catch (err) {
      next(err);
    }
  });

  if (config.sseProbeToken) {
    app.use('/api/_probe', createSseProbeRouter(config.sseProbeToken));
  }

  // NOTE: 設計書 10.2 の無効化API。501 のフォールバックより前に置き、Phase 1 以降も
  // 恒久的に 404 のままにする。Electron 側のルーターをコピーして復活させないための番人。
  for (const route of DISABLED_ROUTE_PREFIXES) {
    app.all(route, notFound);
  }

  app.use('/api', (_req, res) => {
    res.status(501).json({
      code: 'not_implemented',
      requestId: requestIdOf(res),
      // NOTE: 利用者向けの文言。実装状況を推測させる詳細は出さない。
      error: '公開Web版はまだ準備中です。',
    });
  });

  app.get('/', (_req, res) => {
    res
      .status(503)
      .type('text/plain; charset=utf-8')
      .send('ChapterFlow 公開Web版は準備中です。');
  });

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// NOTE: 「存在しない」ことを保証したいので、`/api/system/data-dir` 配下は
// 前方一致でまとめて塞ぐ。個別パスの列挙だと将来の追加を取りこぼす。
const DISABLED_ROUTE_PREFIXES = [
  '/api/system/data-dir',
  '/api/system/data-dir/*',
  '/api/system/shortcut',
  '/api/system/shortcut/*',
  '/api/shutdown',
  '/api/restart',
];

function assignRequestId(_req: Request, res: Response, next: NextFunction): void {
  // NOTE: 受信ヘッダの request id は信用しない。ログ相関用IDに任意文字列を注入されると、
  // 別リクエストの調査を妨害できる。内部で必ず採番する。
  const requestId = crypto.randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

function securityHeaders(config: WebConfig) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // NOTE: 同一オリジン配信前提（設計書 12）。外部スクリプト・外部接続を既定で禁止し、
    // Phase 1 以降で認証事業者のドメインが要る場合だけ、必要な directive を明示追加する。
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (config.requireHttps) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

function redirectToHttps(req: Request, res: Response, next: NextFunction): void {
  if (req.secure) {
    next();
    return;
  }
  // NOTE: ホスト名はプロキシ経由の Host ヘッダなので、リダイレクト先の組み立てに
  // クエリ文字列を持ち込まない。認証コードなどが平文ログへ残るのを避ける。
  const host = req.headers.host;
  if (!host || req.method !== 'GET') {
    res.status(400).json({ code: 'https_required', requestId: requestIdOf(res) });
    return;
  }
  res.redirect(308, `https://${host}${req.path}`);
}

function accessLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  const route = stripQuery(req.originalUrl);
  res.on('finish', () => {
    logRequest({
      requestId: requestIdOf(res),
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
      userHash: null,
    });
  });
  next();
}

function notFound(_req: Request, res: Response): void {
  res.status(404).json({ code: 'not_found', requestId: requestIdOf(res) });
}

function errorHandler(
  err: Error & { type?: string; status?: number; statusCode?: number },
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = requestIdOf(res);

  if (err.type === 'entity.too.large') {
    res.status(413).json({ code: 'payload_too_large', requestId });
    return;
  }
  if (err.type === 'entity.parse.failed') {
    res.status(400).json({ code: 'invalid_json', requestId });
    return;
  }

  const declared = err.status ?? err.statusCode;
  const status = typeof declared === 'number' && declared >= 400 && declared < 500 ? declared : 500;
  logError(requestId, status === 500 ? 'internal_error' : 'request_failed', err);
  // NOTE: 例外メッセージを利用者へ返さない（設計書 10.1）。調査は requestId で紐付ける。
  res.status(status).json({
    code: status === 500 ? 'internal_error' : 'request_failed',
    requestId,
  });
}

function requestIdOf(res: Response): string {
  const requestId: unknown = res.locals.requestId;
  return typeof requestId === 'string' ? requestId : 'unknown';
}
