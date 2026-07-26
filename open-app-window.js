import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function openAppWindow() {
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
    return;
  }

  const deadline = Date.now() + timeoutMs;

  if (!(await waitForResponse(url, deadline))) {
    throw new Error(`${url} が ${timeoutMs}ms 以内に起動しませんでした`);
  }

  // NOTE: dev では Vite が数百msで ready になる一方、API サーバー(tsx watch)の起動には
  // 数秒かかる。URL の応答だけを見て開くと初回の /api/* が proxy ECONNREFUSED で落ち、
  // 作品一覧のエラー表示や通知設定の取得失敗(その mount の間ずっと通知が無効)になる。
  // API 側が応答するまで待ってからウィンドウを開く。
  if (!(await waitForResponse(new URL('/api/system/version', url).toString(), deadline))) {
    // NOTE: ここで中断すると concurrently --kill-others-on-fail が dev 全体を落とすため、
    // 待ちきれなくてもウィンドウは開く（従来と同じ挙動）。
    console.warn('APIサーバーの応答を確認できませんでした。表示が崩れる場合は再読み込みしてください。');
  }

  const browser = findAppModeBrowser();
  if (browser) {
    launchDetachedBrowser(browser, url);
    // NOTE: process.exit() で強制終了すると、Node 24 / Windows では fetch や child_process
    // の終了処理と競合して libuv の UV_HANDLE_CLOSING assertion で落ちることがある。
    // child は unref 済みなので、ここから自然終了させれば待ち時間は増えない。
    return;
  }

  launchDetachedBrowser('cmd', url, ['/c', 'start', '', url]);

  console.warn('Chrome/Edge が見つからなかったため、既定ブラウザで開きました。');
}

export function launchDetachedBrowser(
  executable,
  url,
  args = [`--app=${url}`, '--window-size=1180,860'],
  spawnImpl = spawn
) {
  const child = spawnImpl(executable, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// NOTE: 5xx は「まだ準備できていない」扱い。Vite の proxy は API に繋がらない間 5xx を
// 返すので、これで API 起動待ちを表現できる。401/404 等は到達している証拠なので ready 扱い。
async function waitForResponse(targetUrl, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(targetUrl, { method: 'HEAD' });
      if (res.status < 500) return true;
    } catch {
      // サーバー起動待ち
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await openAppWindow();
