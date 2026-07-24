import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptDir, '..');
const distPath = path.resolve(workspaceRoot, 'dist');

// NOTE: ビルド成果物の削除先を workspace 直下の dist に固定する。
// tsc は outDir を掃除しないため、型やサービスを移動した後も旧 JS が残り、
// Electron パッケージ検証を誤って通すことがある。
if (path.dirname(distPath) !== workspaceRoot || path.basename(distPath) !== 'dist') {
  throw new Error(`Unexpected dist path: ${distPath}`);
}

await rm(distPath, { recursive: true, force: true });
