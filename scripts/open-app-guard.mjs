import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// NOTE: ウィンドウを開くだけの補助スクリプトが死んだせいで、健全なサーバーと Vite まで
// concurrently --kill-others-on-fail に巻き込まれて停止した(2026-07-27)。ウィンドウが
// 開かないことと、サーバーが落ちて執筆が中断することは重さが違う。別プロセスで包んで
// 失敗を吸収し、dev 本体は動かし続ける。ネイティブクラッシュ(0xC0000409)も終了コードとして
// 受け取れるよう、in-process の try/catch ではなく子プロセスとして起動する。

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OPENER_PATH = path.resolve(__dirname, '..', 'open-app-window.js');

export function describeFailure(code, signal) {
  if (signal) return `シグナル ${signal} で終了しました`;
  // 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN) 等、Windows のネイティブ自爆は10進で出ると
  // 読めないので16進も添える。
  if (code > 0xffff) return `終了コード ${code} (0x${code.toString(16).toUpperCase()}) で異常終了しました`;
  return `終了コード ${code} で終了しました`;
}

export function runOpener(argv = [], spawnImpl = spawn) {
  const child = spawnImpl(process.execPath, [OPENER_PATH, ...argv], { stdio: 'inherit' });

  child.on('error', (err) => {
    console.warn(`[ChapterFlow] ウィンドウを開けませんでした: ${err.message}`);
    console.warn('[ChapterFlow] サーバーは動作しています。ブラウザで手動で開いてください。');
  });

  child.on('exit', (code, signal) => {
    if (code === 0) return;
    console.warn(`[ChapterFlow] ウィンドウ起動処理が${describeFailure(code, signal)}。`);
    console.warn('[ChapterFlow] サーバーは動作しています。ブラウザで手動で開いてください。');
  });

  return child;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// NOTE: 子の結果に関わらず常に 0 で終わることがこのスクリプトの存在理由。
if (isMain) runOpener(process.argv.slice(2));
