import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WebConfig {
  port: number;
  host: string;
  /**
   * Express の `trust proxy` 設定値。
   *
   * NOTE: 既定は 0（信用しない）。実IPとプロトコルの判定はホスティングのプロキシ段数に
   * 完全に依存し、間違えるとレート制限を実IPで掛けられず、HTTPS判定も壊れる
   * （設計書 10.1）。採用ホスティングを決めた時点で明示的に設定する。
   */
  trustProxy: number;
  /** 本番相当。HTTPS強制とHSTSを有効にする（設計書 12）。 */
  requireHttps: boolean;
  /** リクエストボディ上限。実際の上限値は設計書 15-7 の未決定事項。 */
  jsonBodyLimit: string;
  /** SSE検証プローブ（Phase 0 のホスティング判定用）を有効にするトークン。 */
  sseProbeToken: string | null;
}

export function readWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  return {
    port: readPort(env.PORT, 3100),
    host: env.CHAPTERFLOW_WEB_HOST ?? '0.0.0.0',
    trustProxy: readTrustProxy(env.CHAPTERFLOW_WEB_TRUST_PROXY),
    requireHttps: env.CHAPTERFLOW_WEB_REQUIRE_HTTPS === '1',
    jsonBodyLimit: env.CHAPTERFLOW_WEB_JSON_LIMIT ?? '1mb',
    sseProbeToken: normalizeSecret(env.CHAPTERFLOW_WEB_SSE_PROBE_TOKEN),
  };
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`PORT の値が不正です: ${value}`);
  }
  return parsed;
}

function readTrustProxy(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`CHAPTERFLOW_WEB_TRUST_PROXY はプロキシ段数（0以上の整数）で指定してください: ${value}`);
  }
  return parsed;
}

function normalizeSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// NOTE: dev（apps/web/src から実行）と dist（dist-web/src から実行）で、モジュールから見た
// package.json の相対位置が同じになるよう tsconfig の rootDir を apps/web にしてある。
// ビルド時に package.json を dist-web へ複製する（scripts/build-web.mjs）。
const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

let cachedVersion: string | null = null;

export async function readWebVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const raw = await fs.readFile(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  return cachedVersion;
}
