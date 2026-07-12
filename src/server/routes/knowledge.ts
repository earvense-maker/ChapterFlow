import { Router } from 'express';
import * as knowledgeService from '../services/knowledgeService.js';
import { withProjectWriteLock } from '../services/generationService.js';
import type { CreateKnowledgeBody, UpdateKnowledgeBody } from '../types/index.js';

const router = Router();

router.get('/projects/:id/knowledge', async (req, res, next) => {
  try {
    res.json(await knowledgeService.listKnowledge(req.params.id));
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

router.get('/projects/:id/knowledge/:kbId', async (req, res, next) => {
  try {
    res.json(await knowledgeService.getKnowledgeContent(req.params.id, req.params.kbId));
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

router.post('/projects/:id/knowledge', async (req, res, next) => {
  try {
    const body = validateCreateKnowledgeBody(req.body);
    const file = await withProjectWriteLock(req.params.id, () =>
      knowledgeService.createKnowledge(req.params.id, body)
    );
    res.status(201).json(file);
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

router.put('/projects/:id/knowledge/:kbId', async (req, res, next) => {
  try {
    const body = validateUpdateKnowledgeBody(req.body);
    const file = await withProjectWriteLock(req.params.id, () =>
      knowledgeService.updateKnowledge(req.params.id, req.params.kbId, body)
    );
    res.json(file);
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

router.put('/projects/:id/knowledge-order', async (req, res, next) => {
  try {
    const orderedIds = validateKnowledgeOrderBody(req.body);
    const files = await withProjectWriteLock(req.params.id, () =>
      knowledgeService.reorderKnowledge(req.params.id, orderedIds)
    );
    res.json(files);
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

router.delete('/projects/:id/knowledge/:kbId', async (req, res, next) => {
  try {
    await withProjectWriteLock(req.params.id, () =>
      knowledgeService.deleteKnowledge(req.params.id, req.params.kbId)
    );
    res.status(204).send();
  } catch (err) {
    handleKnowledgeError(err, res, next);
  }
});

export default router;

function validateCreateKnowledgeBody(body: unknown): CreateKnowledgeBody {
  if (!isRecord(body)) {
    throw new knowledgeService.KnowledgeValidationError('Invalid knowledge payload');
  }
  if (typeof body.fileName !== 'string') {
    throw new knowledgeService.KnowledgeValidationError('fileName must be a string');
  }
  if (typeof body.content !== 'string') {
    throw new knowledgeService.KnowledgeValidationError('content must be a string');
  }
  return { fileName: body.fileName, content: body.content };
}

function validateUpdateKnowledgeBody(body: unknown): UpdateKnowledgeBody {
  if (!isRecord(body)) {
    throw new knowledgeService.KnowledgeValidationError('Invalid knowledge payload');
  }
  const next: UpdateKnowledgeBody = {};
  let hasKnownKey = false;

  if (Object.hasOwn(body, 'title')) {
    hasKnownKey = true;
    if (typeof body.title !== 'string') {
      throw new knowledgeService.KnowledgeValidationError('title must be a string');
    }
    next.title = body.title;
  }
  if (Object.hasOwn(body, 'content')) {
    hasKnownKey = true;
    if (typeof body.content !== 'string') {
      throw new knowledgeService.KnowledgeValidationError('content must be a string');
    }
    next.content = body.content;
  }
  if (Object.hasOwn(body, 'enabled')) {
    hasKnownKey = true;
    if (typeof body.enabled !== 'boolean') {
      throw new knowledgeService.KnowledgeValidationError('enabled must be a boolean');
    }
    next.enabled = body.enabled;
  }
  if (Object.hasOwn(body, 'order')) {
    hasKnownKey = true;
    if (typeof body.order !== 'number' || !Number.isInteger(body.order) || body.order < 0) {
      throw new knowledgeService.KnowledgeValidationError('order must be a non-negative integer');
    }
    next.order = body.order;
  }

  if (!hasKnownKey) {
    throw new knowledgeService.KnowledgeValidationError('No valid fields to update');
  }
  return next;
}

function validateKnowledgeOrderBody(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.orderedIds)) {
    throw new knowledgeService.KnowledgeValidationError('orderedIds must be a string array');
  }
  if (!body.orderedIds.every((id) => typeof id === 'string')) {
    throw new knowledgeService.KnowledgeValidationError('orderedIds must be a string array');
  }
  return body.orderedIds;
}

function handleKnowledgeError(
  err: unknown,
  res: { status: (code: number) => { json: (body: unknown) => void } },
  next: (err: unknown) => void
): void {
  if (err instanceof knowledgeService.KnowledgeValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof knowledgeService.KnowledgeNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  next(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
