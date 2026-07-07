import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// NOTE: tests/setup.ts が全ワーカーで同じ一時データディレクトリを指すので、
// 実行前に前回の残骸を消して毎回まっさらな状態から始める。終了後も消す。
// パスは tests/setup.ts の代入と一致させること。
const TEST_DATA_DIR = path.join(os.tmpdir(), 'yumeweaving-vitest');

export default async function globalSetup(): Promise<() => Promise<void>> {
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  return async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true });
  };
}
