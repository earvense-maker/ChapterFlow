import {
  SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS,
  SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS,
} from '../types/index.js';
import type { SystemPromptPreset, SystemPromptPresetsFile } from '../types/index.js';
import { SYSTEM_PROMPT_PRESETS_PATH } from '../config.js';
import { generateId } from '../utils/id.js';
import { readJsonFile, safeWriteJson } from '../utils/safeWrite.js';
import { withDataDirWrite } from './dataDirLock.js';

const EMPTY_FILE: SystemPromptPresetsFile = { schemaVersion: 1, items: [] };
const SAFE_PRESET_ID = /^[A-Za-z0-9_-]+$/;

// NOTE: safeWriteJson はファイル単体の置換を安全にするが、読み取り→更新→書き込みの
// 競合までは防がない。プリセット操作だけを直列化して同時保存時の取りこぼしを防ぐ。
let mutationQueue: Promise<void> = Promise.resolve();

export class SystemPromptPresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPromptPresetValidationError';
  }
}

export class SystemPromptPresetNotFoundError extends Error {
  constructor() {
    super('System prompt preset not found');
    this.name = 'SystemPromptPresetNotFoundError';
  }
}

export class SystemPromptPresetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPromptPresetConflictError';
  }
}

export async function listSystemPromptPresets(): Promise<SystemPromptPreset[]> {
  return (await readPresetFile()).items;
}

export async function createSystemPromptPreset(input: {
  name: unknown;
  prompt: unknown;
}): Promise<SystemPromptPreset> {
  const name = normalizeName(input.name);
  const prompt = normalizePrompt(input.prompt);

  return enqueueMutation(async () => {
    const file = await readPresetFile();
    if (findPresetByName(file.items, name)) {
      throw new SystemPromptPresetConflictError(`プリセット「${name}」はすでに存在します`);
    }
    const now = new Date().toISOString();
    const preset: SystemPromptPreset = {
      id: generateId('system-prompt'),
      name,
      prompt,
      createdAt: now,
      updatedAt: now,
    };
    await safeWriteJson(SYSTEM_PROMPT_PRESETS_PATH, {
      schemaVersion: 1,
      items: [preset, ...file.items],
    } satisfies SystemPromptPresetsFile);
    return preset;
  });
}

export async function updateSystemPromptPreset(
  id: string,
  input: { name: unknown; prompt: unknown; expectedUpdatedAt: unknown }
): Promise<SystemPromptPreset> {
  assertPresetId(id);
  const name = normalizeName(input.name);
  const prompt = normalizePrompt(input.prompt);
  const expectedUpdatedAt = normalizeExpectedUpdatedAt(input.expectedUpdatedAt);

  return enqueueMutation(async () => {
    const file = await readPresetFile();
    const index = file.items.findIndex((item) => item.id === id);
    if (index < 0) throw new SystemPromptPresetNotFoundError();
    if (file.items[index].updatedAt !== expectedUpdatedAt) {
      throw new SystemPromptPresetConflictError(
        'このプリセットは別の画面で更新されています。一覧を再読み込みしてください'
      );
    }
    const sameNamePreset = findPresetByName(file.items, name);
    if (sameNamePreset && sameNamePreset.id !== id) {
      throw new SystemPromptPresetConflictError(`プリセット「${name}」はすでに存在します`);
    }

    const updated: SystemPromptPreset = {
      ...file.items[index],
      name,
      prompt,
      updatedAt: nextUpdatedAt(file.items[index].updatedAt),
    };
    await safeWriteJson(SYSTEM_PROMPT_PRESETS_PATH, {
      schemaVersion: 1,
      items: [updated, ...file.items.filter((item) => item.id !== id)],
    } satisfies SystemPromptPresetsFile);
    return updated;
  });
}

export async function deleteSystemPromptPreset(id: string): Promise<void> {
  assertPresetId(id);
  await enqueueMutation(async () => {
    const file = await readPresetFile();
    if (!file.items.some((item) => item.id === id)) {
      throw new SystemPromptPresetNotFoundError();
    }
    await safeWriteJson(SYSTEM_PROMPT_PRESETS_PATH, {
      schemaVersion: 1,
      items: file.items.filter((item) => item.id !== id),
    } satisfies SystemPromptPresetsFile);
  });
}

async function readPresetFile(): Promise<SystemPromptPresetsFile> {
  const file = await readJsonFile<SystemPromptPresetsFile>(SYSTEM_PROMPT_PRESETS_PATH);
  if (!file) return EMPTY_FILE;
  if (file.schemaVersion !== 1 || !Array.isArray(file.items)) {
    throw new Error('Invalid system-prompt-presets.json');
  }
  if (!file.items.every(isSystemPromptPreset)) {
    throw new Error('Invalid item in system-prompt-presets.json');
  }
  const normalizedNames = file.items.map((item) => normalizeNameKey(item.name));
  if (new Set(normalizedNames).size !== normalizedNames.length) {
    throw new Error('Duplicate names in system-prompt-presets.json');
  }
  return file;
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SystemPromptPresetValidationError('プリセット名を入力してください');
  }
  const name = value.trim();
  if (name.length > SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS) {
    throw new SystemPromptPresetValidationError(
      `プリセット名は${SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS}文字以内で入力してください`
    );
  }
  return name;
}

function normalizePrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SystemPromptPresetValidationError('システムプロンプトを入力してください');
  }
  if (value.length > SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS) {
    throw new SystemPromptPresetValidationError(
      `システムプロンプトは${SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS}文字以内で入力してください`
    );
  }
  return value;
}

function assertPresetId(id: string): void {
  if (!SAFE_PRESET_ID.test(id)) throw new SystemPromptPresetNotFoundError();
}

function normalizeExpectedUpdatedAt(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new SystemPromptPresetValidationError('更新日時が指定されていません');
  }
  return value;
}

function findPresetByName(items: SystemPromptPreset[], name: string): SystemPromptPreset | undefined {
  const key = normalizeNameKey(name);
  return items.find((item) => normalizeNameKey(item.name) === key);
}

function normalizeNameKey(name: string): string {
  return name.toLocaleLowerCase('ja-JP');
}

function isSystemPromptPreset(value: unknown): value is SystemPromptPreset {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SystemPromptPreset>;
  return (
    typeof item.id === 'string' &&
    SAFE_PRESET_ID.test(item.id) &&
    typeof item.name === 'string' &&
    Boolean(item.name.trim()) &&
    item.name.length <= SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS &&
    typeof item.prompt === 'string' &&
    Boolean(item.prompt.trim()) &&
    item.prompt.length <= SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS &&
    isIsoTimestamp(item.createdAt) &&
    isIsoTimestamp(item.updatedAt)
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(
    () => withDataDirWrite(operation),
    () => withDataDirWrite(operation)
  );
  mutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
