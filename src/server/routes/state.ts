import { Router } from 'express';
import * as stateService from '../services/stateService.js';
import { withProjectWriteLock } from '../services/generationService.js';
import type { ProjectState } from '../types/index.js';

const router = Router();

router.get('/projects/:id/state', async (req, res, next) => {
  try {
    const state = await stateService.readState(req.params.id);
    if (!state) return res.status(404).json({ error: 'State not found' });
    res.json(state);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/state', async (req, res, next) => {
  try {
    const updates = parseProjectStateUpdates(req.body);
    const state = await withProjectWriteLock(req.params.id, () =>
      stateService.updateState(req.params.id, updates)
    );
    res.json(state);
  } catch (err) {
    if (err instanceof StateValidationError) {
      return res.status(400).json({
        error: err.message,
        code: 'invalid_project_state',
        retryable: false,
      });
    }
    next(err);
  }
});

export default router;

const STATE_ID_MAX_CHARS = 200;
const STATE_ID_MAX_ITEMS = 1_000;

class StateValidationError extends Error {}

function parseProjectStateUpdates(value: unknown): Partial<ProjectState> {
  if (!isRecord(value)) {
    throw new StateValidationError('作品状態の形式が不正です。');
  }
  const updates: Partial<ProjectState> = {};

  for (const key of [
    'currentEpisodeId',
    'currentSceneId',
    'selectedDraftGenerationId',
    'lastAcceptedGenerationId',
  ] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const id = value[key];
    if (
      id !== null &&
      (typeof id !== 'string' || !id || id.length > STATE_ID_MAX_CHARS)
    ) {
      throw new StateValidationError(`${key}が不正です。`);
    }
    updates[key] = id;
  }

  if (Object.hasOwn(value, 'lastOpenedAt')) {
    if (
      typeof value.lastOpenedAt !== 'string' ||
      !value.lastOpenedAt ||
      value.lastOpenedAt.length > 100 ||
      !Number.isFinite(Date.parse(value.lastOpenedAt))
    ) {
      throw new StateValidationError('lastOpenedAtが不正です。');
    }
    updates.lastOpenedAt = value.lastOpenedAt;
  }

  if (Object.hasOwn(value, 'pendingMemoryCandidateIds')) {
    if (
      !Array.isArray(value.pendingMemoryCandidateIds) ||
      value.pendingMemoryCandidateIds.length > STATE_ID_MAX_ITEMS ||
      !value.pendingMemoryCandidateIds.every(
        (id) => typeof id === 'string' && id.length > 0 && id.length <= STATE_ID_MAX_CHARS
      )
    ) {
      throw new StateValidationError('pendingMemoryCandidateIdsが不正です。');
    }
    updates.pendingMemoryCandidateIds = [...value.pendingMemoryCandidateIds];
  }

  if (Object.hasOwn(value, 'storyStateRefresh')) {
    const refresh = value.storyStateRefresh;
    if (
      !isRecord(refresh) ||
      (refresh.status !== 'fresh' && refresh.status !== 'pending' && refresh.status !== 'stale') ||
      (refresh.generationId !== null &&
        (typeof refresh.generationId !== 'string' ||
          !refresh.generationId ||
          refresh.generationId.length > STATE_ID_MAX_CHARS)) ||
      typeof refresh.updatedAt !== 'string' ||
      !refresh.updatedAt ||
      refresh.updatedAt.length > 100 ||
      !Number.isFinite(Date.parse(refresh.updatedAt)) ||
      (refresh.errorMessage !== undefined &&
        (typeof refresh.errorMessage !== 'string' || refresh.errorMessage.length > 2_000))
    ) {
      throw new StateValidationError('storyStateRefreshが不正です。');
    }
    updates.storyStateRefresh = {
      status: refresh.status,
      generationId: refresh.generationId,
      updatedAt: refresh.updatedAt,
      ...(refresh.errorMessage !== undefined ? { errorMessage: refresh.errorMessage } : {}),
    };
  }

  if (Object.hasOwn(value, 'uiState')) {
    if (!isRecord(value.uiState)) {
      throw new StateValidationError('uiStateが不正です。');
    }
    const uiState: Partial<ProjectState['uiState']> = {};
    if (Object.hasOwn(value.uiState, 'readingPosition')) {
      if (
        typeof value.uiState.readingPosition !== 'number' ||
        !Number.isFinite(value.uiState.readingPosition) ||
        value.uiState.readingPosition < 0 ||
        value.uiState.readingPosition > 1_000_000_000
      ) {
        throw new StateValidationError('readingPositionが不正です。');
      }
      uiState.readingPosition = value.uiState.readingPosition;
    }
    if (Object.hasOwn(value.uiState, 'fontSize')) {
      if (
        typeof value.uiState.fontSize !== 'number' ||
        !Number.isFinite(value.uiState.fontSize) ||
        value.uiState.fontSize < 8 ||
        value.uiState.fontSize > 96
      ) {
        throw new StateValidationError('fontSizeが不正です。');
      }
      uiState.fontSize = value.uiState.fontSize;
    }
    if (Object.keys(uiState).length === 0) {
      throw new StateValidationError('uiStateに更新項目がありません。');
    }
    updates.uiState = uiState as ProjectState['uiState'];
  }

  if (Object.keys(updates).length === 0) {
    throw new StateValidationError('更新する作品状態がありません。');
  }
  return updates;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
