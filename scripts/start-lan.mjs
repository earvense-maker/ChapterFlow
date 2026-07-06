// LAN 配信モード用エントリ。
// YUMEWEAVING_HOST=0.0.0.0 を設定して dist/server/index.js を起動する。
// NOTE: シェル差(cmd/PowerShell/bash)による env 設定の書き分けを避けるため、
//       Node スクリプト経由で統一している。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distEntry = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

if (!existsSync(distEntry)) {
  console.error('[start:lan] dist/server/index.js が見つかりません。先に `npm run build` を実行してください。');
  process.exit(1);
}

process.env.YUMEWEAVING_HOST = process.env.YUMEWEAVING_HOST ?? '0.0.0.0';

await import(pathToFileURL(distEntry).href);
