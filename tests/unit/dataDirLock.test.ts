import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DataDirBusyError,
  DataDirLockedError,
  withDataDirLock,
  withDataDirWrite,
} from '../../src/server/services/dataDirLock';
import { safeWriteFile } from '../../src/server/utils/safeWrite';

describe('dataDirLock', () => {
  it('rejects new writes while the data directory is locked', async () => {
    let releaseLock!: () => void;
    const lockPromise = withDataDirLock(
      () => new Promise<void>((resolve) => {
        releaseLock = resolve;
      })
    );
    try {
      await Promise.resolve();
      await expect(withDataDirWrite(async () => undefined)).rejects.toBeInstanceOf(
        DataDirLockedError
      );
    } finally {
      releaseLock?.();
      await lockPromise.catch(() => undefined);
    }
  });

  it('waits for active writes before running the locked section', async () => {
    const events: string[] = [];
    let releaseWrite!: () => void;

    const writePromise = withDataDirWrite(async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      events.push('write-end');
    });

    const lockPromise = withDataDirLock(async () => {
      events.push('lock-body');
    });

    await Promise.resolve();
    expect(events).toEqual(['write-start']);

    releaseWrite();
    await Promise.all([writePromise, lockPromise]);
    expect(events).toEqual(['write-start', 'write-end', 'lock-body']);
  });

  it('allows nested writes inside a write that started before the lock', async () => {
    const events: string[] = [];
    let continueWrite!: () => void;

    const writePromise = withDataDirWrite(async () => {
      events.push('write-start');
      await new Promise<void>((resolve) => {
        continueWrite = resolve;
      });
      await withDataDirWrite(async () => {
        events.push('nested-write');
      });
      events.push('write-end');
    });

    const lockPromise = withDataDirLock(async () => {
      events.push('lock-body');
    });

    await Promise.resolve();
    continueWrite();
    await Promise.all([writePromise, lockPromise]);

    expect(events).toEqual(['write-start', 'nested-write', 'write-end', 'lock-body']);
  });

  it('rejects with a busy error when active writes do not finish before the lock timeout', async () => {
    let releaseWrite!: () => void;
    const writePromise = withDataDirWrite(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      })
    );

    await expect(
      withDataDirLock(async () => undefined, { waitTimeoutMs: 5 })
    ).rejects.toBeInstanceOf(DataDirBusyError);

    releaseWrite();
    await writePromise;
  });

  it('protects direct safeWriteFile calls while the data directory is locked', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-safe-write-lock-'));
    let releaseLock!: () => void;
    const lockPromise = withDataDirLock(
      () => new Promise<void>((resolve) => {
        releaseLock = resolve;
      })
    );
    try {
      await Promise.resolve();
      await expect(safeWriteFile(path.join(dir, 'blocked.txt'), 'blocked')).rejects.toBeInstanceOf(
        DataDirLockedError
      );
      releaseLock();
      await lockPromise;
    } finally {
      releaseLock?.();
      await lockPromise.catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
