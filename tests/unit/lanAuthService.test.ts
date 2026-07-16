import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  LAN_AUTH_COOKIE,
  LAN_TOKEN_PATH,
  appendTokenToUrl,
  createLanAuthMiddleware,
  ensureLanToken,
  isLanAuthRequiredForHost,
  isLoopbackAddress,
  readCookie,
  resetLanTokenCacheForTests,
  stripTokenFromUrl,
  verifyToken,
} from '../../src/server/services/lanAuthService';

const originalEnvToken = process.env.CHAPTERFLOW_LAN_TOKEN;
const originalLegacyEnvToken = process.env.YUMEWEAVING_LAN_TOKEN;

beforeEach(() => {
  resetLanTokenCacheForTests();
  delete process.env.CHAPTERFLOW_LAN_TOKEN;
  delete process.env.YUMEWEAVING_LAN_TOKEN;
  return fs.rm(LAN_TOKEN_PATH, { force: true });
});

afterEach(() => {
  resetLanTokenCacheForTests();
  vi.restoreAllMocks();
  if (originalEnvToken === undefined) {
    delete process.env.CHAPTERFLOW_LAN_TOKEN;
  } else {
    process.env.CHAPTERFLOW_LAN_TOKEN = originalEnvToken;
  }
  if (originalLegacyEnvToken === undefined) {
    delete process.env.YUMEWEAVING_LAN_TOKEN;
  } else {
    process.env.YUMEWEAVING_LAN_TOKEN = originalLegacyEnvToken;
  }
  return fs.rm(LAN_TOKEN_PATH, { force: true });
});

describe('LAN token verification', () => {
  it('verifies matching tokens without comparing raw strings directly', () => {
    expect(verifyToken('secret-token', 'secret-token')).toBe(true);
    expect(verifyToken('wrong-token', 'secret-token')).toBe(false);
    expect(verifyToken('', 'secret-token')).toBe(false);
  });

  it('uses the environment token when provided', async () => {
    process.env.CHAPTERFLOW_LAN_TOKEN = 'fixed-lan-token';

    await expect(ensureLanToken()).resolves.toBe('fixed-lan-token');
    expect(verifyToken('fixed-lan-token')).toBe(true);
  });

  it('rejects environment tokens that cannot round-trip safely in URLs and cookies', async () => {
    process.env.CHAPTERFLOW_LAN_TOKEN = 'token with spaces';

    await expect(ensureLanToken()).rejects.toThrow(
      'CHAPTERFLOW_LAN_TOKEN は英数と -_ のみ使えます'
    );
  });

  it('accepts the legacy environment token name', async () => {
    process.env.YUMEWEAVING_LAN_TOKEN = 'legacy-fixed-token';

    await expect(ensureLanToken()).resolves.toBe('legacy-fixed-token');
  });

  it('repairs broken token files instead of failing startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeRawTokenFile('{broken json');

    const token = await ensureLanToken();
    const repaired = JSON.parse(await fs.readFile(LAN_TOKEN_PATH, 'utf-8')) as { token: unknown };

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(repaired.token).toBe(token);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(LAN_TOKEN_PATH));
  });

  it('surfaces token file read errors instead of regenerating credentials', async () => {
    const readError = Object.assign(new Error('file is busy'), { code: 'EBUSY' });
    vi.spyOn(fs, 'readFile').mockRejectedValue(readError);

    await expect(ensureLanToken()).rejects.toMatchObject({ code: 'EBUSY' });
  });

  it('repairs token files with non-string or empty token values', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeRawTokenFile(JSON.stringify({ token: 123 }));
    const numericRepair = await ensureLanToken();
    expect(numericRepair).toMatch(/^[A-Za-z0-9_-]+$/);

    resetLanTokenCacheForTests();
    await writeRawTokenFile(JSON.stringify({ token: '' }));
    const emptyRepair = await ensureLanToken();
    expect(emptyRepair).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(emptyRepair).not.toBe(numericRepair);
  });
});

describe('LAN auth address helpers', () => {
  it('recognizes loopback variants', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.4.5.6')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
  });

  it('requires auth for non-loopback bind addresses', () => {
    expect(isLanAuthRequiredForHost('127.0.0.1')).toBe(false);
    expect(isLanAuthRequiredForHost('localhost')).toBe(false);
    expect(isLanAuthRequiredForHost('0.0.0.0')).toBe(true);
  });
});

