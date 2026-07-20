import { afterEach, describe, expect, it } from 'vitest';
import * as memoryService from '../../src/server/services/memoryService.js';
import * as projectService from '../../src/server/services/projectService.js';
import * as storage from '../../src/server/services/storageService.js';

const createdProjectIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdProjectIds
      .splice(0)
      .map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
});

describe('memoryService validation', () => {
  it('rejects invalid and empty create inputs without persisting them', async () => {
    const project = await projectService.createProject({ title: 'memory validation' });
    createdProjectIds.push(project.projectId);

    await expect(
      memoryService.createMemory(project.projectId, {
        type: 'other',
        content: 'content',
      } as never)
    ).rejects.toBeInstanceOf(memoryService.MemoryValidationError);
    await expect(
      memoryService.createMemory(project.projectId, {
        type: 'storyFact',
        content: '   ',
      })
    ).rejects.toBeInstanceOf(memoryService.MemoryValidationError);

    expect(await storage.readMemories(project.projectId)).toEqual([]);
  });

  it('only applies validated editable fields on update', async () => {
    const project = await projectService.createProject({ title: 'memory update' });
    createdProjectIds.push(project.projectId);
    const memory = await memoryService.createMemory(project.projectId, {
      type: 'storyFact',
      content: 'before',
    });

    const updated = await memoryService.updateMemory(project.projectId, memory.memoryId, {
      content: ' after ',
      memoryId: 'replaced',
      createdAt: 'invalid',
    } as never);

    expect(updated.memoryId).toBe(memory.memoryId);
    expect(updated.createdAt).toBe(memory.createdAt);
    expect(updated.content).toBe('after');
  });
});
