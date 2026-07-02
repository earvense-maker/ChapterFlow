import { Router } from 'express';
import * as memoryService from '../services/memoryService.js';
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
    const input = req.body as {
      type: Memory['type'];
      content: string;
      importance?: Memory['importance'];
      relatedCharacters?: string[];
      relatedEpisodes?: string[];
    };
    const memory = await memoryService.createMemory(req.params.id, input);
    res.status(201).json(memory);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/memories/:mid', async (req, res, next) => {
  try {
    const input = req.body as Partial<Memory>;
    const memory = await memoryService.updateMemory(req.params.id, req.params.mid, input);
    res.json(memory);
  } catch (err) {
    next(err);
  }
});

router.delete('/projects/:id/memories/:mid', async (req, res, next) => {
  try {
    await memoryService.deleteMemory(req.params.id, req.params.mid);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
