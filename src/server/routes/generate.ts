import { Router } from 'express';
import * as generationService from '../services/generationService.js';
import type { GenerateRequestBody } from '../types/index.js';

const router = Router();

router.post('/projects/:id/generate', async (req, res, next) => {
  try {
    const body = req.body as GenerateRequestBody;
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish || '',
      mode: body.mode || 'continue',
    });
    res.json(record);
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

router.post('/projects/:id/regenerate', async (req, res, next) => {
  try {
    const body = req.body as { wish?: string };
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish || '',
      mode: 'regenerate',
    });
    res.json(record);
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

router.post('/projects/:id/variate', async (req, res, next) => {
  try {
    const body = req.body as { wish?: string };
    const record = await generationService.generateScene(req.params.id, {
      wish: body.wish || '',
      mode: 'variate',
    });
    res.json(record);
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

router.post('/projects/:id/accept', async (req, res, next) => {
  try {
    const { generationId } = req.body as { generationId?: string };
    const record = await generationService.acceptGeneration(req.params.id, generationId);
    res.json(record);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/reject', async (req, res, next) => {
  try {
    const { generationId } = req.body as { generationId?: string };
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

router.get('/projects/:id/reader-state', async (req, res, next) => {
  try {
    const state = await generationService.getReaderState(req.params.id);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

export default router;
