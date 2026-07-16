import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  hasDirectoryEntries,
  resolvePreferredDirWithLegacy,
} from '../server/utils/legacyDirResolver.js';

export function resolveUserDataPath(
  appDataDir: string,
  pathExists: (filePath: string) => boolean = existsSync,
  directoryHasEntries: (directoryPath: string) => boolean = hasDirectoryEntries
): string {
  const chapterFlowDir = path.join(appDataDir, 'ChapterFlow');
  const legacyDir = path.join(appDataDir, 'Yumeweaving');
  // NOTE: 起動失敗などで空の新プロファイルだけが残っても、旧設定とブラウザ保存状態を引き継ぐ。
  const containsUserState = (userDataDir: string) =>
    [
      path.join(userDataDir, 'app-settings.json'),
      path.join(userDataDir, 'Cookies'),
      path.join(userDataDir, 'Network', 'Cookies'),
    ].some(pathExists) ||
    ['Local Storage', 'Session Storage', 'IndexedDB'].some((name) =>
      directoryHasEntries(path.join(userDataDir, name))
    );

  return resolvePreferredDirWithLegacy(
    chapterFlowDir,
    legacyDir,
    [containsUserState],
    pathExists
  );
}
