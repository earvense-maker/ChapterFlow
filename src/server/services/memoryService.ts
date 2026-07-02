import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type { Memory, MemoryImportance, MemoryType } from '../types/index.js';

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
  const memories = await storage.readMemories(projectId);
  const memory: Memory = {
    memoryId: generateTimestampId('mem'),
    type: input.type,
    content: input.content.trim(),
    importance: input.importance || 'medium',
    relatedCharacters: input.relatedCharacters || [],
    relatedEpisodes: input.relatedEpisodes || [],
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
  const memories = await storage.readMemories(projectId);
  const idx = memories.findIndex((m) => m.memoryId === memoryId);
  if (idx === -1) throw new Error(`Memory not found: ${memoryId}`);

  memories[idx] = {
    ...memories[idx],
    ...input,
    updatedAt: nowIso(),
  };
  await storage.writeMemories(projectId, memories);
  return memories[idx];
}

export async function deleteMemory(projectId: string, memoryId: string): Promise<void> {
  const memories = await storage.readMemories(projectId);
  const idx = memories.findIndex((m) => m.memoryId === memoryId);
  if (idx === -1) throw new Error(`Memory not found: ${memoryId}`);
  memories[idx].status = 'archived';
  memories[idx].updatedAt = nowIso();
  await storage.writeMemories(projectId, memories);
}
