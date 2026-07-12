import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import * as knowledgeService from '../../src/server/services/knowledgeService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { safeWriteFile } from '../../src/server/utils/safeWrite';

const createdProjectIds: string[] = [];

async function createProject() {
  const project = await projectService.createProject({ title: 'Knowledge Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('knowledgeService', () => {
  it('creates, lists, updates, reorders, and deletes knowledge files', async () => {
    const project = await createProject();

    const first = await knowledgeService.createKnowledge(project.projectId, {
      fileName: '用語集.md',
      content: '王都: 白い塔の街',
    });
    const second = await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'timeline.txt',
      content: '1日目: 出会い',
    });

    expect(first.enabled).toBe(true);
    expect(first.order).toBe(0);
    expect(second.order).toBe(1);

    await knowledgeService.updateKnowledge(project.projectId, first.knowledgeId, {
      title: '王都用語',
      content: '王都: 運河沿いの白い塔の街',
      enabled: false,
    });

    const content = await knowledgeService.getKnowledgeContent(project.projectId, first.knowledgeId);
    expect(content.meta.title).toBe('王都用語');
    expect(content.content).toContain('運河沿い');

    const reordered = await knowledgeService.reorderKnowledge(project.projectId, [
      second.knowledgeId,
      first.knowledgeId,
    ]);
    expect(reordered.map((item) => item.knowledgeId)).toEqual([
      second.knowledgeId,
      first.knowledgeId,
    ]);
    expect(reordered.map((item) => item.order)).toEqual([0, 1]);

    const moved = await knowledgeService.updateKnowledge(project.projectId, first.knowledgeId, {
      order: 0,
    });
    expect(moved.order).toBe(0);
    await expect(knowledgeService.listKnowledge(project.projectId)).resolves.toMatchObject([
      { knowledgeId: first.knowledgeId, order: 0 },
      { knowledgeId: second.knowledgeId, order: 1 },
    ]);

    await knowledgeService.deleteKnowledge(project.projectId, first.knowledgeId);
    const list = await knowledgeService.listKnowledge(project.projectId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      knowledgeId: second.knowledgeId,
      contentStatus: 'ok',
    });
  });

  it('reflects direct file edits in list results without rewriting knowledge.json', async () => {
    const project = await createProject();
    const file = await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'notes.md',
      content: 'old',
    });
    const indexPath = storage.knowledgeIndexJsonPath(project.projectId);
    const before = await fs.readFile(indexPath, 'utf-8');

    await storage.writeKnowledgeContent(project.projectId, file.knowledgeId, file.extension, 'new text');
    const list = await knowledgeService.listKnowledge(project.projectId);
    const after = await fs.readFile(indexPath, 'utf-8');

    expect(list[0].charCount).toBe('new text'.length);
    expect(after).toBe(before);
  });

  it('marks missing or empty enabled files and excludes them from prompt injection', async () => {
    const project = await createProject();
    const missing = await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'missing.md',
      content: 'will be deleted',
    });
    await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'empty.txt',
      content: '   ',
    });
    await storage.deleteKnowledgeContent(project.projectId, missing.knowledgeId, missing.extension);

    const list = await knowledgeService.listKnowledge(project.projectId);
    expect(list.map((item) => item.contentStatus).sort()).toEqual(['empty', 'missing']);
    await expect(knowledgeService.getEnabledKnowledgeTexts(project.projectId)).resolves.toEqual([]);
  });

  it('rejects invalid schema records instead of silently repairing them', async () => {
    const project = await createProject();
    await safeWriteFile(
      storage.knowledgeIndexJsonPath(project.projectId),
      JSON.stringify({
        schemaVersion: 1,
        files: [
          {
            knowledgeId: 'kb-bad',
            title: 'bad',
            originalFileName: 'bad.md',
            extension: '../x',
            enabled: true,
            order: 0,
            charCount: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
      })
    );

    await expect(knowledgeService.listKnowledge(project.projectId)).rejects.toThrow(
      knowledgeService.KnowledgeValidationError
    );
  });

  it('rejects duplicate knowledge IDs in the index', async () => {
    const project = await createProject();
    await safeWriteFile(
      storage.knowledgeIndexJsonPath(project.projectId),
      JSON.stringify({
        schemaVersion: 1,
        files: [
          {
            knowledgeId: 'kb-dup',
            title: 'first',
            originalFileName: 'first.md',
            extension: 'md',
            enabled: true,
            order: 0,
            charCount: 1,
            createdAt: '',
            updatedAt: '',
          },
          {
            knowledgeId: 'kb-dup',
            title: 'second',
            originalFileName: 'second.md',
            extension: 'md',
            enabled: true,
            order: 1,
            charCount: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
      })
    );

    await expect(knowledgeService.listKnowledge(project.projectId)).rejects.toThrow(
      'Duplicate knowledgeId'
    );
  });

  it('cleans orphan content files on the next write operation', async () => {
    const project = await createProject();
    await storage.writeKnowledgeContent(project.projectId, 'kb-orphan', 'md', 'orphan');
    const orphanPath = storage.knowledgeContentPath(project.projectId, 'kb-orphan', 'md');

    await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'kept.md',
      content: 'kept',
    });

    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates content limits, extension, and reorder completeness', async () => {
    const project = await createProject();
    const file = await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'ok.md',
      content: 'ok',
    });

    await expect(
      knowledgeService.createKnowledge(project.projectId, {
        fileName: 'bad.html',
        content: 'x',
      })
    ).rejects.toThrow(knowledgeService.KnowledgeValidationError);

    await expect(
      knowledgeService.updateKnowledge(project.projectId, file.knowledgeId, {
        content: 'x'.repeat(200_001),
      })
    ).rejects.toThrow('20万字');

    await expect(
      knowledgeService.reorderKnowledge(project.projectId, [file.knowledgeId, file.knowledgeId])
    ).rejects.toThrow(knowledgeService.KnowledgeValidationError);
  });
});
