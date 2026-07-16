import { readdirSync } from 'node:fs';

// NOTE: リネーム移行期のディレクトリ選択を一箇所に集約する
// （作品データ: config.ts / Electronプロファイル: electron/userDataPath.ts）。
// 空の新フォルダが実データ入りの旧フォルダを隠さないよう、predicates を
// 優先度順に評価し、どちらにも実データがなければ「存在する方」→新フォルダの順。
// 自動移動（コピー・削除）はしない。
export function resolvePreferredDirWithLegacy(
  newDir: string,
  legacyDir: string,
  containsDataPredicates: Array<(dir: string) => boolean>,
  pathExists: (filePath: string) => boolean
): string {
  for (const containsData of containsDataPredicates) {
    if (containsData(newDir)) return newDir;
    if (containsData(legacyDir)) return legacyDir;
  }
  if (pathExists(newDir)) return newDir;
  return pathExists(legacyDir) ? legacyDir : newDir;
}

export function hasDirectoryEntries(directoryPath: string): boolean {
  try {
    return readdirSync(directoryPath).length > 0;
  } catch {
    return false;
  }
}
