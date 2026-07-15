import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS,
  SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS,
} from '../../src/shared/types';
import { SYSTEM_PROMPT_PRESETS_PATH } from '../../src/server/config';
import {
  createSystemPromptPreset,
  deleteSystemPromptPreset,
  listSystemPromptPresets,
  SystemPromptPresetNotFoundError,
  SystemPromptPresetConflictError,
  SystemPromptPresetValidationError,
  updateSystemPromptPreset,
} from '../../src/server/services/systemPromptPresetService';

describe('systemPromptPresetService', () => {
  beforeEach(async () => {
    await fs.rm(SYSTEM_PROMPT_PRESETS_PATH, { force: true });
  });

  it('returns an empty list before the preset file exists', async () => {
    await expect(listSystemPromptPresets()).resolves.toEqual([]);
  });

  it('creates, updates, lists, and deletes a preset', async () => {
    const created = await createSystemPromptPreset({
      name: '  静かな三人称  ',
      prompt: '静かな三人称で書く。',
    });

    expect(created.name).toBe('静かな三人称');
    expect(await listSystemPromptPresets()).toEqual([created]);

    const updated = await updateSystemPromptPreset(created.id, {
      name: '静かな一人称',
      prompt: '一人称で書く。',
      expectedUpdatedAt: created.updatedAt,
    });
    expect(updated).toMatchObject({
      id: created.id,
      name: '静かな一人称',
      prompt: '一人称で書く。',
      createdAt: created.createdAt,
    });
    expect(await listSystemPromptPresets()).toEqual([updated]);

    await deleteSystemPromptPreset(created.id);
    await expect(listSystemPromptPresets()).resolves.toEqual([]);
  });

  it('serializes concurrent creates without dropping a preset', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createSystemPromptPreset({ name: `プリセット${index}`, prompt: `本文${index}` })
      )
    );

    const items = await listSystemPromptPresets();
    expect(items).toHaveLength(8);
    expect(new Set(items.map((item) => item.name)).size).toBe(8);
  });

  it('rejects duplicate names and stale updates', async () => {
    const created = await createSystemPromptPreset({ name: '静かな文体', prompt: '本文1' });
    await expect(
      createSystemPromptPreset({ name: '静かな文体', prompt: '本文2' })
    ).rejects.toBeInstanceOf(SystemPromptPresetConflictError);

    const updated = await updateSystemPromptPreset(created.id, {
      name: created.name,
      prompt: '本文3',
      expectedUpdatedAt: created.updatedAt,
    });
    await expect(
      updateSystemPromptPreset(created.id, {
        name: created.name,
        prompt: '古い本文',
        expectedUpdatedAt: created.updatedAt,
      })
    ).rejects.toBeInstanceOf(SystemPromptPresetConflictError);
    expect((await listSystemPromptPresets())[0].prompt).toBe(updated.prompt);
  });

  it('rejects malformed persisted items', async () => {
    await fs.mkdir(path.dirname(SYSTEM_PROMPT_PRESETS_PATH), { recursive: true });
    await fs.writeFile(
      SYSTEM_PROMPT_PRESETS_PATH,
      JSON.stringify({ schemaVersion: 1, items: [{ id: 'broken' }] }),
      'utf-8'
    );
    await expect(listSystemPromptPresets()).rejects.toThrow(
      'Invalid item in system-prompt-presets.json'
    );
  });

  it.each([
    [{ name: '', prompt: '本文' }, 'プリセット名を入力してください'],
    [{ name: '名前', prompt: '   ' }, 'システムプロンプトを入力してください'],
    [
      { name: 'あ'.repeat(SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS + 1), prompt: '本文' },
      `${SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS}文字以内`,
    ],
    [
      { name: '名前', prompt: 'あ'.repeat(SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS + 1) },
      `${SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS}文字以内`,
    ],
  ])('rejects invalid create input %#', async (input, message) => {
    await expect(createSystemPromptPreset(input)).rejects.toThrow(message);
    await expect(createSystemPromptPreset(input)).rejects.toBeInstanceOf(
      SystemPromptPresetValidationError
    );
  });

  it('reports missing and unsafe ids as not found', async () => {
    await expect(
      updateSystemPromptPreset('missing-id', {
        name: '名前',
        prompt: '本文',
        expectedUpdatedAt: new Date().toISOString(),
      })
    ).rejects.toBeInstanceOf(SystemPromptPresetNotFoundError);
    await expect(deleteSystemPromptPreset('../outside')).rejects.toBeInstanceOf(
      SystemPromptPresetNotFoundError
    );
  });
});
