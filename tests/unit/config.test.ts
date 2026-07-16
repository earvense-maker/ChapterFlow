import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveDefaultDataDir } from '../../src/server/config';

describe('resolveDefaultDataDir', () => {
  const homeDir = path.resolve('C:/Users/tester');
  const chapterFlowDir = path.join(homeDir, 'Documents', 'ChapterFlow');
  const legacyDir = path.join(homeDir, 'Documents', 'Yumeweaving');

  it('uses ChapterFlow for a new installation', () => {
    expect(resolveDefaultDataDir(homeDir, () => false)).toBe(chapterFlowDir);
  });

  it('keeps using legacy Yumeweaving data when only the legacy folder exists', () => {
    expect(resolveDefaultDataDir(homeDir, (candidate) => candidate === legacyDir)).toBe(legacyDir);
  });

  it('keeps using legacy data when ChapterFlow exists but is empty', () => {
    expect(
      resolveDefaultDataDir(
        homeDir,
        () => true,
        (candidate) => candidate === path.join(legacyDir, 'projects')
      )
    ).toBe(legacyDir);
  });

  it('prefers ChapterFlow when both folders contain app data', () => {
    expect(resolveDefaultDataDir(homeDir, () => true, () => true)).toBe(chapterFlowDir);
  });

  it('keeps using legacy works when ChapterFlow has only config data', () => {
    // NOTE: APIキー保存だけで作られた config/ が旧作品を隠さないこと（利用ガイドの約束）。
    expect(
      resolveDefaultDataDir(
        homeDir,
        () => true,
        (candidate) =>
          candidate === path.join(chapterFlowDir, 'config') ||
          candidate === path.join(legacyDir, 'projects')
      )
    ).toBe(legacyDir);
  });
});
