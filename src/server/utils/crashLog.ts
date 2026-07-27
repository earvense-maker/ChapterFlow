import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// NOTE: dev 起動は concurrently --kill-others-on-fail なので、API サーバーが未処理の
// Promise 拒否で即死すると Vite ごと落ち、ターミナルの表示も一緒に消えてしまう。
// 「何も残らないまま全部落ちた」を無くすため、死ぬ前に必ずファイルへ痕跡を残す。

export const CRASH_LOG_DIR_NAME = 'logs';
export const CRASH_LOG_FILE_NAME = 'crash.log';
const MAX_CRASH_LOG_BYTES = 1_000_000;

export type CrashKind = 'unhandledRejection' | 'uncaughtException';
export type CrashRuntime = 'server' | 'electron';

export interface WriteCrashRecordOptions {
  dataDir?: string;
  runtime?: CrashRuntime;
  now?: Date;
}

function formatReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.stack ?? `${reason.name}: ${reason.message}`;
  }
  try {
    return typeof reason === 'string' ? reason : JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function rotateIfTooLarge(logPath: string): void {
  try {
    if (statSync(logPath).size < MAX_CRASH_LOG_BYTES) return;
    renameSync(logPath, `${logPath}.old`);
  } catch {
    // 初回（ファイル無し）や rename 失敗時はそのまま追記する。記録を残すことが最優先。
  }
}

/**
 * クラッシュ内容を1件追記し、実際に書けたパスを返す。書けなければ null。
 *
 * NOTE: プロセスが直後に exit するため、非同期 I/O ではフラッシュ前に消える。
 * すべて同期 API で書く。
 */
export function writeCrashRecord(
  kind: CrashKind,
  reason: unknown,
  options: WriteCrashRecordOptions = {}
): string | null {
  const runtime = options.runtime ?? 'server';
  const timestamp = (options.now ?? new Date()).toISOString();
  const record =
    `==== ${timestamp} [${kind}] runtime=${runtime} pid=${process.pid} node=${process.version}\n` +
    `${formatReason(reason)}\n\n`;

  // NOTE: データフォルダが書けない状態（権限・切断されたドライブ）そのものが
  // クラッシュ原因のこともあるので、temp へフォールバックしてでも記録を残す。
  const candidates = [
    path.join(options.dataDir ?? DATA_DIR, CRASH_LOG_DIR_NAME, CRASH_LOG_FILE_NAME),
    path.join(os.tmpdir(), `chapterflow-${CRASH_LOG_FILE_NAME}`),
  ];
  for (const logPath of candidates) {
    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      rotateIfTooLarge(logPath);
      appendFileSync(logPath, record, 'utf-8');
      return logPath;
    } catch {
      // 次の候補へ
    }
  }
  return null;
}

let installed = false;

/**
 * 未処理の Promise 拒否 / 例外を記録してから終了する。
 *
 * NOTE: ハンドラを登録した時点で Node 既定の「即クラッシュ」は無効になるため、
 * 記録後に自分で exit(1) して従来どおり落とす（壊れた状態のまま動き続けさせない）。
 */
export function installCrashLogging(runtime: CrashRuntime = 'server'): void {
  if (installed) return;
  installed = true;

  const handle = (kind: CrashKind, reason: unknown): never => {
    const logPath = writeCrashRecord(kind, reason, { runtime });
    console.error(`[ChapterFlow] ${kind} により終了します:`);
    console.error(formatReason(reason));
    if (logPath) console.error(`[ChapterFlow] 記録先: ${logPath}`);
    process.exit(1);
  };

  process.on('unhandledRejection', (reason) => handle('unhandledRejection', reason));
  process.on('uncaughtException', (error) => handle('uncaughtException', error));
}

export function resetCrashLoggingForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Crash logging state can only be reset in tests');
  }
  installed = false;
}
