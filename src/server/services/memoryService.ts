import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import { MEMORY_CONTENT_MAX_CHARS } from '../../shared/types.js';
import type { Memory, MemoryImportance, MemoryType } from '../types/index.js';

const MEMORY_TYPES: MemoryType[] = ['storyFact', 'preference', 'negative'];
const MEMORY_IMPORTANCE: MemoryImportance[] = ['high', 'medium', 'low'];
const RELATED_ID_MAX_CHARS = 200;
const RELATED_ID_MAX_ITEMS = 100;

export async function listMemories(projectId: string): Promise<Memory[]> {
  return (await storage.readMemories(projectId)).filter((m) => m.status === 'active');
}

export async function createMemory(
  projectId: string,
  input: {
    type: MemoryType;
    content: string;
    importance?: MemoryImportance;
    relatedCharacters?: string[];
    relatedEpisodes?: string[];
  }
): Promise<Memory> {
  const normalized = validateMemoryInput(input, false);
  const memories = await storage.readMemories(projectId);
  const memory: Memory = {
    memoryId: generateTimestampId('mem'),
    type: normalized.type as MemoryType,
    content: normalized.content as string,
    importance: normalized.importance ?? 'medium',
    relatedCharacters: normalized.relatedCharacters ?? [],
    relatedEpisodes: normalized.relatedEpisodes ?? [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    sourceSceneId: null,
    status: 'active',
    source: 'manual',
  };
  memories.push(memory);
  await storage.writeMemories(projectId, memories);
  return memory;
}

export async function updateMemory(
  projectId: string,
  memoryId: string,
  input: Partial<Omit<Memory, 'memoryId' | 'createdAt' | 'updatedAt'>>
): Promise<Memory> {
  const normalized = validateMemoryInput(input, true);
  const memories = await storage.readMemories(projectId);
  const idx = memories.findIndex((m) => m.memoryId === memoryId);
  if (idx === -1) throw new MemoryNotFoundError(memoryId);

  memories[idx] = {
    ...memories[idx],
    ...normalized,
    updatedAt: nowIso(),
  };
  await storage.writeMemories(projectId, memories);
  return memories[idx];
}

export async function deleteMemory(projectId: string, memoryId: string): Promise<void> {
  const memories = await storage.readMemories(projectId);
  const idx = memories.findIndex((m) => m.memoryId === memoryId);
  if (idx === -1) throw new MemoryNotFoundError(memoryId);
  memories[idx].status = 'archived';
  memories[idx].updatedAt = nowIso();
  await storage.writeMemories(projectId, memories);
}

function validateMemoryInput(
  value: unknown,
  partial: boolean
): Partial<Pick<Memory, 'type' | 'content' | 'importance' | 'relatedCharacters' | 'relatedEpisodes'>> {
  if (!isRecord(value)) {
    throw new MemoryValidationError('記憶の入力内容が不正です。');
  }

  const normalized: Partial<
    Pick<Memory, 'type' | 'content' | 'importance' | 'relatedCharacters' | 'relatedEpisodes'>
  > = {};
  if (!partial || Object.hasOwn(value, 'type')) {
    if (typeof value.type !== 'string' || !MEMORY_TYPES.includes(value.type as MemoryType)) {
      throw new MemoryValidationError('記憶の種類が不正です。');
    }
    normalized.type = value.type as MemoryType;
  }
  if (!partial || Object.hasOwn(value, 'content')) {
    if (typeof value.content !== 'string') {
      throw new MemoryValidationError('記憶の内容は文字列で指定してください。');
    }
    const content = value.content.trim();
    if (!content) {
      throw new MemoryValidationError('記憶の内容を入力してください。');
    }
    if (content.length > MEMORY_CONTENT_MAX_CHARS) {
      throw new MemoryValidationError(
        `記憶の内容は${MEMORY_CONTENT_MAX_CHARS.toLocaleString('ja-JP')}文字以内で指定してください。`
      );
    }
    normalized.content = content;
  }
  if (Object.hasOwn(value, 'importance')) {
    if (
      typeof value.importance !== 'string' ||
      !MEMORY_IMPORTANCE.includes(value.importance as MemoryImportance)
    ) {
      throw new MemoryValidationError('記憶の重要度が不正です。');
    }
    normalized.importance = value.importance as MemoryImportance;
  }
  if (Object.hasOwn(value, 'relatedCharacters')) {
    normalized.relatedCharacters = validateRelatedIds(value.relatedCharacters, '関連人物');
  }
  if (Object.hasOwn(value, 'relatedEpisodes')) {
    normalized.relatedEpisodes = validateRelatedIds(value.relatedEpisodes, '関連エピソード');
  }
  if (partial && Object.keys(normalized).length === 0) {
    throw new MemoryValidationError('更新する項目がありません。');
  }
  return normalized;
}

function validateRelatedIds(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length > RELATED_ID_MAX_ITEMS ||
    !value.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= RELATED_ID_MAX_CHARS
    )
  ) {
    throw new MemoryValidationError(`${label}が不正です。`);
  }
  return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

export class MemoryNotFoundError extends Error {
  constructor(memoryId: string) {
    super(`記憶が見つかりません: ${memoryId}`);
    this.name = 'MemoryNotFoundError';
  }
}
