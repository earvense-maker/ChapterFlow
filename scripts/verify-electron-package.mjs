import { listPackage } from '@electron/asar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
export const defaultArchivePath = path.join(
  workspaceRoot,
  'release',
  'electron',
  'win-unpacked',
  'resources',
  'app.asar'
);
export const requiredPackageEntries = [
  'dist/client/index.html',
  'dist/electron/main.js',
  'dist/server/server.js',
  'dist/shared/defaults.js',
  // NOTE: 型定義はドメイン別に分割し、集約点は types/index.js（旧 types.js は廃止）。
  'dist/shared/types/index.js',
  'package.json',
  'presets/default-presets.json',
];

export function normalizePackageEntry(entry) {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function findMissingPackageEntries(
  archiveEntries,
  requiredEntries = requiredPackageEntries
) {
  const normalizedEntries = new Set(
    Array.from(archiveEntries, normalizePackageEntry)
  );
  return requiredEntries.filter(
    (entry) => !normalizedEntries.has(normalizePackageEntry(entry))
  );
}

export function verifyPackageEntries(
  archiveEntries,
  requiredEntries = requiredPackageEntries
) {
  const missingEntries = findMissingPackageEntries(archiveEntries, requiredEntries);
  if (missingEntries.length > 0) {
    throw new Error(
      `Electronパッケージに必要なファイルがありません: ${missingEntries.join(', ')}`
    );
  }
}

export function verifyArchive(
  archivePath,
  requiredEntries = requiredPackageEntries
) {
  const archiveEntries = listPackage(archivePath, {});
  verifyPackageEntries(archiveEntries, requiredEntries);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  verifyArchive(defaultArchivePath);
  console.log(`Electronパッケージの必須ファイルを確認しました: ${defaultArchivePath}`);
}
