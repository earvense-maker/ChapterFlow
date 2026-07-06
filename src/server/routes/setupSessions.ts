import { Router } from 'express';
import * as setupSessionService from '../services/setupSessionService.js';
import type {
  CommitSetupBody,
  CreateSetupSessionBody,
  PatchSetupSettingsBody,
  RetrySetupMessageBody,
  SendSetupMessageBody,
  SetLockStateBody,
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
    const body = (req.body ?? {}) as CreateSetupSessionBody;
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

router.post('/setup-sessions/:id/abandon', async (req, res, next) => {
  try {
    const session = await setupSessionService.abandonSetupSession(req.params.id);
    res.json(session);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.delete('/setup-sessions/:id', async (req, res, next) => {
  try {
    const result = await setupSessionService.deleteSetupSession(req.params.id);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.patch('/setup-sessions/:id/settings', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as PatchSetupSettingsBody;
    const result = await setupSessionService.patchSetupSettings(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/messages', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as SendSetupMessageBody;
    const result = await setupSessionService.sendSetupMessage(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/messages/stream', async (req, res) => {
  const body = (req.body ?? {}) as SendSetupMessageBody;
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
    for await (const event of setupSessionService.sendSetupMessageStream(
      req.params.id,
      body,
      abortController.signal
    )) {
      if (event.type === 'delta') {
        send('delta', { text: event.text });
      } else if (event.type === 'result') {
        send('result', event.response);
      } else if (event.type === 'error') {
        send('error', event.error);
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) return;
    if (err instanceof setupSessionService.SetupServiceError) {
      send('error', {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        session: err.session,
      });
    } else {
      send('error', {
        error: err instanceof Error ? err.message : '相談処理に失敗しました',
        code: 'setup_failed',
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

router.post('/setup-sessions/:id/messages/retry', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as RetrySetupMessageBody;
    const result = await setupSessionService.retrySetupMessage(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.put('/setup-sessions/:id/draft', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as UpdateSetupDraftBody;
    const result = await setupSessionService.updateSetupDraft(req.params.id, body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.put('/setup-sessions/:id/lock-state', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as SetLockStateBody;
    const result = await setupSessionService.setLockState(req.params.id, body);
    res.json(result);
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

router.post('/setup-sessions/:id/commit-plan', async (req, res, next) => {
  try {
    const result = await setupSessionService.createSetupCommitPlan(req.params.id, req.body);
    res.json(result);
  } catch (err) {
    handleSetupError(err, res, next);
  }
});

router.post('/setup-sessions/:id/commit', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as CommitSetupBody;
    const result = await setupSessionService.commitSetupSession(req.params.id, body);
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
