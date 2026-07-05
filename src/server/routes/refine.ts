import { Router } from 'express';
import * as refineScanService from '../services/refineScanService.js';

const router = Router();

// NOTE: 明示走査。トークンを使うので UI 側からボタンで叩く運用。
router.post('/projects/:id/refine/scan', async (req, res, next) => {
  try {
    const result = await refineScanService.scanProjectSettings(req.params.id);
    res.json(result);
  } catch (err) {
    if (err instanceof refineScanService.RefineScanError) {
      // NOTE: clientApi.formatApiError は { error, code, retryable } を読むので
      // その形に合わせる。他の routes と揃えている。
      res.status(err.status).json({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
      return;
    }
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

export default router;
