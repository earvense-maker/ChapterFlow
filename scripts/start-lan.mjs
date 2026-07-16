import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// NOTE: Keep LAN env setup in Node so cmd, PowerShell, and bash callers do not
// need separate environment-variable syntax.
const distEntry = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

if (!existsSync(distEntry)) {
  console.error(
    '[start:lan] dist/server/index.js が見つかりません。npm run build を実行してから、もう一度 LAN モードを起動してください。'
  );
  process.exit(1);
}

process.env.CHAPTERFLOW_HOST =
  process.env.CHAPTERFLOW_HOST ?? process.env.YUMEWEAVING_HOST ?? '0.0.0.0';

await import(pathToFileURL(distEntry).href);
