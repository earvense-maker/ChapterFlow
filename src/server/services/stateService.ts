import { localProjectStorage } from '../storage/boundProjectStorage.js';
import type { ProjectState } from '../types/index.js';

// NOTE(web-phase1): 保存層は契約経由（設計書 4.2）。Phase 1 でリクエスト由来の
// UserContext に差し替える。
const storage = localProjectStorage();

export async function readState(projectId: string): Promise<ProjectState | null> {
  return storage.readState(projectId);
}

export async function writeState(projectId: string, state: ProjectState): Promise<void> {
  await storage.writeState(projectId, state);
}

export async function updateState(
  projectId: string,
  updates: Partial<ProjectState>
): Promise<ProjectState> {
  const state = await storage.readState(projectId);
  if (!state) throw new Error(`State not found: ${projectId}`);
  const { storyStateBacklogCount: _storyStateBacklogCount, ...persistableUpdates } = updates;
  const next: ProjectState = {
    ...state,
    ...persistableUpdates,
    uiState: updates.uiState ? { ...state.uiState, ...updates.uiState } : state.uiState,
  };
  await storage.writeState(projectId, next);
  return next;
}
