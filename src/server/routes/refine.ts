import { Router } from 'express';
import * as refineScanService from '../services/refineScanService.js';
import * as refineChatService from '../services/refineChatService.js';
import * as refineAutomationService from '../services/refineAutomationService.js';
import * as projectService from '../services/projectService.js';
import { withProjectWriteLock } from '../services/generationService.js';
import type { RefineAutomationSettings } from '../types/index.js';

const router = Router();

// NOTE: RefineScanError / RefineChatError / RefineAutomationError で処理が同じなので
// 共通ヘルパー化。
function handleRefineError(err: unknown, res: import('express').Response): boolean {
  if (
    err instanceof refineScanService.RefineScanError ||
    err instanceof refineChatService.RefineChatError ||
    err instanceof refineAutomationService.RefineAutomationError
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

// NOTE: 自動レビュー設定・最新状態の取得。Phase B の間は status が現れるとしても
// scanning/applying/reverting へ実際に遷移するトリガーがまだ無いため、常に非block
// フェーズか undefined のままになる（Phase C で自動走査が繋がった後に意味を持つ）。
router.get('/projects/:id/refine/automation', async (req, res, next) => {
  try {
    const [project, status] = await Promise.all([
      projectService.getProject(req.params.id),
      refineAutomationService.getMaintenanceStatus(req.params.id),
    ]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({
      settings: project.refineAutomation ?? null,
      status,
    });
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.put('/projects/:id/refine/automation', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Partial<RefineAutomationSettings>;
    // NOTE: read-modify-write なので、通常の作品設定保存と競合しないよう
    // withProjectWriteLock で囲む（他のprojectsルートと同じ規律）。
    const updated = await withProjectWriteLock(req.params.id, () =>
      projectService.updateProject(req.params.id, {
        refineAutomation: { mode: body.mode, scanPolicy: body.scanPolicy } as RefineAutomationSettings,
      })
    );
    res.json(updated.refineAutomation ?? null);
  } catch (err) {
    if (err instanceof projectService.ProjectValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_refine_automation_settings' });
    }
    next(err);
  }
});

router.post('/projects/:id/refine/automation/retry', async (req, res, next) => {
  try {
    const run = await refineAutomationService.retryFailedAutomationRun(req.params.id);
    res.json(run);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.get('/projects/:id/refine/automation/runs', async (req, res, next) => {
  try {
    const runs = await refineAutomationService.listAutomationRuns(req.params.id);
    res.json(runs);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.post('/projects/:id/refine/automation/runs/:runId/acknowledge', async (req, res, next) => {
  try {
    const run = await refineAutomationService.acknowledgeAutomationRun(req.params.id, req.params.runId);
    res.json(run);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

router.post('/projects/:id/refine/automation/runs/:runId/revert', async (req, res, next) => {
  try {
    const result = await refineAutomationService.revertLatestAutomationRun(
      req.params.id,
      req.params.runId
    );
    res.json(result);
  } catch (err) {
    if (handleRefineError(err, res)) return;
    next(err);
  }
});

export default router;
