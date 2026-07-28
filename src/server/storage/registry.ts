import { createFileProjectStorage } from './fileProjectStorage.js';
import type { ProjectStorage } from './projectStorage.js';

let installed: ProjectStorage | null = null;

/**
 * 使用中の保存実装を返す。
 *
 * NOTE: 既定を `FileStorage` にしているのは、Electron 版の起動経路を1行も変えずに
 * 契約を挿すため（Phase 0 の完了条件）。
 *
 * NOTE(web-phase2): この既定は `fileProjectStorage` を静的に読み込むので、公開Web版から
 * そのまま使うと `node:fs` 依存が Web ビルドへ入ってしまう。Web 側は起動時に
 * `installProjectStorage(WebStorage)` で明示注入し、既定へ落ちないようにすること。
 * Phase 2 で WebStorage を追加するときに、既定の遅延読み込み化かレジストリ分割を行う。
 */
export function getProjectStorage(): ProjectStorage {
  if (!installed) {
    installed = createFileProjectStorage();
  }
  return installed;
}

export function installProjectStorage(storage: ProjectStorage): void {
  installed = storage;
}

export function resetProjectStorage(): void {
  installed = null;
}
