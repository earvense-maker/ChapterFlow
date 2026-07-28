import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWebApp } from '../../apps/web/src/app';
import { readWebConfig } from '../../apps/web/src/config';

const PROBE_TOKEN = 'phase0-probe-token';

let probeServer: Server;
let probeBaseUrl = '';
let disabledServer: Server;
let disabledBaseUrl = '';

async function listen(app: ReturnType<typeof createWebApp>): Promise<[Server, string]> {
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, '127.0.0.1', () => resolve(started));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーを起動できませんでした');
  return [server, `http://127.0.0.1:${address.port}`];
}

beforeAll(async () => {
  [probeServer, probeBaseUrl] = await listen(
    createWebApp({ ...readWebConfig({}), sseProbeToken: PROBE_TOKEN })
  );
  [disabledServer, disabledBaseUrl] = await listen(
    createWebApp({ ...readWebConfig({}), sseProbeToken: null })
  );
});

afterAll(async () => {
  for (const server of [probeServer, disabledServer]) {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  }
});

async function readProbeEvents(url: string, token: string | null): Promise<string[]> {
  const response = await fetch(url, {
    headers: token ? { 'x-probe-token': token } : {},
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');

  const events: string[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      events.push(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  return events;
}

describe('SSE検証プローブ', () => {
  // NOTE: 長時間接続を無認証で開けるとそのままDoSの的になる。検証用途でも
  // トークン必須にし、未設定の環境ではルーター自体をマウントしない。
  it('トークン未設定の環境ではプローブが存在しない', async () => {
    const response = await fetch(`${disabledBaseUrl}/api/_probe/sse?seconds=1`);
    expect(response.status).toBe(501);
  });

  it('トークンなしのアクセスは 404 を返す', async () => {
    const response = await fetch(`${probeBaseUrl}/api/_probe/sse?seconds=1`);
    expect(response.status).toBe(404);
  });

  it('誤ったトークンは 404 を返す', async () => {
    const response = await fetch(`${probeBaseUrl}/api/_probe/sse?seconds=1`, {
      headers: { 'x-probe-token': 'wrong-token' },
    });
    expect(response.status).toBe(404);
  });

  it('指定秒数ぶん tick を流して done で終わる', async () => {
    const events = await readProbeEvents(`${probeBaseUrl}/api/_probe/sse?seconds=2`, PROBE_TOKEN);

    expect(events[0]).toContain('event: start');
    expect(events.filter((event) => event.includes('event: tick')).length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toContain('event: done');
  });

  // NOTE: 検証はプロキシのバッファリングを見るためのものなので、本番の生成ストリームと
  // 同じヘッダで流す必要がある。ここだけ緩めると実際の生成で起きる詰まりを見逃す。
  it('本番の生成ストリームと同じキャッシュ制御ヘッダを使う', async () => {
    const response = await fetch(`${probeBaseUrl}/api/_probe/sse?seconds=1`, {
      headers: { 'x-probe-token': PROBE_TOKEN },
    });
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    await response.body?.cancel();
  });
});
