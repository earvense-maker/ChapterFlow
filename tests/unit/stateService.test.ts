import { afterEach, describe, expect, it } from 'vitest';
import * as stateService from '../../src/server/services/stateService';
import * as storage from '../../src/server/services/storageService';
import type { ProjectState } from '../../src/server/types/index';

let seq = 0;
const trackedProjectIds: string[] = [];

function baseState(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
    currentEpisodeId: 'ep-1',
    currentSceneId: 'scene-1',
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    uiState: { readingPosition: 100, fontSize: 16 },
    ...overrides,
  };
}

async function createProjectWithState(state = baseState()): Promise<string> {
  seq += 1;
  const projectId = `state-${process.pid}-${seq}`;
  trackedProjectIds.push(projectId);
  await storage.createProjectDir(projectId);
  await stateService.writeState(projectId, state);
  return projectId;
}

afterEach(async () => {
  await Promise.all(trackedProjectIds.map((id) => storage.deleteProjectDir(id)));
  trackedProjectIds.length = 0;
});

describe('readState / writeState', () => {
  it('round-trips the state document', async () => {
    const state = baseState();
    const projectId = await createProjectWithState(state);

    expect(await stateService.readState(projectId)).toEqual(state);
  });

  it('returns null for a project that has no state file', async () => {
    seq += 1;
    const projectId = `state-empty-${process.pid}-${seq}`;
    trackedProjectIds.push(projectId);
    await storage.createProjectDir(projectId);

    expect(await stateService.readState(projectId)).toBeNull();
  });
});

describe('updateState', () => {
  it('applies partial updates and leaves untouched fields alone', async () => {
    const projectId = await createProjectWithState();

    const next = await stateService.updateState(projectId, {
      currentEpisodeId: 'ep-2',
      lastAcceptedGenerationId: 'gen-9',
    });

    expect(next.currentEpisodeId).toBe('ep-2');
    expect(next.lastAcceptedGenerationId).toBe('gen-9');
    expect(next.currentSceneId).toBe('scene-1');
    expect(await stateService.readState(projectId)).toEqual(next);
  });

  it('merges uiState instead of replacing the whole object', async () => {
    const projectId = await createProjectWithState();

    const next = await stateService.updateState(projectId, {
      uiState: { readingPosition: 640 } as ProjectState['uiState'],
    });

    // NOTE: ここが浅いマージでないと、読書位置だけ保存したつもりで
    // 文字サイズ設定が初期値に巻き戻る。
    expect(next.uiState).toEqual({ readingPosition: 640, fontSize: 16 });
  });

  it('keeps the stored uiState when the update omits it', async () => {
    const projectId = await createProjectWithState();

    const next = await stateService.updateState(projectId, { currentSceneId: 'scene-2' });

    expect(next.uiState).toEqual({ readingPosition: 100, fontSize: 16 });
  });

  it('does not persist the derived storyStateBacklogCount field', async () => {
    const projectId = await createProjectWithState();

    const next = await stateService.updateState(projectId, {
      storyStateBacklogCount: 5,
      currentSceneId: 'scene-3',
    });

    // NOTE: backlog 件数は毎回数え直す派生値。state.json に焼き付けると
    // 実態とずれた古い件数が UI に出続ける。
    expect(next.storyStateBacklogCount).toBeUndefined();
    expect((await stateService.readState(projectId))?.storyStateBacklogCount).toBeUndefined();
    expect(next.currentSceneId).toBe('scene-3');
  });

  it('accepts explicit null values for the id fields', async () => {
    const projectId = await createProjectWithState(
      baseState({ selectedDraftGenerationId: 'gen-draft' })
    );

    const next = await stateService.updateState(projectId, { selectedDraftGenerationId: null });

    expect(next.selectedDraftGenerationId).toBeNull();
  });

  it('throws when the project has no state to update', async () => {
    seq += 1;
    const projectId = `state-missing-${process.pid}-${seq}`;
    trackedProjectIds.push(projectId);
    await storage.createProjectDir(projectId);

    await expect(stateService.updateState(projectId, { currentSceneId: 'x' })).rejects.toThrow(
      `State not found: ${projectId}`
    );
  });
});
