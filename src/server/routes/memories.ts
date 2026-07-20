import { Router } from 'express';
import * as memoryService from '../services/memoryService.js';
import { withProjectWriteLock } from '../services/generationService.js';
import type { Memory } from '../types/index.js';

const router = Router();

router.get('/projects/:id/memories', async (req, res, next) => {
  try {
    const memories = await memoryService.listMemories(req.params.id);
    res.json(memories);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/memories', async (req, res, next) => {
  try {
    const input = selectMemoryFields(req.body) as {
      type: Memory['type'];
      content: string;
      importance?: Memory['importance'];
      relatedCharacters?: string[];
      relatedEpisodes?: string[];
    };
    const memory = await withProjectWriteLock(req.params.id, () =>
      memoryService.createMemory(req.params.id, input)
    );
    res.status(201).json(memory);
  } catch (err) {
    handleMemoryError(err, res, next);
  }
});

router.put('/projects/:id/memories/:mid', async (req, res, next) => {
  try {
    const input = selectMemoryFields(req.body);
    const memory = await withProjectWriteLock(req.params.id, () =>
      memoryService.updateMemory(req.params.id, req.params.mid, input)
    );
    res.json(memory);
  } catch (err) {
    handleMemoryError(err, res, next);
  }
});

router.delete('/projects/:id/memories/:mid', async (req, res, next) => {
  try {
    await withProjectWriteLock(req.params.id, () =>
      memoryService.deleteMemory(req.params.id, req.params.mid)
    );
    res.status(204).send();
  } catch (err) {
    handleMemoryError(err, res, next);
  }
});

export default router;

function selectMemoryFields(
  value: unknown
): Partial<Pick<Memory, 'type' | 'content' | 'importance' | 'relatedCharacters' | 'relatedEpisodes'>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new memoryService.MemoryValidationError('記憶の入力内容が不正です。');
  }
  const body = value as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const key of ['type', 'content', 'importance', 'relatedCharacters', 'relatedEpisodes']) {
    if (Object.hasOwn(body, key)) selected[key] = body[key];
  }
  return selected;
}

function handleMemoryError(
  err: unknown,
  res: { status: (status: number) => { json: (body: unknown) => void } },
  next: (err: unknown) => void
): void {
  if (err instanceof memoryService.MemoryValidationError) {
    res.status(400).json({ error: err.message, code: 'invalid_memory', retryable: false });
    return;
  }
  if (err instanceof memoryService.MemoryNotFoundError) {
    res.status(404).json({ error: err.message, code: 'memory_not_found', retryable: false });
    return;
  }
  next(err);
}
