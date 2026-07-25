import { Router } from 'express';
import type { NextFunction, Response } from 'express';
import * as expressionService from '../services/expressionService.js';
import type { NgExpressionSource } from '../types/index.js';

const router = Router();

router.get('/expressions/global', async (_req, res, next) => {
  try {
    const ngExpressions = await expressionService.getGlobalExpressions();
    res.json({ ngExpressions });
  } catch (err) {
    handleExpressionError(err, res, next);
  }
});

router.post('/expressions/global', async (req, res, next) => {
  try {
    const text = typeof req.body.text === 'string' ? req.body.text : '';
    const source = normalizeSource(req.body.source);
    const { expression, isExisting } = await expressionService.createGlobalExpression({
      text,
      source,
      alternatives: normalizeAlternatives(req.body?.alternatives),
    });
    res.status(isExisting ? 200 : 201).json(expression);
  } catch (err) {
    handleExpressionError(err, res, next);
  }
});

router.patch('/expressions/global/:expressionId', async (req, res, next) => {
  try {
    const expression = await expressionService.updateGlobalExpressionAlternatives(
      req.params.expressionId,
      normalizeAlternatives(req.body?.alternatives)
    );
    res.json(expression);
  } catch (err) {
    handleExpressionError(err, res, next);
  }
});

router.delete('/expressions/global/:expressionId', async (req, res, next) => {
  try {
    await expressionService.archiveGlobalExpression(req.params.expressionId);
    res.json({ ok: true });
  } catch (err) {
    handleExpressionError(err, res, next);
  }
});

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
      alternatives: normalizeAlternatives(req.body?.alternatives),
    });
    res.status(isExisting ? 200 : 201).json(expression);
  } catch (err) {
    handleExpressionError(err, res, next);
  }
});

router.patch('/projects/:id/expressions/:expressionId', async (req, res, next) => {
  try {
    const expression = await expressionService.updateExpressionAlternatives(
      req.params.id,
      req.params.expressionId,
      normalizeAlternatives(req.body?.alternatives)
    );
    res.json(expression);
  } catch (err) {
    handleExpressionError(err, res, next);
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

function normalizeAlternatives(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeSource(value: unknown): NgExpressionSource | undefined {
  if (value === 'manual' || value === 'report' || value === 'selection') return value;
  return undefined;
}

function handleExpressionError(err: unknown, res: Response, next: NextFunction): void {
  if (
    err instanceof expressionService.ExpressionValidationError ||
    err instanceof expressionService.ExpressionLimitError
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof expressionService.GlobalExpressionsCorruptError) {
    res.status(500).json({ error: err.message, code: err.code });
    return;
  }
  next(err);
}

export default router;
