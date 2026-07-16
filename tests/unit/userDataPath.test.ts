import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveUserDataPath } from '../../src/electron/userDataPath';

describe('resolveUserDataPath', () => {
  const appDataDir = path.resolve('C:/Users/tester/AppData/Roaming');
  const chapterFlowDir = path.join(appDataDir, 'ChapterFlow');
  const legacyDir = path.join(appDataDir, 'Yumeweaving');

  it('uses ChapterFlow for a new installation', () => {
    expect(resolveUserDataPath(appDataDir, () => false)).toBe(chapterFlowDir);
  });

  it('keeps the legacy profile when the new profile is empty', () => {
    expect(
      resolveUserDataPath(
        appDataDir,
        (candidate) => candidate === chapterFlowDir || candidate === legacyDir,
        (candidate) => candidate === path.join(legacyDir, 'Local Storage')
      )
    ).toBe(legacyDir);
  });

  it('prefers ChapterFlow once the new profile contains user state', () => {
    expect(
      resolveUserDataPath(
        appDataDir,
        (candidate) =>
          candidate === chapterFlowDir ||
          candidate === legacyDir ||
          candidate === path.join(chapterFlowDir, 'app-settings.json'),
        () => false
      )
    ).toBe(chapterFlowDir);
  });
});
