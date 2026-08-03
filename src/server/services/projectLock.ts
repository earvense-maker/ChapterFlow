import { withDataDirWrite } from './dataDirLock.js';
import { KeyedMutex } from '../utils/keyedMutex.js';

// NOTE: 「プロジェクトごとの書き込み排他」。generationService からここへ切り出したのは、
// refineAutomationGuard など生成の外から lease 回復のために writeState したい経路が
// 生まれ、そのために generationService → refineAutomationGuard → generationService の
// 循環 import を避ける必要があったため。ロック挙動は移設前と同じ（re-entrant ではない）。
const projectWriteMutex = new KeyedMutex();

// NOTE: テスト専用の可観測点。「ロック待ちに入った後で maintenance slot を
// 読み直す」経路は、待ち状態に入った瞬間を外から観測できないと setTimeout(0) 頼みの
// 不安定なテストになる。dataDirLock の resetDataDirRestartPendingForTests と同じ方針。
export function getProjectWriteWaiterCountForTests(projectId: string): number {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Project write waiter count can only be read in tests');
  }
  return projectWriteMutex.waiterCount(projectId);
}

export async function withProjectWriteLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  return projectWriteMutex.runExclusive(projectId, () => withDataDirWrite(task));
}
