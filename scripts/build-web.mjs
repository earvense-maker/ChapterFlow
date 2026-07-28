import { spawnSync } from 'node:child_process';
import { copyFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NOTE: 公開Web版のビルドは Electron 版の dist/ に一切触れない。出力先を dist-web に
// 分けているのは、Web のデプロイ失敗が Electron の配布物を壊さないようにするため
// （設計書 4.1）。electron-builder の files 一覧にも dist-web は入れないこと。
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
const outDir = path.resolve(workspaceRoot, 'dist-web');
const webAppDir = path.resolve(workspaceRoot, 'apps', 'web');

if (path.dirname(outDir) !== workspaceRoot || path.basename(outDir) !== 'dist-web') {
  throw new Error(`Unexpected web output path: ${outDir}`);
}

await rm(outDir, { recursive: true, force: true });

// NOTE: npx 経由だと Windows のシェル解決に依存して失敗する。ローカルの
// typescript を node で直接実行し、シェルを挟まない。
const tscEntry = createRequire(import.meta.url).resolve('typescript/lib/tsc.js');
const tsc = spawnSync(process.execPath, [tscEntry, '-p', path.join(webAppDir, 'tsconfig.json')], {
  stdio: 'inherit',
  cwd: workspaceRoot,
});
if (tsc.error) throw tsc.error;
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

// NOTE: /api/system/version が返すバージョンの取得元。dev と dist で
// モジュールから見た相対位置を揃えるため、dist-web 直下へ置く（apps/web/src/config.ts）。
await copyFile(path.join(webAppDir, 'package.json'), path.join(outDir, 'package.json'));

process.stdout.write(`web build: ${outDir}\n`);
