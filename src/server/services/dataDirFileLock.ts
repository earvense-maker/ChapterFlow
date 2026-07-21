import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalizePath } from '../utils/pathSafety.js';

export const DATA_DIR_LOCK_FILE_NAME = '.chapterflow.lock';
const HEARTBEAT_INTERVAL_MS = 5_000;
const STALE_AFTER_MS = 45_000;

interface LockRecord {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

interface HeldLock {
  path: string;
  record: LockRecord;
  timer: ReturnType<typeof setInterval>;
  references: number;
}

const heldLocks = new Map<string, HeldLock>();

export class DataDirInUseError extends Error {
  constructor(message = 'この保存先は別の ChapterFlow で使用中です。') {
    super(message);
    this.name = 'DataDirInUseError';
  }
}

export async function acquireDataDirFileLock(dataDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(dataDir, { recursive: true });
  const canonicalDir = await canonicalizePath(dataDir);
  const key = process.platform === 'win32' ? canonicalDir.toLowerCase() : canonicalDir;
  const existingHeld = heldLocks.get(key);
  if (existingHeld) {
    existingHeld.references += 1;
    return createRelease(key, existingHeld);
  }

  const lockPath = path.join(canonicalDir, DATA_DIR_LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date().toISOString();
    const record: LockRecord = {
      id: randomUUID(),
      pid: process.pid,
      host: os.hostname(),
      startedAt: now,
      heartbeatAt: now,
    };
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
      } finally {
        await handle.close();
      }
      const held: HeldLock = {
        path: lockPath,
        record,
        references: 1,
        timer: setInterval(() => void refreshHeartbeat(lockPath, record), HEARTBEAT_INTERVAL_MS),
      };
      held.timer.unref?.();
      heldLocks.set(key, held);
      return createRelease(key, held);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (attempt === 0 && await removeStaleLock(lockPath)) continue;
      throw new DataDirInUseError();
    }
  }
  throw new DataDirInUseError();
}

export async function releaseAllDataDirFileLocks(): Promise<void> {
  await Promise.all([...heldLocks.keys()].map(async (key) => {
    const held = heldLocks.get(key);
    if (!held) return;
    held.references = 1;
    await createRelease(key, held)();
  }));
}

async function refreshHeartbeat(lockPath: string, record: LockRecord): Promise<void> {
  try {
    const current = JSON.parse(await fs.readFile(lockPath, 'utf8')) as LockRecord;
    if (current.id !== record.id) return;
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch {
    // The next operation or restart will surface/recover a missing or stale lock.
  }
}

function createRelease(key: string, held: HeldLock): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    held.references -= 1;
    if (held.references > 0) return;
    heldLocks.delete(key);
    clearInterval(held.timer);
    try {
      const current = JSON.parse(await fs.readFile(held.path, 'utf8')) as LockRecord;
      if (current.id === held.record.id) await fs.unlink(held.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  let record: Partial<LockRecord> | null = null;
  try {
    stat = await fs.stat(lockPath);
    try {
      record = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Partial<LockRecord>;
    } catch {
      record = null;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }

  const recordedHeartbeat = typeof record?.heartbeatAt === 'string'
    ? Date.parse(record.heartbeatAt)
    : Number.NaN;
  const heartbeatMs = Math.max(
    Number.isFinite(recordedHeartbeat) ? recordedHeartbeat : 0,
    stat.mtimeMs
  );
  const staleByAge = !Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > STALE_AFTER_MS;
  const sameHost = record?.host === os.hostname();
  const pid = typeof record?.pid === 'number' ? record.pid : null;
  const ownerDead = sameHost && pid !== null ? !isProcessAlive(pid) : false;
  if (!staleByAge && !ownerDead) return false;

  await fs.unlink(lockPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
