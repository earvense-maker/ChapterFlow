import { Router } from 'express';
import * as generationService from '../services/generationService.js';
import * as storage from '../services/storageService.js';
import * as storyStateService from '../services/storyStateService.js';
import * as refineAutomationService from '../services/refineAutomationService.js';
import * as ngRewriteService from '../services/ngRewriteService.js';
import * as generationTextRevisionService from '../services/generationTextRevisionService.js';
import { DataDirLockedError } from '../services/dataDirLock.js';
import { GENERATION_WISH_MAX_CHARS } from '../types/index.js';
import type { GenerateRequestBody, SceneNavigationDirection } from '../types/index.js';

const router = Router();

router.post('/projects/:id/generate', async (req, res, next) => {
  try {
    const body = parseGenerateRequest(req.body);
    await assertViewpointCharacterExists(req.params.id, body.viewpointCharacterId);
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: body.mode,
      viewpointCharacterId: body.viewpointCharacterId ?? null,
      ...(body.amplifierInteractionId
        ? { amplifierInteractionId: body.amplifierInteractionId }
        : {}),
      ...(body.amplifierOperationId ? { amplifierOperationId: body.amplifierOperationId } : {}),
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
    }
    if (err instanceof InvalidViewpointCharacterError) {
      return res.status(400).json({ error: err.message, code: err.code, retryable: false });
    }
    if (err instanceof refineAutomationService.RefineAutomationError) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    if (err instanceof generationService.GenerateError) {
      console.warn('Generation failed', {
        projectId: req.params.id,
        code: err.code,
        retryable: err.retryable,
        message: err.message,
      });
      return res.status(503).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    next(err);
  }
});