describe('LAN auth middleware', () => {
  it('lets loopback requests through without a token', () => {
    const result = invokeMiddleware({ remoteAddress: '127.0.0.1' });

    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('issues a cookie and strips the query token', () => {
    const result = invokeMiddleware({
      remoteAddress: '192.168.1.30',
      query: { token: 'secret-token' },
      originalUrl: '/projects?token=secret-token&tab=list',
    });

    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(302);
    expect(result.redirectTo).toBe('/projects?tab=list');
    expect(result.cookies[LAN_AUTH_COOKIE]).toMatchObject({
      value: 'secret-token',
      options: expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    });
  });

  it('lets requests through with a valid auth cookie', () => {
    const result = invokeMiddleware({
      remoteAddress: '192.168.1.30',
      cookie: `${LAN_AUTH_COOKIE}=secret-token`,
    });

    expect(result.nextCalled).toBe(true);
  });

  it('decodes encoded auth cookie values', () => {
    expect(readCookie(`${LAN_AUTH_COOKIE}=secret%2Btoken%20x`, LAN_AUTH_COOKIE)).toBe(
      'secret+token x'
    );
    expect(readCookie(`${LAN_AUTH_COOKIE}=bad%ZZtoken`, LAN_AUTH_COOKIE)).toBe('bad%ZZtoken');
  });

  it('does not redirect non-GET requests authenticated by a query token', () => {
    const result = invokeMiddleware({
      method: 'POST',
      remoteAddress: '192.168.1.30',
      query: { token: 'secret-token' },
      path: '/api/projects',
      originalUrl: '/api/projects?token=secret-token',
    });

    expect(result.nextCalled).toBe(true);
    expect(result.statusCode).toBeUndefined();
    expect(result.cookies[LAN_AUTH_COOKIE]).toMatchObject({ value: 'secret-token' });
  });

  it('returns JSON 401 for unauthorized API requests', () => {
    const result = invokeMiddleware({
      remoteAddress: '192.168.1.30',
      path: '/api/projects',
      originalUrl: '/api/projects',
    });

    expect(result.nextCalled).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.jsonBody).toEqual({
      error: 'LAN authentication is required. Open the token URL shown in the startup log.',
    });
  });
});

describe('LAN auth URL helpers', () => {
  it('adds and strips token query parameters', () => {
    expect(appendTokenToUrl('http://192.168.1.2:3001', 'abc')).toBe(
      'http://192.168.1.2:3001/?token=abc'
    );
    expect(stripTokenFromUrl('/?token=abc&x=1')).toBe('/?x=1');
  });
});

function invokeMiddleware({
  method = 'GET',
  remoteAddress = '192.168.1.20',
  query = {},
  cookie,
  path = '/',
  originalUrl = '/',
}: {
  method?: string;
  remoteAddress?: string;
  query?: Record<string, unknown>;
  cookie?: string;
  path?: string;
  originalUrl?: string;
}) {
  const middleware = createLanAuthMiddleware(() => 'secret-token');
  let nextCalled = false;
  const result: {
    statusCode?: number;
    jsonBody?: unknown;
    sentBody?: unknown;
    redirectTo?: string;
    contentType?: string;
    cookies: Record<string, { value: string; options: unknown }>;
    nextCalled: boolean;
  } = {
    cookies: {},
    nextCalled: false,
  };

  const req = {
    socket: { remoteAddress },
    method,
    query,
    headers: cookie ? { cookie } : {},
    path,
    originalUrl,
    url: originalUrl,
  } as unknown as Request;

  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.jsonBody = body;
      return this;
    },
    type(value: string) {
      result.contentType = value;
      return this;
    },
    send(body: unknown) {
      result.sentBody = body;
      return this;
    },
    cookie(name: string, value: string, options: unknown) {
      result.cookies[name] = { value, options };
      return this;
    },
    redirect(code: number, url: string) {
      result.statusCode = code;
      result.redirectTo = url;
      return this;
    },
  } as unknown as Response;

  middleware(req, res, () => {
    nextCalled = true;
  });

  result.nextCalled = nextCalled;
  return result;
}

async function writeRawTokenFile(text: string): Promise<void> {
  await fs.mkdir(path.dirname(LAN_TOKEN_PATH), { recursive: true });
  await fs.writeFile(LAN_TOKEN_PATH, text, 'utf-8');
}
