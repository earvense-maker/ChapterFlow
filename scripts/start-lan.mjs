import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// NOTE: Keep LAN env setup in Node so cmd, PowerShell, and bash callers do not
// need separate environment-variable syntax.
const distEntry = path.resolve(process.cwd(), 'dist', 'server', 'index.js');

if (!existsSync(distEntry)) {
  console.error(
    '[start:lan] dist/server/index.js が見つかりません。開発環境では npm run build を実行してください。配布版では zip を展開し直してください。'
  );
  process.exit(1);
}

process.env.YUMEWEAVING_HOST = process.env.YUMEWEAVING_HOST ?? '0.0.0.0';

await import(pathToFileURL(distEntry).href);
