import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

// NOTE: 既定URLは vite.config.ts と同じ VITE_DEV_PORT を参照する。5173固定だと、
// ポートをずらして起動した際に別インスタンスのウィンドウを開いてしまう。
const url =
  process.argv[2] ||
  process.env.CHAPTERFLOW_URL ||
  process.env.YUMEWEAVING_URL ||
  `http://localhost:${process.env.VITE_DEV_PORT ?? 5173}`;
const timeoutMs = Number(
  process.env.CHAPTERFLOW_OPEN_TIMEOUT_MS ?? process.env.YUMEWEAVING_OPEN_TIMEOUT_MS ?? 30_000
);

if (
  process.env.CHAPTERFLOW_SKIP_OPEN === '1' ||
  process.env.YUMEWEAVING_SKIP_OPEN === '1' ||
  process.env.CI
) {
  process.exit(0);
}

await waitForServer(url, timeoutMs);

const browser = findAppModeBrowser();
if (browser) {
  spawn(browser, [`--app=${url}`, '--window-size=1180,860'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  process.exit(0);
}

spawn('cmd', ['/c', 'start', '', url], {
  detached: true,
  stdio: 'ignore',
}).unref();

console.warn('Chrome/Edge が見つからなかったため、既定ブラウザで開きました。');

async function waitForServer(targetUrl, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const res = await fetch(targetUrl, { method: 'HEAD' });
      if (res.ok || res.status < 500) return;
    } catch {
      // サーバー起動待ち
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${targetUrl} が ${timeout}ms 以内に起動しませんでした`);
}

function findAppModeBrowser() {
  const candidates = [
    process.env.CHAPTERFLOW_BROWSER ?? process.env.YUMEWEAVING_BROWSER,
    pathFromEnv('LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'),
    pathFromEnv('PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'),
    pathFromEnv('PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'),
    pathFromEnv('LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'),
    pathFromEnv('PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'),
    pathFromEnv('PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function pathFromEnv(envName, suffix) {
  const base = process.env[envName];
  return base ? `${base}\\${suffix}` : '';
}
