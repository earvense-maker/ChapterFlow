import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OPENER_PATH, describeFailure, runOpener } from '../../scripts/open-app-guard.mjs';

const GUARD_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'open-app-guard.mjs');

function runGuard(env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GUARD_PATH], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    child.on('exit', (code) => resolve(code));
  });
}

describe('open-app-guard', () => {
  it('points at the real opener next to the repo root', () => {
    expect(OPENER_PATH.endsWith(`${path.sep}open-app-window.js`)).toBe(true);
  });

  it('runs the opener as a child process so a native crash stays contained', () => {
    const on = vi.fn();
    const spawnImpl = vi.fn(() => ({ on }));

    runOpener(['http://localhost:3001'], spawnImpl as never);

    expect(spawnImpl).toHaveBeenCalledWith(
      process.execPath,
      [OPENER_PATH, 'http://localhost:3001'],
      { stdio: 'inherit' }
    );
  });

  it('spells out Windows fail-fast codes in hex, since decimal is unreadable', () => {
    expect(describeFailure(3221226505, null)).toContain('0xC0000409');
    expect(describeFailure(1, null)).toBe('終了コード 1 で終了しました');
    expect(describeFailure(null, 'SIGTERM')).toBe('シグナル SIGTERM で終了しました');
  });

  it('exits 0 when the opener succeeds', async () => {
    // CHAPTERFLOW_SKIP_OPEN で opener は即 return する（成功パス）
    expect(await runGuard({ CHAPTERFLOW_SKIP_OPEN: '1' })).toBe(0);
  });

  it('still exits 0 when the opener fails, so dev is not killed with it', async () => {
    // 応答しないURLを短いタイムアウトで待たせ、opener を throw させる
    const code = await runGuard({
      CHAPTERFLOW_SKIP_OPEN: '0',
      CI: '',
      CHAPTERFLOW_URL: 'http://127.0.0.1:9',
      CHAPTERFLOW_OPEN_TIMEOUT_MS: '300',
    });
    expect(code).toBe(0);
  });
});
