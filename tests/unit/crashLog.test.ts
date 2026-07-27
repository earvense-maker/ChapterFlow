import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CRASH_LOG_FILE_NAME,
  writeCrashRecord,
} from '../../src/server/utils/crashLog.js';

const tempDirs: string[] = [];

function makeDataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chapterflow-crashlog-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('writeCrashRecord', () => {
  it('appends the stack and context to logs/crash.log under the data dir', () => {
    const dataDir = makeDataDir();
    const error = new Error('background job exploded');

    const logPath = writeCrashRecord('unhandledRejection', error, {
      dataDir,
      now: new Date('2026-07-26T10:41:35.000Z'),
    });

    expect(logPath).toBe(path.join(dataDir, 'logs', CRASH_LOG_FILE_NAME));
    const contents = readFileSync(logPath!, 'utf-8');
    expect(contents).toContain('2026-07-26T10:41:35.000Z [unhandledRejection] runtime=server');
    expect(contents).toContain('background job exploded');
    expect(contents).toContain(`pid=${process.pid}`);
  });

  it('keeps earlier crashes when a second one is recorded', () => {
    const dataDir = makeDataDir();

    writeCrashRecord('unhandledRejection', new Error('first'), { dataDir });
    const logPath = writeCrashRecord('uncaughtException', new Error('second'), { dataDir });

    const contents = readFileSync(logPath!, 'utf-8');
    expect(contents).toContain('first');
    expect(contents).toContain('second');
  });

  it('records non-Error rejection values', () => {
    const dataDir = makeDataDir();

    const logPath = writeCrashRecord('unhandledRejection', { code: 'EPERM' }, { dataDir });

    expect(readFileSync(logPath!, 'utf-8')).toContain('{"code":"EPERM"}');
  });

  it('redacts common credential fields and provider key formats', () => {
    const dataDir = makeDataDir();

    const logPath = writeCrashRecord('unhandledRejection', {
      apiKey: 'sk-example-secret-value',
      authorization: 'Bearer header-secret-value',
      message: 'request failed for AIza123456789012345678901234567890',
    }, { dataDir });

    const contents = readFileSync(logPath!, 'utf-8');
    expect(contents).toContain('[REDACTED]');
    expect(contents).not.toContain('sk-example-secret-value');
    expect(contents).not.toContain('header-secret-value');
    expect(contents).not.toContain('AIza123456789012345678901234567890');
  });

  it('falls back to the temp dir when the data dir cannot be written', () => {
    const dataDir = makeDataDir();
    // NOTE: logs を「ファイル」として作ると mkdir が必ず失敗する。保存先の書き込み不能
    // （権限・切断ドライブ）そのものがクラッシュ原因のケースを模す。
    writeFileSync(path.join(dataDir, 'logs'), 'not a directory');

    const logPath = writeCrashRecord('uncaughtException', new Error('disk gone'), { dataDir });

    expect(logPath).toBe(path.join(os.tmpdir(), `chapterflow-${CRASH_LOG_FILE_NAME}`));
    expect(readFileSync(logPath!, 'utf-8')).toContain('disk gone');
    rmSync(logPath!, { force: true });
  });
});
