import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  formatSessionFooter,
  formatSessionHeader,
  rotateIfTooLarge,
  runWithTerminalLog,
  stripAnsi,
} from '../../scripts/dev-terminal-log.mjs';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chapterflow-devlog-'));
  tempDirs.push(dir);
  return dir;
}

function waitForClose(child: { on: (event: string, cb: (...args: unknown[]) => void) => void }) {
  return new Promise<void>((resolve) => child.on('close', () => resolve()));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('stripAnsi', () => {
  it('removes color codes but keeps the text, including multibyte characters', () => {
    expect(stripAnsi(`${ESC}[32m[server] 起動しました${ESC}[0m\n`)).toBe('[server] 起動しました\n');
  });

  it('removes OSC title sequences terminated by BEL or string terminator', () => {
    expect(stripAnsi(`${ESC}]0;vite${BEL}ready`)).toBe('ready');
    expect(stripAnsi(`${ESC}]0;vite${ESC}\\ready`)).toBe('ready');
  });

  it('leaves plain output untouched', () => {
    expect(stripAnsi('VITE ready in 412 ms')).toBe('VITE ready in 412 ms');
  });
});

describe('rotateIfTooLarge', () => {
  it('renames the log once it exceeds the limit', () => {
    const logPath = path.join(makeTempDir(), 'dev-terminal.log');
    writeFileSync(logPath, 'x'.repeat(64), 'utf8');

    expect(rotateIfTooLarge(logPath, 32)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
    expect(readFileSync(`${logPath}.old`, 'utf8')).toHaveLength(64);
  });

  it('keeps the log while it is under the limit, and tolerates a missing file', () => {
    const logPath = path.join(makeTempDir(), 'dev-terminal.log');
    expect(rotateIfTooLarge(logPath, 32)).toBe(false);

    writeFileSync(logPath, 'short', 'utf8');
    expect(rotateIfTooLarge(logPath, 32)).toBe(false);
    expect(readFileSync(logPath, 'utf8')).toBe('short');
  });
});

describe('buildChildEnv', () => {
  it('keeps color on when the pipe would otherwise turn it off', () => {
    expect(buildChildEnv({ PATH: '/usr/bin' }).FORCE_COLOR).toBe('1');
  });

  it('does not fight NO_COLOR or an explicit FORCE_COLOR', () => {
    expect(buildChildEnv({ NO_COLOR: '1' })).not.toHaveProperty('FORCE_COLOR');
    expect(buildChildEnv({ FORCE_COLOR: '0' }).FORCE_COLOR).toBe('0');
  });
});

describe('session markers', () => {
  it('records the command on start and how the run ended', () => {
    const now = new Date('2026-07-27T11:25:17.000Z');
    expect(formatSessionHeader('npm run dev:all', now, 1234)).toContain(
      '2026-07-27T11:25:17.000Z [dev-start] pid=1234'
    );
    expect(formatSessionHeader('npm run dev:all', now, 1234)).toContain('$ npm run dev:all');
    expect(formatSessionFooter(1, null, now)).toContain('[dev-exit] code=1');
    expect(formatSessionFooter(null, 'SIGTERM', now)).toContain('[dev-exit] signal=SIGTERM');
  });
});

describe('runWithTerminalLog', () => {
  it('captures both stdout and stderr of the child, stripped of color codes', async () => {
    const logPath = path.join(makeTempDir(), 'dev-terminal.log');
    const script = `process.stdout.write('${ESC}[32mhello 世界${ESC}[0m\\n'); process.stderr.write('boom\\n');`;

    const child = runWithTerminalLog(['node', '-e', `"${script}"`], logPath);
    await waitForClose(child);

    const written = readFileSync(logPath, 'utf8');
    expect(written).toContain('$ node -e');
    expect(written).toContain('hello 世界');
    expect(written).toContain('boom');
    expect(written).not.toContain(ESC);
    expect(written).toContain('[dev-exit] code=0');
  });

  it('appends across runs so an earlier crashed session stays readable', async () => {
    const logPath = path.join(makeTempDir(), 'dev-terminal.log');

    const first = runWithTerminalLog(['node', '-e', `"process.stdout.write('first\\n')"`], logPath);
    await waitForClose(first);
    const second = runWithTerminalLog(['node', '-e', `"process.stdout.write('second\\n')"`], logPath);
    await waitForClose(second);

    const written = readFileSync(logPath, 'utf8');
    expect(written).toContain('first');
    expect(written).toContain('second');
    expect(written.match(/\[dev-start\]/g)).toHaveLength(2);
  });

  it('creates the log directory when it does not exist yet', async () => {
    const logPath = path.join(makeTempDir(), 'logs', 'dev-terminal.log');

    const child = runWithTerminalLog(['node', '-e', `"process.stdout.write('ok\\n')"`], logPath);
    await waitForClose(child);

    expect(statSync(logPath).size).toBeGreaterThan(0);
  });
});
