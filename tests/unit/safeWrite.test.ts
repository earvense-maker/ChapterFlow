import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWriteFile, safeWriteJson, readJsonFile, readTextFile } from '../../src/server/utils/safeWrite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, 'tmp-safe-write');

beforeEach(async () => {
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('safeWrite', () => {
  it('writes JSON safely', async () => {
    const filePath = path.join(testDir, 'data.json');
    await safeWriteJson(filePath, { foo: 'bar' });
    const read = await readJsonFile<{ foo: string }>(filePath);
    expect(read).toEqual({ foo: 'bar' });
  });

  it('writes text safely', async () => {
    const filePath = path.join(testDir, 'text.txt');
    await safeWriteFile(filePath, 'hello');
    const read = await readTextFile(filePath);
    expect(read).toBe('hello');
  });

  it('returns null for missing files', async () => {
    const read = await readTextFile(path.join(testDir, 'missing.txt'));
    expect(read).toBeNull();
  });
});