router.post('/projects/:id/generate-stream', async (req, res) => {
  let body: GenerateRequestBody;
  try {
    body = parseGenerateRequest(req.body);
  } catch (err) {
    const message =
      err instanceof GenerateRequestValidationError ? err.message : '生成リクエストが不正です。';
    res.status(400).json({ error: message, code: 'invalid_generate_request' });
    return;
  }

  // NOTE: SSE ヘッダー送信前に preflight する。ヘッダー送信後は HTTP ステータスを
  // 返せないため、通常はここで 409 を返す。ヘッダー送信後の狭い競合窓でサービス層が
  // 拒否した場合だけ、下の catch で同じ code の SSE error イベントへ縮退する。
  // 視点人物の検証も、400 を返せるこの位置で行う。
  try {
    await assertViewpointCharacterExists(req.params.id, body.viewpointCharacterId);
    await refineAutomationService.assertGenerationNotBlockedByMaintenance(req.params.id);
  } catch (err) {
    if (err instanceof InvalidViewpointCharacterError) {
      res.status(400).json({ error: err.message, code: err.code, retryable: false });
      return;
    }
    if (err instanceof refineAutomationService.RefineAutomationError) {
      res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
      return;
    }
    // NOTE: このハンドラは next を受け取らない（既存のSSE経路と同じ設計）。ヘッダー
    // 送信前なので通常のJSON 500で返す。
    console.error('Maintenance preflight check failed', { projectId: req.params.id, error: err });
    res.status(500).json({
      error: err instanceof Error ? err.message : '生成に失敗しました',
      code: 'generation_failed',
      retryable: false,
    });
    return;
  }

  const abortController = new AbortController();
  let completed = false;

  const handleClientClose = () => {
    if (!completed) abortController.abort();
  };
  req.on('aborted', handleClientClose);
  res.on('close', handleClientClose);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const record = await generationService.generateSceneStream(
      req.params.id,
      {
        wish: body.wish,
        mode: body.mode,
        viewpointCharacterId: body.viewpointCharacterId ?? null,
        abortSignal: abortController.signal,
        // NOTE: 妄想増幅器の advance 専用。指定時は保存済み event から方向を解決する。
        ...(body.amplifierInteractionId
          ? { amplifierInteractionId: body.amplifierInteractionId }
          : {}),
        ...(body.amplifierOperationId
          ? { amplifierOperationId: body.amplifierOperationId }
          : {}),
        // NOTE: strictでも本文chunkは即時送信する。検証・修復で確定本文が変わった
        // 場合はreplaceで全文を差し替え、done.recordを最終正とする。
        onPhase: (phase) => send('phase', { phase }),
        onReplace: (text) => send('replace', { text }),
      },
      (text) => send('chunk', { text })
    );

    send('done', { record });
  } catch (err) {
    if (abortController.signal.aborted) return;
    if (err instanceof DataDirLockedError) {
      send('error', {
        error: err.message,
        code: 'data_dir_moving',
        retryable: true,
      });
    } else if (err instanceof refineAutomationService.RefineAutomationError) {
      // NOTE: preflight 後・ヘッダー送信後の狭い競合窓でサービス層側のガードが拒否した
      // 場合だけここに来る。通常は上の preflight が先に拒否する。
      send('error', {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    } else if (err instanceof generationService.GenerateError) {
      console.warn('Streaming generation failed', {
        projectId: req.params.id,
        code: err.code,
        retryable: err.retryable,
        message: err.message,
      });
      send('error', {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    } else {
      send('error', {
        error: err instanceof Error ? err.message : '生成に失敗しました',
        code: 'generation_failed',
        retryable: false,
      });
    }
  } finally {
    completed = true;
    req.off('aborted', handleClientClose);
    res.off('close', handleClientClose);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

router.post('/projects/:id/regenerate', async (req, res, next) => {
  try {
    const body = parseGenerateRequest(req.body, 'regenerate');
    await assertViewpointCharacterExists(req.params.id, body.viewpointCharacterId);
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: 'regenerate',
      viewpointCharacterId: body.viewpointCharacterId ?? null,
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
    }
    if (err instanceof InvalidViewpointCharacterError) {
      return res.status(400).json({ error: err.message, code: err.code, retryable: false });
    }
    if (err instanceof refineAutomationService.RefineAutomationError) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    if (err instanceof generationService.GenerateError) {
      return res.status(503).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    next(err);
  }
});

router.post('/projects/:id/variate', async (req, res, next) => {
  try {
    const body = parseGenerateRequest(req.body, 'variate');
    await assertViewpointCharacterExists(req.params.id, body.viewpointCharacterId);
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: 'variate',
      viewpointCharacterId: body.viewpointCharacterId ?? null,
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
    }
    if (err instanceof InvalidViewpointCharacterError) {
      return res.status(400).json({ error: err.message, code: err.code, retryable: false });
    }
    if (err instanceof refineAutomationService.RefineAutomationError) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    if (err instanceof generationService.GenerateError) {
      return res.status(503).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    next(err);
  }
});

router.post('/projects/:id/accept', async (req, res, next) => {
  try {
    const { generationId } = (req.body ?? {}) as { generationId?: string };
    const record = await generationService.acceptGeneration(req.params.id, generationId);
    res.json(record);
  } catch (err) {
    if (err instanceof refineAutomationService.RefineAutomationError) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    next(err);
  }
});

router.post('/projects/:id/reject', async (req, res, next) => {
  try {
    const { generationId } = (req.body ?? {}) as { generationId?: string };
    const record = await generationService.rejectGeneration(req.params.id, generationId);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/revert', async (req, res, next) => {
  try {
    const record = await generationService.revertToPrevious(req.params.id);
    if (!record) return res.status(404).json({ error: 'No previous generation found' });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/navigate-draft', async (req, res, next) => {
  try {
    const { direction } = (req.body ?? {}) as { direction?: 'previous' | 'next' };
    if (direction !== 'previous' && direction !== 'next') {
      return res.status(400).json({ error: 'direction must be previous or next' });
    }
    const record = await generationService.navigateDraft(req.params.id, direction);
    if (!record) return res.status(404).json({ error: `No ${direction} generation found` });
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/unaccept', async (req, res, next) => {
  try {
    const record = await generationService.unacceptCurrentScene(req.params.id);
    if (!record) return res.status(404).json({ error: 'No accepted generation to unaccept' });
    res.json(record);
  } catch (err) {
    if (err instanceof refineAutomationService.RefineAutomationError) {
      return res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    next(err);
  }
});

router.post('/projects/:id/navigate-scene', async (req, res, next) => {
  try {
    const { direction } = (req.body ?? {}) as { direction?: SceneNavigationDirection };
    if (direction !== 'previous' && direction !== 'next') {
      return res.status(400).json({ error: 'direction must be previous or next' });
    }
    const state = await generationService.navigateScene(req.params.id, direction);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/story-state/refresh', async (req, res, next) => {
  try {
    const state = await generationService.refreshStoryState(req.params.id);
    res.json(state);
  } catch (err) {
    if (err instanceof generationService.GenerateError) {
      return res.status(503).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    }
    next(err);
  }
});

router.get('/projects/:id/story-state/rebuild-review', async (req, res, next) => {
  try {
    const review = await generationTextRevisionService.getStoryStateRebuildReview(req.params.id);
    res.json(review);
  } catch (err) {
    if (err instanceof generationTextRevisionService.GenerationTextRevisionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

router.post('/projects/:id/story-state/rebuild-review/resolve', async (req, res, next) => {
  try {
    const resolution = req.body?.resolution;
    if (resolution !== 'use-rebuilt' && resolution !== 'use-previous-as-override') {
      return res.status(400).json({ error: 'resolution が不正です。', code: 'invalid_resolution' });
    }
    const generation = await generationTextRevisionService.resolveStoryStateRebuildReview(
      req.params.id,
      resolution
    );
    res.json({ generation });
  } catch (err) {
    if (err instanceof generationTextRevisionService.GenerationTextRevisionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

router.get('/projects/:id/story-state', async (req, res, next) => {
  try {
    const state = await storyStateService.readStoryState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/story-state', async (req, res, next) => {
  try {
    const characters = await storage.readCharacters(req.params.id);
    const state = await storyStateService.replaceStoryState({
      projectId: req.params.id,
      storyState: req.body,
      characters,
    });
    res.json(state);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/story-state/diffs', async (req, res, next) => {
  try {
    const diffs = await storyStateService.readStoryStateDiffs(req.params.id);
    res.json(diffs);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/story-state/diffs/:diffId/revert', async (req, res, next) => {
  try {
    const result = await storyStateService.revertLatestStoryStateDiff(
      req.params.id,
      req.params.diffId
    );
    res.json(result);
  } catch (err) {
    if (err instanceof storyStateService.StoryStateServiceError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

router.get('/projects/:id/reader-state', async (req, res, next) => {
  try {
    const state = await generationService.getReaderState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/generations/:generationId/markdown', async (req, res, next) => {
  try {
    const markdown = await generationService.getGenerationMarkdown(
      req.params.id,
      req.params.generationId
    );
    if (!markdown) return res.status(404).json({ error: 'Generation markdown not found' });

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${markdown.filename}"`);
    }
    res.send(markdown.text);
  } catch (err) {
    next(err);
  }
});

router.patch('/projects/:id/generations/:generationId/text', async (req, res, next) => {
  try {
    const body = parseGenerationTextMutationBody(req.body, true);
    const result = await generationTextRevisionService.updateGenerationText({
      projectId: req.params.id,
      generationId: req.params.generationId,
      nextText: body.text!,
      expectedRevisionNumber: body.expectedRevisionNumber,
      expectedStatus: body.expectedStatus,
      expectedAcceptedGenerationId: body.expectedAcceptedGenerationId,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof generationTextRevisionService.GenerationTextRevisionError) {
      return res.status(err.status).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        latestRevisionNumber: err.latestRevisionNumber,
      });
    }
    next(err);
  }
});

router.get('/projects/:id/generations/:generationId/text-revisions', async (req, res, next) => {
  try {
    const revisions = await generationTextRevisionService.readGenerationTextVersions(
      req.params.id,
      req.params.generationId
    );
    res.json({ revisions });
  } catch (err) {
    if (err instanceof generationTextRevisionService.GenerationTextRevisionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

router.post(
  '/projects/:id/generations/:generationId/text-revisions/:revisionId/restore',
  async (req, res, next) => {
    try {
      const body = parseGenerationTextMutationBody(req.body, false);
      const result = await generationTextRevisionService.restoreGenerationTextRevision({
        projectId: req.params.id,
        generationId: req.params.generationId,
        revisionId: req.params.revisionId,
        expectedRevisionNumber: body.expectedRevisionNumber,
        expectedStatus: body.expectedStatus,
        expectedAcceptedGenerationId: body.expectedAcceptedGenerationId,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof generationTextRevisionService.GenerationTextRevisionError) {
        return res.status(err.status).json({
          error: err.message,
          code: err.code,
          retryable: err.retryable,
          latestRevisionNumber: err.latestRevisionNumber,
        });
      }
      next(err);
    }
  }
);

// NOTE: NG表現の局所リライト。全文の再生成ではなく当たった一文だけを書き換えるので
// 生成系ルートに置く。保守中は本文を触らせない（生成と同じ扱い）。
router.post('/projects/:id/generations/:generationId/ng-rewrite', async (req, res, next) => {
  try {
    await refineAutomationService.assertGenerationNotBlockedByMaintenance(req.params.id);
    const expressionId = typeof req.body?.expressionId === 'string' ? req.body.expressionId : '';
    const start = Number(req.body?.start);
    const end = Number(req.body?.end);
    if (!expressionId || !Number.isInteger(start) || !Number.isInteger(end)) {
      return res.status(400).json({ error: 'expressionId と start / end が必要です。' });
    }

    const result = await ngRewriteService.rewriteNgOccurrence({
      projectId: req.params.id,
      generationId: req.params.generationId,
      expressionId,
      start,
      end,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof ngRewriteService.NgRewriteError) {
      return res
        .status(err.status)
        .json({ error: err.message, code: err.code, retryable: err.retryable });
    }
    next(err);
  }
});

export default router;

function parseGenerationTextMutationBody(
  value: unknown,
  requireText: boolean
): {
  text?: string;
  expectedRevisionNumber: number;
  expectedStatus: 'draft' | 'accepted' | 'rejected' | 'superseded';
  expectedAcceptedGenerationId: string | null;
} {
  const body = (value ?? {}) as Record<string, unknown>;
  const expectedRevisionNumber = body.expectedRevisionNumber;
  const expectedStatus = body.expectedStatus;
  const expectedAcceptedGenerationId = body.expectedAcceptedGenerationId;
  if (requireText && typeof body.text !== 'string') {
    throw new generationTextRevisionService.GenerationTextRevisionError(
      '本文を指定してください。',
      'invalid_text',
      400
    );
  }
  if (
    typeof expectedRevisionNumber !== 'number' ||
    !Number.isInteger(expectedRevisionNumber) ||
    expectedRevisionNumber < 0
  ) {
    throw new generationTextRevisionService.GenerationTextRevisionError(
      'expectedRevisionNumber が不正です。',
      'invalid_revision',
      400
    );
  }
  if (
    expectedStatus !== 'draft' &&
    expectedStatus !== 'accepted' &&
    expectedStatus !== 'rejected' &&
    expectedStatus !== 'superseded'
  ) {
    throw new generationTextRevisionService.GenerationTextRevisionError(
      'expectedStatus が不正です。',
      'invalid_status',
      400
    );
  }
  if (expectedAcceptedGenerationId !== null && typeof expectedAcceptedGenerationId !== 'string') {
    throw new generationTextRevisionService.GenerationTextRevisionError(
      'expectedAcceptedGenerationId が不正です。',
      'invalid_accepted_generation',
      400
    );
  }
  return {
    ...(typeof body.text === 'string' ? { text: body.text } : {}),
    expectedRevisionNumber,
    expectedStatus,
    expectedAcceptedGenerationId,
  };
}

class GenerateRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerateRequestValidationError';
  }
}

function parseGenerateRequest(
  value: unknown,
  forcedMode?: GenerateRequestBody['mode']
): GenerateRequestBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GenerateRequestValidationError('生成リクエストの形式が不正です。');
  }

  const body = value as {
    wish?: unknown;
    mode?: unknown;
    viewpointCharacterId?: unknown;
    amplifierInteractionId?: unknown;
    amplifierOperationId?: unknown;
  };
  const wish = body.wish === undefined ? '' : body.wish;
  if (typeof wish !== 'string') {
    throw new GenerateRequestValidationError('生成指示は文字列で入力してください。');
  }
  if (wish.length > GENERATION_WISH_MAX_CHARS) {
    throw new GenerateRequestValidationError(
      `生成指示は${GENERATION_WISH_MAX_CHARS.toLocaleString('ja-JP')}文字以内で入力してください。`
    );
  }

  const mode = forcedMode ?? (body.mode === undefined ? 'continue' : body.mode);
  if (mode !== 'continue' && mode !== 'regenerate' && mode !== 'variate') {
    throw new GenerateRequestValidationError('生成モードが不正です。');
  }

  // NOTE: 未指定・null はどちらも「自動」。旧クライアントはこのフィールドを送らない。
  const rawViewpoint = body.viewpointCharacterId;
  if (rawViewpoint !== undefined && rawViewpoint !== null && typeof rawViewpoint !== 'string') {
    throw new GenerateRequestValidationError('視点人物の指定が不正です。');
  }
  const viewpointCharacterId =
    typeof rawViewpoint === 'string' && rawViewpoint.trim() ? rawViewpoint.trim() : null;

  // NOTE: 妄想増幅器の advance 専用フィールド。通常の wish だけの既存経路は変更しない。
  const amplifierInteractionId =
    typeof body.amplifierInteractionId === 'string' && body.amplifierInteractionId.trim()
      ? body.amplifierInteractionId.trim()
      : undefined;
  const amplifierOperationId =
    typeof body.amplifierOperationId === 'string' && body.amplifierOperationId.trim()
      ? body.amplifierOperationId.trim()
      : undefined;

  return {
    wish,
    mode,
    viewpointCharacterId,
    ...(amplifierInteractionId ? { amplifierInteractionId } : {}),
    ...(amplifierOperationId ? { amplifierOperationId } : {}),
  };
}

// NOTE: 人物検証専用APIは追加せず、生成 route が既存の readCharacters で確かめる
// （設計書 6.4）。存在しないIDのまま生成すると視点指定が黙って無視されるため、
// 400 で返して利用者に選び直させる。
async function assertViewpointCharacterExists(
  projectId: string,
  viewpointCharacterId: string | null | undefined
): Promise<void> {
  if (!viewpointCharacterId) return;
  const characters = await storage.readCharacters(projectId);
  if (characters.some((character) => character.characterId === viewpointCharacterId)) return;
  throw new InvalidViewpointCharacterError();
}

class InvalidViewpointCharacterError extends Error {
  readonly code = 'invalid_viewpoint_character';
  constructor() {
    super('指定された視点人物がこの作品に存在しません。');
    this.name = 'InvalidViewpointCharacterError';
  }
}

export { InvalidViewpointCharacterError };
