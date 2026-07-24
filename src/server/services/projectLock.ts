import { withDataDirWrite } from './dataDirLock.js';

// NOTE: 「プロジェクトごとの書き込み排他」を実現する promise-chain mutex。
// generationService からここへ切り出したのは、refineAutomationGuard など生成の
// 外から lease 回復のために writeState したい経路が生まれ、そのために
// generationService → refineAutomationGuard → generationService の循環 import を
// 避ける必要があったため。ロック挙動は移設前と同じ（re-entrant ではない）。
const projectWriteMutexes = new Map<string, Promise<void>>();
const projectWriteWaiters = new Map<string, number>();

// NOTE: テスト専用の可観測点。「ロック待ちに入った後で maintenance slot を
// 読み直す」経路は、待ち状態に入った瞬間を外から観測できないと setTimeout(0) 頼みの
// 不安定なテストになる。dataDirLock の resetDataDirRestartPendingForTests と同じ方針。
export function getProjectWriteWaiterCountForTests(projectId: string): number {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Project write waiter count can only be read in tests');
  }
  return projectWriteWaiters.get(projectId) ?? 0;
}

function trackWaiter(projectId: string, delta: number): void {
  const next = (projectWriteWaiters.get(projectId) ?? 0) + delta;
  if (next > 0) projectWriteWaiters.set(projectId, next);
  else projectWriteWaiters.delete(projectId);
}

export async function withProjectWriteLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = projectWriteMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  projectWriteMutexes.set(projectId, next);

  trackWaiter(projectId, 1);
  try {
    await previous.catch(() => undefined);
  } finally {
    trackWaiter(projectId, -1);
  }
  try {
    return await withDataDirWrite(task);
  } finally {
    release();
    if (projectWriteMutexes.get(projectId) === next) {
      projectWriteMutexes.delete(projectId);
    }
  }
}
