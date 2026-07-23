import { withDataDirWrite } from './dataDirLock.js';

// NOTE: 「プロジェクトごとの書き込み排他」を実現する promise-chain mutex。
// generationService からここへ切り出したのは、refineAutomationGuard など生成の
// 外から lease 回復のために writeState したい経路が生まれ、そのために
// generationService → refineAutomationGuard → generationService の循環 import を
// 避ける必要があったため。ロック挙動は移設前と同じ（re-entrant ではない）。
const projectWriteMutexes = new Map<string, Promise<void>>();

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

  await previous.catch(() => undefined);
  try {
    return await withDataDirWrite(task);
  } finally {
    release();
    if (projectWriteMutexes.get(projectId) === next) {
      projectWriteMutexes.delete(projectId);
    }
  }
}
