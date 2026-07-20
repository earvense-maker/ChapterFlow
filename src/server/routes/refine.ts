import { Router } from 'express';
import * as refineScanService from '../services/refineScanService.js';
import * as refineChatService from '../services/refineChatService.js';

const router = Router();

// NOTE: RefineScanError と RefineChatError で処理が同じなので共通ヘルパー化。
function handleRefineError(err: unknown, res: import('express').Response): boolean {
  if (
    err instanceof refineScanService.RefineScanError ||
    err instanceof refineChatService.RefineChatError
  ) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      retryable: err.retryable,
    });
    return true;
  }
  return false;
}

// NOTE: 明示走査。トークンを使うので UI 側からボタンで叩く運用。
router.post('/projects/:id/refine/scan', async (req, res, next) => {
  try {
    const result = await refineScanService.scanProjectSettings(req.params.id);
    res.json(result);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

// NOTE: 前回のキャッシュ表示用。無ければ 200 で null を返す。
router.get('/projects/:id/refine/scan', async (req, res, next) => {
  try {
    const cached = await refineScanService.readCachedRefineScan(req.params.id);
    res.json(cached);
  } catch (err) {
    next(err);
  }
});

// NOTE: scan 本体のキャッシュ形式は変えず、鮮度だけを別APIで返す。
router.get('/projects/:id/refine/status', async (req, res, next) => {
  try {
    const status = await refineScanService.getRefineReviewStatus(req.params.id);
    res.json(status);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.get('/projects/:id/refine/session', async (req, res, next) => {
  try {
    const session = await refineChatService.getOrCreateRefineSession(req.params.id);
    res.json(session);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.delete('/projects/:id/refine/session', async (req, res, next) => {
  try {
    const session = await refineChatService.resetRefineSession(req.params.id);
    res.json(session);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.post('/projects/:id/refine/messages', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { content?: unknown };
    const content = typeof body.content === 'string' ? body.content : '';
    const result = await refineChatService.sendRefineMessage(req.params.id, content);
    res.json(result);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.post('/projects/:id/refine/patches/:patchId/apply', async (req, res, next) => {
  try {
    const result = await refineChatService.applyRefinePatch(req.params.id, req.params.patchId);
    res.json(result);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.post('/projects/:id/refine/patches/:patchId/reject', async (req, res, next) => {
  try {
    const result = await refineChatService.rejectRefinePatch(req.params.id, req.params.patchId);
    res.json(result);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

export default router;
