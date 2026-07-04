import { Router } from 'express';
import * as setupSessionService from '../services/setupSessionService.js';
import type {
  CreateSetupSessionBody,
  SendSetupMessageBody,
  UpdateSetupDraftBody,
} from '../types/index.js';

const router = Router();

router.get('/setup-sessions', async (_req, res, next) => {
  try {
    const sessions = await setupSessionService.listSetupSessions();
    res.json(sessions);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions', async (req, res, next) => {
  try {
    const body = req.body as CreateSetupSessionBody;
    const result = await setupSessionService.createSetupSession(body);
    res.status(201).json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.get('/setup-sessions/:id', async (req, res, next) => {
  try {
    const session = await setupSessionService.getSetupSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Setup session not found' });
    res.json(session);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/messages', async (req, res, next) => {
  try {
    const body = req.body as SendSetupMessageBody;
    const result = await setupSessionService.sendSetupMessage(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.put('/setup-sessions/:id/draft', async (req, res, next) => {
  try {
    const body = req.body as UpdateSetupDraftBody;
    const result = await setupSessionService.updateSetupDraft(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/locks', async (req, res, next) => {
  try {
    const body = req.body as { path?: string; reason?: 'user_locked' | 'manual_edit' };
    const session = await setupSessionService.addSetupLock(req.params.id, body.path || '', body.reason);
    res.status(201).json(session);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.delete('/setup-sessions/:id/locks/:lockId', async (req, res, next) => {
  try {
    const session = await setupSessionService.removeSetupLock(req.params.id, req.params.lockId);
    res.json(session);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/preview', async (req, res, next) => {
  try {
    const result = await setupSessionService.generateSetupPreview(req.params.id);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/commit', async (req, res, next) => {
  try {
    const result = await setupSessionService.commitSetupSession(req.params.id);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

function handleSetupError(
  err: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: (err: unknown) => void
): void {
  if (err instanceof setupSessionService.SetupServiceError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      retryable: err.retryable,
      session: err.session,
    });
    return;
  }
  next(err);
}

export default router;
