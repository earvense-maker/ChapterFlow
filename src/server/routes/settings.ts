import { Router, type NextFunction, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import * as storage from '../services/storageService.js';
import {
  hasCompleteCanonicalWorldStructure,
  serializeWorldMd,
} from '../utils/worldMd.js';
import * as projectService from '../services/projectService.js';
import { withProjectWriteLock } from '../services/generationService.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import { loadStyleSamples } from '../prompts/styleSamplePresets.js';
import {
  createSystemPromptPreset,
  deleteSystemPromptPreset,
  listSystemPromptPresets,
  SystemPromptPresetConflictError,
  SystemPromptPresetNotFoundError,
  SystemPromptPresetValidationError,
  updateSystemPromptPreset,
} from '../services/systemPromptPresetService.js';
import type { ActivePresets, Character, CharacterRole, PresetsFile } from '../types/index.js';

const router = Router();

router.get('/presets', async (_req, res, next) => {
  try {
    const text = await fs.readFile(PRESETS_PATH, 'utf-8');
    res.json(JSON.parse(text));
  } catch (err) {
    next(err);
  }
});

router.get('/style-samples', async (_req, res, next) => {
  try {
    const items = await loadStyleSamples();
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/system-prompt-presets', async (_req, res, next) => {
  try {
    res.json({ items: await listSystemPromptPresets() });
  } catch (err) {
    next(err);
  }
});

router.post('/system-prompt-presets', async (req, res, next) => {
  try {
    const preset = await createSystemPromptPreset({
      name: req.body?.name,
      prompt: req.body?.prompt,
    });
    res.status(201).json(preset);
  } catch (err) {
    handleSystemPromptPresetError(err, res, next);
  }
});

router.put('/system-prompt-presets/:id', async (req, res, next) => {
  try {
    res.json(
      await updateSystemPromptPreset(req.params.id, {
        name: req.body?.name,
        prompt: req.body?.prompt,
        expectedUpdatedAt: req.body?.expectedUpdatedAt,
      })
    );
  } catch (err) {
    handleSystemPromptPresetError(err, res, next);
  }
});

router.delete('/system-prompt-presets/:id', async (req, res, next) => {
  try {
    await deleteSystemPromptPreset(req.params.id);
    res.status(204).end();
  } catch (err) {
    handleSystemPromptPresetError(err, res, next);
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
    const nextPresets = await withProjectWriteLock(req.params.id, async () => {
      const [project, presets] = await Promise.all([
        storage.readProject(req.params.id),
        storage.readPresets(req.params.id),
      ]);
      if (!project || !presets) return null;

      const nextFile: PresetsFile = { ...presets, ...body };
      // NOTE: 古い presets.json は任意プリセットのキーを持たない場合があるため、
      // undefined を project 側の選択値へ上書きしないよう、定義済み値だけを反映する。
      const activePresetIds = {
        ...project.activePresetIds,
        ...activePresetsFromPresetFile(nextFile),
      };
      const { baseSystemPrompt, customSystemPrompt } = await resolveSystemPrompt(
        activePresetIds,
        nextFile.customSystemPrompt,
        nextFile.baseSystemPrompt
      );
      const normalizedFile: PresetsFile = {
        ...nextFile,
        baseSystemPrompt,
        customSystemPrompt,
      };
      await storage.writePresets(req.params.id, normalizedFile);

      await projectService.updateProject(req.params.id, { activePresetIds });
      return normalizedFile;
    });

    if (!nextPresets) return res.status(404).json({ error: 'Presets not found' });
    res.json(nextPresets);
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

    res.json(
      await resolveSystemPrompt(
        activePresetIds,
        customSystemPrompt,
        nextPresets.baseSystemPrompt
      )
    );
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
    const characters = req.body;
    if (!Array.isArray(characters) || !characters.every(isCharacterInput)) {
      return res.status(400).json({ error: 'Invalid characters payload' });
    }

    // NOTE: 全書き込み境界で共通正規化を通し、greeting/dialogueExamples の上限を保証する。
    const normalized = projectService.normalizeCharactersForStorage(characters);
    await withProjectWriteLock(req.params.id, () =>
      storage.writeCharacters(req.params.id, normalized)
    );
    res.json(normalized);
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/world', async (req, res, next) => {
  try {
    res.json(await storage.readWorld(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.put('/projects/:id/world', async (req, res, next) => {
  try {
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid world payload' });
    }
    const body = req.body as { foundation?: unknown; initialSituation?: unknown };
    if (typeof body.foundation !== 'string' || typeof body.initialSituation !== 'string') {
      return res.status(400).json({ error: 'Invalid world payload' });
    }

    const world = { foundation: body.foundation, initialSituation: body.initialSituation };
    if (!hasCompleteCanonicalWorldStructure(serializeWorldMd(world))) {
      return res.status(400).json({ error: 'Invalid canonical world structure' });
    }
    await withProjectWriteLock(req.params.id, () => storage.writeWorld(req.params.id, world));
    res.json(world);
  } catch (err) {
    next(err);
  }
});

router.patch('/projects/:id/world/:area', async (req, res, next) => {
  try {
    const area = req.params.area;
    if (area !== 'foundation' && area !== 'initialSituation') {
      return res.status(400).json({ error: 'Invalid world area' });
    }
    if (
      typeof req.body !== 'object' ||
      req.body === null ||
      Array.isArray(req.body) ||
      typeof req.body.text !== 'string'
    ) {
      return res.status(400).json({ error: 'Invalid world area payload' });
    }

    const world = await withProjectWriteLock(req.params.id, async () => {
      const current = await storage.readWorld(req.params.id);
      const next = { ...current, [area]: req.body.text };
      await storage.writeWorld(req.params.id, next);
      return next;
    });
    res.json(world);
  } catch (err) {
    next(err);
  }
});

export default router;

function handleSystemPromptPresetError(
  err: unknown,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof SystemPromptPresetValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof SystemPromptPresetNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof SystemPromptPresetConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  next(err);
}

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
  if (presets.intimacyPreset !== undefined) activePresets.intimacy = presets.intimacyPreset;
  return activePresets;
}

const characterRoles = new Set<CharacterRole>([
  'protagonist',
  'deuteragonist',
  'supporting',
  'other',
]);

function isCharacterInput(value: unknown): value is Character {
  if (!isRecord(value)) return false;
  return (
    typeof value.characterId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.role === 'string' &&
    characterRoles.has(value.role as CharacterRole) &&
    optionalStringArray(value.aliases) &&
    optionalString(value.speechStyle) &&
    optionalString(value.relationshipNotes) &&
    optionalString(value.secrets) &&
    optionalString(value.want) &&
    optionalString(value.fear) &&
    optionalString(value.currentState) &&
    optionalString(value.greeting) &&
    optionalStringArray(value.dialogueExamples)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
