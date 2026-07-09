import { Router } from 'express';
import * as expressionService from '../services/expressionService.js';
import type { NgExpressionSource } from '../types/index.js';

const router = Router();

router.get('/projects/:id/expressions', async (req, res, next) => {
  try {
    const ngExpressions = await expressionService.getExpressions(req.params.id);
    res.json({ ngExpressions });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/expressions', async (req, res, next) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    const source = normalizeSource(req.body.source);
    const { expression, isExisting } = await expressionService.createExpression(req.params.id, {
      text,
      source,
    });
    res.status(isExisting ? 200 : 201).json(expression);
  } catch (err) {
    if (err instanceof expressionService.ExpressionValidationError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof expressionService.ExpressionLimitError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.delete('/projects/:id/expressions/:expressionId', async (req, res, next) => {
  try {
    await expressionService.archiveExpression(req.params.id, req.params.expressionId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function normalizeSource(value: unknown): NgExpressionSource | undefined {
  if (value === 'manual' || value === 'report' || value === 'selection') return value;
  return undefined;
}

export default router;
