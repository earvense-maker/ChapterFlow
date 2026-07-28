import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWebApp } from '../../apps/web/src/app';
import { readWebConfig } from '../../apps/web/src/config';
import { hashUserId, stripQuery } from '../../apps/web/src/log';

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = createWebApp({ ...readWebConfig({}), sseProbeToken: null });
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

afterEach(() => {
  vi.restoreAllMocks();
});

async function captureRequestLog(requestPath: string): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });

  await fetch(`${baseUrl}${requestPath}`);

  // NOTE: アクセスログは res の 'finish' で書くので、fetch の解決より後になり得る。
  for (let attempt = 0; attempt < 50 && lines.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const entry = lines.map((line) => JSON.parse(line) as Record<string, unknown>).at(0);
  if (!entry) throw new Error('リクエストログが記録されませんでした');
  return entry;
}

describe('運用ログ（設計書 5.1）', () => {
  // NOTE: app.use('/api', ...) の中では req.path からマウント接頭辞が落ちる。
  // 障害調査でどのAPIか分からなくなるので、必ず完全なパスを記録する。
  it('マウント配下でも完全なパスを記録する', async () => {
    const entry = await captureRequestLog('/api/projects');
    expect(entry).toMatchObject({ type: 'request', route: '/api/projects', status: 501 });
  });

  it('クエリ文字列をログへ残さない', async () => {
    const entry = await captureRequestLog('/healthz?token=super-secret&email=a@example.com');
    expect(entry.route).toBe('/healthz');
    expect(JSON.stringify(entry)).not.toContain('super-secret');
    expect(JSON.stringify(entry)).not.toContain('a@example.com');
  });

  it('ログのユーザー識別子は既定で空', async () => {
    const entry = await captureRequestLog('/healthz');
    expect(entry.userHash).toBeNull();
  });
});

describe('stripQuery', () => {
  it('クエリ文字列だけを落とす', () => {
    expect(stripQuery('/api/projects')).toBe('/api/projects');
    expect(stripQuery('/api/projects?token=x')).toBe('/api/projects');
    expect(stripQuery('/api/projects?')).toBe('/api/projects');
  });
});

describe('hashUserId', () => {
  // NOTE: salt なしの生ハッシュは、メールアドレスのように候補集合が推測できる値だと
  // 総当たりで戻せる。salt 未設定の環境では「弱い匿名化」を出力せず、何も出さない。
  it('salt が無ければハッシュを出さない', () => {
    expect(hashUserId('user-1', null)).toBeNull();
  });

  it('salt があれば安定した不可逆値を返す', () => {
    const first = hashUserId('user-1', 'deployment-salt');
    const second = hashUserId('user-1', 'deployment-salt');
    expect(first).toBe(second);
    expect(first).not.toContain('user-1');
    expect(hashUserId('user-2', 'deployment-salt')).not.toBe(first);
  });

  it('salt が違えば同じ利用者でも突き合わせできない', () => {
    expect(hashUserId('user-1', 'salt-a')).not.toBe(hashUserId('user-1', 'salt-b'));
  });
});
