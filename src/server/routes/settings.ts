import { Router } from 'express';
import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import * as storage from '../services/storageService.js';
import * as projectService from '../services/projectService.js';
import type { Character, PresetsFile } from '../types/index.js';

const router = Router();

router.get('/presets', async (_req, res, next) => {
  try {
    const text = await fs.readFile(PRESETS_PATH, 'utf-8');
    res.json(JSON.parse(text));
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/presets', async (req, res, next) => {
  try {
    const presets = await storage.readPresets(req.params.id);
    if (!presets) return res.status(404).json({ error: 'Presets not found' });
    res.json(presets);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/presets', async (req, res, next) => {
  try {
    const body = req.body as Partial<PresetsFile>;
    const presets = await storage.readPresets(req.params.id);
    if (!presets) return res.status(404).json({ error: 'Presets not found' });

    const next: PresetsFile = { ...presets, ...body };
    await storage.writePresets(req.params.id, next);

    const activePresetIds = {
      genre: next.genrePreset,
      style: next.stylePreset,
      pov: next.povPreset,
      pacing: next.pacingPreset,
      density: next.densityPreset,
      conversation: next.conversationPreset,
      relationshipPacing: next.relationshipPacingPreset,
      distance: next.distancePreset,
      constraint: next.constraintPreset,
    };
    await projectService.updateProject(req.params.id, { activePresetIds });

    res.json(next);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/characters', async (req, res, next) => {
  try {
    const characters = await storage.readCharacters(req.params.id);
    res.json(characters);
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/characters', async (req, res, next) => {
  try {
    const characters = req.body as Character[];
    await storage.writeCharacters(req.params.id, characters);
    res.json(characters);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/world', async (req, res, next) => {
  try {
    const text = await storage.readWorld(req.params.id);
    res.json({ text });
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/world', async (req, res, next) => {
  try {
    const { text } = req.body as { text: string };
    await storage.writeWorld(req.params.id, text ?? '');
    res.json({ text: text ?? '' });
  } catch (err) {
    next(err);
  }
});

export default router;
