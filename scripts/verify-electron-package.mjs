import { listPackage } from '@electron/asar';
import path from 'node:path';

const archivePath = path.join(
  process.cwd(),
  'release',
  'electron',
  'win-unpacked',
  'resources',
  'app.asar'
);
const requiredEntries = [
  'dist/client/index.html',
  'dist/electron/main.js',
  'dist/server/server.js',
  'dist/shared/defaults.js',
  'dist/shared/types.js',
  'package.json',
  'presets/default-presets.json',
];
const archiveEntries = new Set(
  listPackage(archivePath, {}).map((entry) =>
    entry.replaceAll('\\', '/').replace(/^\/+/, '')
  )
);
const missingEntries = requiredEntries.filter((entry) => !archiveEntries.has(entry));

if (missingEntries.length > 0) {
  throw new Error(
    `Electronパッケージに必要なファイルがありません: ${missingEntries.join(', ')}`
  );
}

console.log(`Electronパッケージの必須ファイルを確認しました: ${archivePath}`);
