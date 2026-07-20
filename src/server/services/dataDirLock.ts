import { AsyncLocalStorage } from 'node:async_hooks';

let locked = false;
let restartPending = false;
let activeWrites = 0;
const waiters: Array<() => void> = [];
const writeScope = new AsyncLocalStorage<boolean>();
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 30_000;

export class DataDirLockedError extends Error {
  constructor(message = 'データ移動中のため、いまは書き込みできません。しばらく待ってから再試行してください。') {
    super(message);
    this.name = 'DataDirLockedError';
  }
}

export class DataDirBusyError extends DataDirLockedError {
  constructor(message = '生成や保存の処理中のため、データ移動を開始できません。完了後にもう一度お試しください。') {
    super(message);
    this.name = 'DataDirBusyError';
  }
}

export function isDataDirLocked(): boolean {
  return locked || restartPending;
}

export function hasActiveDataDirWrites(): boolean {
  return activeWrites > 0;
}

export function runOutsideDataDirWrite<T>(fn: () => T): T {
  return writeScope.run(false, fn);
}

export function markDataDirRestartPending(): void {
  restartPending = true;
}

export function resetDataDirRestartPendingForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Restart-pending state can only be reset in tests');
  }
  restartPending = false;
}

export async function withDataDirWrite<T>(fn: () => Promise<T>): Promise<T> {
  if (writeScope.getStore() === true) return fn();
  if (restartPending) {
    throw new DataDirLockedError(
      '保存先の切り替え後、再起動を待っているため書き込みできません。'
    );
  }
  if (locked) throw new DataDirLockedError();
  activeWrites += 1;
  try {
    return await writeScope.run(true, fn);
  } finally {
    activeWrites -= 1;
    if (activeWrites === 0) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  }
}

export async function withDataDirLock<T>(
  fn: () => Promise<T>,
  options: { waitTimeoutMs?: number } = {}
): Promise<T> {
  if (restartPending) {
    throw new DataDirLockedError('保存先の切り替え後、再起動を待っています。');
  }
  if (locked) throw new DataDirLockedError('別のデータ移動が進行中です。');
  locked = true;
  try {
    await waitForActiveWrites(options.waitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS);
    return await writeScope.run(true, fn);
  } finally {
    locked = false;
  }
}

async function waitForActiveWrites(timeoutMs: number): Promise<void> {
  if (activeWrites === 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resolveWaiter = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    waiters.push(resolveWaiter);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const index = waiters.indexOf(resolveWaiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DataDirBusyError());
      }, timeoutMs);
    }
  });
}
