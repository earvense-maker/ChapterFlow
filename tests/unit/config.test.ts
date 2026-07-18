import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveDefaultDataDir } from '../../src/server/config';

describe('resolveDefaultDataDir', () => {
  const homeDir = path.resolve('C:/Users/tester');
  const chapterFlowDir = path.join(homeDir, 'Documents', 'ChapterFlow');

  it('always uses ChapterFlow as the default data directory', () => {
    expect(resolveDefaultDataDir(homeDir)).toBe(chapterFlowDir);
  });
});
