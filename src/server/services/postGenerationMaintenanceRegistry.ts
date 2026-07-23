// NOTE: これは永続状態ではなく、同一プロセス内で同じ作品の自動走査を二重起動しない
// ためだけの軽量な台帳。再起動後は空になるため、lease の回復判定では
// ProjectState.refineMaintenance と組み合わせて使う。

const runningJobs = new Map<string, string>();

export function registerPostGenerationMaintenanceJob(projectId: string, runId: string): boolean {
  if (runningJobs.has(projectId)) return false;
  runningJobs.set(projectId, runId);
  return true;
}

export function unregisterPostGenerationMaintenanceJob(projectId: string, runId: string): void {
  if (runningJobs.get(projectId) === runId) {
    runningJobs.delete(projectId);
  }
}

export function isPostGenerationMaintenanceJobRunning(projectId: string, runId?: string): boolean {
  const currentRunId = runningJobs.get(projectId);
  return currentRunId !== undefined && (runId === undefined || currentRunId === runId);
}
