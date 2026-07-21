import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDataDirFileLock,
  DATA_DIR_LOCK_FILE_NAME,
  DataDirInUseError,
  releaseAllDataDirFileLocks,
} from '../../src/server/services/dataDirFileLock';

const tempDirs: string[] = [];

afterEach(async () => {
  await releaseAllDataDirFileLocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('dataDirFileLock', () => {
  it('rejects a fresh lock owned by another ChapterFlow process', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-file-lock-'));
    tempDirs.push(dataDir);
    const now = new Date().toISOString();
    await fs.writeFile(path.join(dataDir, DATA_DIR_LOCK_FILE_NAME), JSON.stringify({
      id: 'other',
      pid: process.pid,
      host: os.hostname(),
      startedAt: now,
      heartbeatAt: now,
    }));

    await expect(acquireDataDirFileLock(dataDir)).rejects.toBeInstanceOf(DataDirInUseError);
  });

  it('recovers a stale lock whose local owner is no longer running', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-stale-lock-'));
    tempDirs.push(dataDir);
    const old = new Date(Date.now() - 120_000).toISOString();
    await fs.writeFile(path.join(dataDir, DATA_DIR_LOCK_FILE_NAME), JSON.stringify({
      id: 'stale',
      pid: 2_147_483_647,
      host: os.hostname(),
      startedAt: old,
      heartbeatAt: old,
    }));

    const release = await acquireDataDirFileLock(dataDir);
    await release();
    await expect(fs.stat(path.join(dataDir, DATA_DIR_LOCK_FILE_NAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps the lock file until every same-process owner releases it', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-shared-lock-'));
    tempDirs.push(dataDir);
    const releaseFirst = await acquireDataDirFileLock(dataDir);
    const releaseSecond = await acquireDataDirFileLock(dataDir);

    await releaseFirst();
    await expect(fs.stat(path.join(dataDir, DATA_DIR_LOCK_FILE_NAME))).resolves.toBeDefined();
    await releaseSecond();
    await expect(fs.stat(path.join(dataDir, DATA_DIR_LOCK_FILE_NAME))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
