import * as storage from './storageService.js';
import type { ProjectState } from '../types/index.js';

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
  const next: ProjectState = {
    ...state,
    ...updates,
    uiState: updates.uiState ? { ...state.uiState, ...updates.uiState } : state.uiState,
  };
  await storage.writeState(projectId, next);
  return next;
}
