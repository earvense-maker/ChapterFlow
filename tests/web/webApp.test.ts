import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebApp } from '../../apps/web/src/app';
import { readWebConfig } from '../../apps/web/src/config';

let server: Server;
let baseUrl = '';

const config = {
  ...readWebConfig({}),
  // NOTE: プローブは既定で無効。有効時の挙動は別テストで確認する。
  sseProbeToken: null,
};

beforeAll(async () => {
  const app = createWebApp(config);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーを起動できませんでした');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('公開Web版の起動系', () => {
  it('ヘルスチェックが応答する', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('バージョン取得は残り、runtime は web を返す', async () => {
    const response = await fetch(`${baseUrl}/api/system/version`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string; runtime: string };
    expect(body.runtime).toBe('web');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('調査用の requestId をレスポンスヘッダで返す', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  // NOTE: 受信ヘッダの request id を採用すると、調査ログを任意の値で汚染できる。
  it('クライアントが指定した requestId を採用しない', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { 'x-request-id': 'spoofed-by-client' },
    });
    expect(response.headers.get('x-request-id')).not.toBe('spoofed-by-client');
  });

  it('セキュリティヘッダを設定する', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('CORSをワイルドカードで開けない', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: 'https://example.com' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// NOTE: 設計書 16「データディレクトリ操作、終了、再起動、ショートカット生成APIが
// Web版に存在しない」の受け入れ基準。Electron 版のルーターを持ち込んだ場合にここで落ちる。
describe('無効化API（設計書 10.2）', () => {
  const disabledRoutes: Array<[string, string]> = [
    ['GET', '/api/system/data-dir'],
    ['POST', '/api/system/data-dir/preview'],
    ['POST', '/api/system/data-dir/apply'],
    ['POST', '/api/system/data-dir/switch-preview'],
    ['POST', '/api/system/data-dir/switch'],
    ['POST', '/api/system/data-dir/select-folder'],
    ['POST', '/api/system/shortcut'],
    ['POST', '/api/shutdown'],
    ['POST', '/api/restart'],
  ];

  it.each(disabledRoutes)('%s %s は 404 を返す', async (method, route) => {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : '{}',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('未実装API', () => {
  it('作品APIは認証が入るまで 501 を返す', async () => {
    const response = await fetch(`${baseUrl}/api/projects`);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: 'not_implemented' });
  });

  // NOTE: 認証と所有者付き保存は同じ公開単位で完成させる（設計書 17）。Phase 0 の
  // 起動系が作品データを返し始めていないことを、実際のレスポンスで固定しておく。
  it('作品データを返すルートが1つも生えていない', async () => {
    const dataRoutes = [
      '/api/projects',
      '/api/projects/proj-000/state',
      '/api/projects/proj-000/characters',
      '/api/projects/proj-000/world',
      '/api/projects/proj-000/memories',
      '/api/setup-sessions',
      '/api/presets',
    ];
    for (const route of dataRoutes) {
      const response = await fetch(`${baseUrl}${route}`);
      expect([404, 501]).toContain(response.status);
    }
  });
});

describe('エラー応答', () => {
  it('壊れたJSONには本文を含めない安定コードを返す', async () => {
    const response = await fetch(`${baseUrl}/api/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ broken',
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; requestId: string };
    expect(body.code).toBe('invalid_json');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('上限を超えるペイロードを 413 で拒否する', async () => {
    const response = await fetch(`${baseUrl}/api/anything`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'あ'.repeat(700_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'payload_too_large' });
  });
});
