import net from 'node:net';
import { pathToFileURL } from 'node:url';

// NOTE: 古いdevインスタンスが5173に残っていると、Viteは別ポートへ逃げる一方で
// アプリウィンドウは5173（＝古いインスタンス、別のデータディレクトリのことも）を
// 開いてしまい「作品が消えた」ように見える事故が起きた(2026-07-16)。
// 起動前にポートを検査し、ウィンドウを開く前に明確に中止・案内する。

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

export async function findBusyDevPorts(env = process.env) {
  const vitePort = Number(env.VITE_DEV_PORT ?? 5173);
  const serverPort = Number(env.PORT ?? 3001);
  const busy = [];
  for (const port of [...new Set([vitePort, serverPort])]) {
    if (!(await isPortFree(port))) busy.push(port);
  }
  return busy;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const busy = await findBusyDevPorts();
  if (busy.length > 0) {
    console.error('');
    console.error(
      `[ChapterFlow] 起動を中止しました: ポート ${busy.join(', ')} が既に使用中です。`
    );
    console.error(
      '別の ChapterFlow が起動中なら、既に開いているウィンドウをそのまま使ってください。'
    );
    console.error('残ったプロセスを停止して起動し直す場合は PowerShell で:');
    for (const port of busy) {
      console.error(
        `  Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port}).OwningProcess -Force`
      );
    }
    console.error('');
    process.exit(1);
  }
}
