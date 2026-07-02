import { Router } from 'express';
import * as stateService from '../services/stateService.js';
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
    const updates = req.body as Partial<ProjectState>;
    const state = await stateService.updateState(req.params.id, updates);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

export default router;
