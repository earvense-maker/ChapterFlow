import crypto from 'node:crypto';
import path from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import { CONFIG_DIR } from '../config.js';
import { ensureDir, readJsonFile, safeWriteJson } from '../utils/safeWrite.js';

export const LAN_AUTH_COOKIE = 'yw_lan_auth';
export const LAN_AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export const LAN_TOKEN_PATH = path.join(CONFIG_DIR, 'lan-token.json');
const TOKEN_VALUE_PATTERN = /^[A-Za-z0-9_-]+$/;

interface LanTokenFile {
  token: string;
  createdAt: string;
}

let cachedToken: string | null = null;

export async function ensureLanToken(): Promise<string> {
  const envToken = process.env.YUMEWEAVING_LAN_TOKEN?.trim();
  if (envToken) {
    if (!TOKEN_VALUE_PATTERN.test(envToken)) {
      throw new Error('YUMEWEAVING_LAN_TOKEN は英数と -_ のみ使えます');
    }
    cachedToken = envToken;
    return envToken;
  }

  if (cachedToken) return cachedToken;

  let existing: LanTokenFile | null = null;
  try {
    existing = await readJsonFile<LanTokenFile>(LAN_TOKEN_PATH);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.warn(`lan-token.json を再生成します: ${LAN_TOKEN_PATH}`);
  }

  if (existing) {
    if (typeof existing.token === 'string' && existing.token.length > 0) {
      cachedToken = existing.token;
      return cachedToken;
    }
    console.warn(`lan-token.json を再生成します: ${LAN_TOKEN_PATH}`);
  }

  const token = createLanToken();
  await writeLanToken(token);
  cachedToken = token;
  return token;
}

function createLanToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function writeLanToken(token: string): Promise<void> {
  await ensureDir(CONFIG_DIR);
  await safeWriteJson(LAN_TOKEN_PATH, {
    token,
    createdAt: new Date().toISOString(),
  } satisfies LanTokenFile);
}

export function verifyToken(value: string | undefined, expectedToken = cachedToken): boolean {
  if (!value || !expectedToken) return false;
  const actualDigest = crypto.createHash('sha256').update(value).digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedToken).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized === '::ffff:127.0.0.1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function isLanAuthRequiredForHost(host: string): boolean {
  return !isLoopbackAddress(host);
}

export function appendTokenToUrl(url: string, token: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('token', token);
  return parsed.toString();
}

export function createLanAuthMiddleware(getExpectedToken: () => string | null): RequestHandler {
  return (req, res, next) => {
    if (isLoopbackAddress(req.socket.remoteAddress)) {
      next();
      return;
    }

    const expectedToken = getExpectedToken();
    if (!expectedToken) {
      sendUnavailable(res);
      return;
    }

    const cookieToken = readCookie(req.headers.cookie, LAN_AUTH_COOKIE);
    if (verifyToken(cookieToken, expectedToken)) {
      next();
      return;
    }

    const queryToken = getQueryToken(req.query.token);
    if (verifyToken(queryToken, expectedToken)) {
      res.cookie(LAN_AUTH_COOKIE, queryToken, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: LAN_AUTH_COOKIE_MAX_AGE_SECONDS * 1000,
        path: '/',
      });
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.redirect(302, stripTokenFromUrl(req.originalUrl || req.url));
        return;
      }
      next();
      return;
    }

    sendUnauthorized(req, res);
  };
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const cookieName = part.slice(0, index).trim();
    if (cookieName === name) {
      return decodeCookieValue(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function stripTokenFromUrl(input: string): string {
  const parsed = new URL(input, 'http://yumeweaving.local');
  parsed.searchParams.delete('token');
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function resetLanTokenCacheForTests(): void {
  cachedToken = null;
}

function getQueryToken(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function sendUnavailable(res: Response): void {
  res.status(503).json({ error: 'LAN authentication is not ready yet.' });
}

function sendUnauthorized(req: Request, res: Response): void {
  if (req.path.startsWith('/api/')) {
    res.status(401).json({
      error: 'LAN authentication is required. Open the token URL shown in the startup log.',
    });
    return;
  }

  res.status(401).type('html').send(`<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <title>Yumeweaving LAN認証</title>
  </head>
  <body>
    <h1>Yumeweaving LAN認証が必要です</h1>
    <p>PCの起動ログに表示されたトークン付きURLから開いてください。</p>
  </body>
</html>`);
}
