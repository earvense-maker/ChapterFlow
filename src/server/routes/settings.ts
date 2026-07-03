import { Router } from 'express';
import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import * as storage from '../services/storageService.js';
import * as projectService from '../services/projectService.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import type { ActivePresets, Character, PresetsFile } from '../types/index.js';

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

    const activePresetIds = activePresetsFromPresetFile(next);
    await projectService.updateProject(req.params.id, { activePresetIds });

    res.json(next);
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:id/system-prompt/preview', async (req, res, next) => {
  try {
    const project = await storage.readProject(req.params.id);
    const presets = await storage.readPresets(req.params.id);
    if (!project || !presets) return res.status(404).json({ error: 'Project not found' });

    const body = req.body as {
      presets?: Partial<PresetsFile>;
      customSystemPrompt?: string | null;
    };
    const nextPresets = { ...presets, ...(body.presets ?? {}) };
    const activePresetIds = {
      ...project.activePresetIds,
      ...activePresetsFromPresetFile(nextPresets),
    };
    const customSystemPrompt = Object.hasOwn(body, 'customSystemPrompt')
      ? body.customSystemPrompt
      : nextPresets.customSystemPrompt;

    res.json(await resolveSystemPrompt(activePresetIds, customSystemPrompt));
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

function activePresetsFromPresetFile(presets: Partial<PresetsFile>): Partial<ActivePresets> {
  const activePresets: Partial<ActivePresets> = {};
  if (presets.genrePreset !== undefined) activePresets.genre = presets.genrePreset;
  if (presets.stylePreset !== undefined) activePresets.style = presets.stylePreset;
  if (presets.povPreset !== undefined) activePresets.pov = presets.povPreset;
  if (presets.pacingPreset !== undefined) activePresets.pacing = presets.pacingPreset;
  if (presets.densityPreset !== undefined) activePresets.density = presets.densityPreset;
  if (presets.conversationPreset !== undefined) activePresets.conversation = presets.conversationPreset;
  if (presets.relationshipPacingPreset !== undefined) {
    activePresets.relationshipPacing = presets.relationshipPacingPreset;
  }
  if (presets.distancePreset !== undefined) activePresets.distance = presets.distancePreset;
  if (presets.constraintPreset !== undefined) activePresets.constraint = presets.constraintPreset;
  return activePresets;
}
