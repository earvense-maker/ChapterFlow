import { Router } from 'express';
import * as generationService from '../services/generationService.js';
import * as storage from '../services/storageService.js';
import * as storyStateService from '../services/storyStateService.js';
import { DataDirLockedError } from '../services/dataDirLock.js';
import { GENERATION_WISH_MAX_CHARS } from '../types/index.js';
import type { GenerateRequestBody, SceneNavigationDirection } from '../types/index.js';

const router = Router();

router.post('/projects/:id/generate', async (req, res, next) => {
  try {
    const body = parseGenerateRequest(req.body);
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: body.mode,
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
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
        abortSignal: abortController.signal,
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
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: 'regenerate',
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
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
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish,
      mode: 'variate',
    });
    res.json(record);
  } catch (err) {
    if (err instanceof GenerateRequestValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_generate_request' });
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

router.post('/projects/:id/context/compress', async (req, res, next) => {
  try {
    const result = await generationService.compressProjectContext(req.params.id);
    res.json(result);
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

export default router;

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

  const body = value as { wish?: unknown; mode?: unknown };
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
  return { wish, mode };
}
