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
import { normalizeActivePresetIds } from '../../shared/presetMigration.js';
import { loadStyleSamples } from '../prompts/styleSamplePresets.js';
import { isValidCharacterInput } from '../../shared/characterSchema.js';
import {
  createSystemPromptPreset,
  deleteSystemPromptPreset,
  listSystemPromptPresets,
  SystemPromptPresetConflictError,
  SystemPromptPresetNotFoundError,
  SystemPromptPresetValidationError,
  updateSystemPromptPreset,
} from '../services/systemPromptPresetService.js';
import { SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS } from '../types/index.js';
import type { PresetsFile } from '../types/index.js';

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
    const body = parsePresetsPatch(req.body);
    const nextPresets = await withProjectWriteLock(req.params.id, async () => {
      const [project, presets] = await Promise.all([
        storage.readProject(req.params.id),
        storage.readPresets(req.params.id),
      ]);
      if (!project || !presets) return null;

      const nextFile: PresetsFile = {
        userCustomPromptParts:
          body.userCustomPromptParts ?? presets.userCustomPromptParts ?? [],
        baseSystemPrompt: body.baseSystemPrompt ?? presets.baseSystemPrompt,
        customSystemPrompt: body.customSystemPrompt ?? presets.customSystemPrompt,
      };
      const activePresetIds = normalizeActivePresetIds(project.activePresetIds);
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
      // NOTE: プロンプト編集も作品の更新として一覧順へ反映する。プリセット選択値は
      // project.json が正本なので、ミラーへ戻さず project の時刻だけ更新する。
      await projectService.updateProject(req.params.id, {});

      return normalizedFile;
    });

    if (!nextPresets) return res.status(404).json({ error: 'Presets not found' });
    res.json(nextPresets);
  } catch (err) {
    if (err instanceof ProjectPresetsValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_presets' });
    }
    next(err);
  }
});

router.post('/projects/:id/system-prompt/preview', async (req, res, next) => {
  try {
    const project = await storage.readProject(req.params.id);
    const presets = await storage.readPresets(req.params.id);
    if (!project || !presets) return res.status(404).json({ error: 'Project not found' });

    const body = parseSystemPromptPreviewBody(req.body);
    const nextPresets = { ...presets, ...(body.presets ?? {}) };
    const activePresetIds = normalizeActivePresetIds(project.activePresetIds);
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
    if (err instanceof ProjectPresetsValidationError) {
      return res.status(400).json({ error: err.message, code: 'invalid_presets' });
    }
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
    if (!Array.isArray(characters) || !characters.every(isValidCharacterInput)) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class ProjectPresetsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPresetsValidationError';
  }
}

function parsePresetsPatch(value: unknown): Partial<PresetsFile> {
  if (!isRecord(value)) {
    throw new ProjectPresetsValidationError('プロンプト設定の形式が不正です。');
  }

  const patch: Partial<PresetsFile> = {};
  if (Object.hasOwn(value, 'userCustomPromptParts')) {
    if (
      !Array.isArray(value.userCustomPromptParts) ||
      value.userCustomPromptParts.some(
        (item) =>
          typeof item !== 'string' ||
          item.length > SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS
      ) ||
      value.userCustomPromptParts.reduce(
        (total, item) => total + (typeof item === 'string' ? item.length : 0),
        0
      ) > SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS
    ) {
      throw new ProjectPresetsValidationError(
        `追加プロンプトは合計${SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS.toLocaleString('ja-JP')}文字以内の文字列配列で指定してください。`
      );
    }
    patch.userCustomPromptParts = value.userCustomPromptParts;
  }
  if (Object.hasOwn(value, 'baseSystemPrompt')) {
    patch.baseSystemPrompt = validatePromptText(value.baseSystemPrompt, '基本プロンプト');
  }
  if (Object.hasOwn(value, 'customSystemPrompt')) {
    patch.customSystemPrompt = validatePromptText(value.customSystemPrompt, '追加指示');
  }
  return patch;
}

function parseSystemPromptPreviewBody(value: unknown): {
  presets?: Partial<PresetsFile>;
  customSystemPrompt?: string | null;
} {
  if (!isRecord(value)) {
    throw new ProjectPresetsValidationError('プロンプトプレビューの形式が不正です。');
  }
  const body: {
    presets?: Partial<PresetsFile>;
    customSystemPrompt?: string | null;
  } = {};
  if (Object.hasOwn(value, 'presets')) {
    body.presets = parsePresetsPatch(value.presets);
  }
  if (Object.hasOwn(value, 'customSystemPrompt')) {
    body.customSystemPrompt =
      value.customSystemPrompt === null
        ? null
        : validatePromptText(value.customSystemPrompt, '追加指示');
  }
  return body;
}

function validatePromptText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ProjectPresetsValidationError(`${label}は文字列で入力してください。`);
  }
  if (value.length > SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS) {
    throw new ProjectPresetsValidationError(
      `${label}は${SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS.toLocaleString('ja-JP')}文字以内で入力してください。`
    );
  }
  return value;
}
