import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as expressionService from '../../src/server/services/expressionService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { CONFIG_DIR } from '../../src/server/config';
import type { EpisodeRecord, GenerationRecord } from '../../src/server/types/index';

const createdProjectIds: string[] = [];
const globalExpressionsPath = path.join(CONFIG_DIR, 'global-expressions.json');

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Expression Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
  await fs.rm(globalExpressionsPath, { force: true });
});

async function writeAcceptedText(projectId: string, text: string): Promise<void> {
  const episodeId = 'ep-1';
  const sceneId = 'scene-1';
  const generationId = 'gen-1';
  const episode: EpisodeRecord = {
    episodeId,
    title: '第1章',
    order: 1,
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    scenes: [
      {
        sceneId,
        episodeId,
        order: 1,
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
        acceptedGenerationId: generationId,
        draftGenerationIds: [generationId],
      },
    ],
  };
  const generation: GenerationRecord = {
    generationId,
    sceneId,
    episodeId,
    request: { wish: '', outputLength: 1000, previousContextText: '' },
    responseText: text,
    usedPresets: {
      narration: 'third-close',
    },
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    referencedMemoryIds: [],
    status: 'accepted',
    createdAt: '2026-07-02T00:00:00Z',
    parentGenerationId: null,
  };
  await storage.writeEpisodeRecord(projectId, episode);
  await storage.appendGenerationLog(projectId, generation);
}

describe('expressionService NG expressions', () => {
  it('normalizes whitespace and trims on creation', async () => {
    const projectId = await createTrackedProject();
    const { expression } = await expressionService.createExpression(projectId, {
      text: '  息を  呑んだ  ',
    });
    expect(expression.text).toBe('息を 呑んだ');
  });

  it('returns existing active expression for duplicate text', async () => {
    const projectId = await createTrackedProject();
    const first = await expressionService.createExpression(projectId, { text: '重複表現' });
    const second = await expressionService.createExpression(projectId, { text: '重複表現' });
    expect(second.isExisting).toBe(true);
    expect(second.expression.id).toBe(first.expression.id);
  });

  it('rejects text longer than 30 characters', async () => {
    const projectId = await createTrackedProject();
    await expect(
      expressionService.createExpression(projectId, { text: 'a'.repeat(31) })
    ).rejects.toThrow(expressionService.ExpressionValidationError);
  });

  it('rejects empty text but accepts a single character', async () => {
    const projectId = await createTrackedProject();
    await expect(
      expressionService.createExpression(projectId, { text: '' })
    ).rejects.toThrow(expressionService.ExpressionValidationError);
    const { expression } = await expressionService.createExpression(projectId, { text: 'a' });
    expect(expression.text).toBe('a');
  });

  it('rejects text containing newlines', async () => {
    const projectId = await createTrackedProject();
    await expect(
      expressionService.createExpression(projectId, { text: '改行\n含む' })
    ).rejects.toThrow(expressionService.ExpressionValidationError);
    await expect(
      expressionService.createExpression(projectId, { text: '改行\r含む' })
    ).rejects.toThrow(expressionService.ExpressionValidationError);
  });

  it('enforces the active expression limit of 50', async () => {
    const projectId = await createTrackedProject();
    for (let i = 0; i < 50; i++) {
      await expressionService.createExpression(projectId, { text: `expr-${i}` });
    }
    await expect(
      expressionService.createExpression(projectId, { text: 'one-too-many' })
    ).rejects.toThrow(expressionService.ExpressionLimitError);
  });

  it('archives an expression on delete', async () => {
    const projectId = await createTrackedProject();
    const { expression } = await expressionService.createExpression(projectId, { text: '削除対象' });
    await expressionService.archiveExpression(projectId, expression.id);
    const active = await expressionService.getExpressions(projectId);
    expect(active).toHaveLength(0);
  });
});

describe('expressionService banned expression resolution', () => {
  it('returns only user-registered NG expressions (no automatic frequent-phrase injection)', async () => {
    const projectId = await createTrackedProject();
    // 頻出フレーズが本文にあっても、自動では回避リストに乗らない
    const text = '繰り返しフレーズ。'.repeat(10);
    await writeAcceptedText(projectId, text);
    await expressionService.createExpression(projectId, { text: 'ユーザーNG1' });
    await expressionService.createExpression(projectId, { text: 'ユーザーNG2' });

    const banned = await expressionService.resolveBannedExpressions(projectId);
    expect(banned).toEqual(expect.arrayContaining(['ユーザーNG1', 'ユーザーNG2']));
    expect(banned).toHaveLength(2);
    expect(banned.some((b) => b.includes('繰り返しフレーズ'))).toBe(false);
  });

  it('returns empty when no NG expression is registered, even with frequent phrases in the text', async () => {
    const projectId = await createTrackedProject();
    const text = '重複表現。'.repeat(10);
    await writeAcceptedText(projectId, text);
    const banned = await expressionService.resolveBannedExpressions(projectId);
    expect(banned).toEqual([]);
  });

  it('caps user-registered banned expressions at the per-prompt limit', async () => {
    const projectId = await createTrackedProject();
    for (let i = 0; i < expressionService.BAN_LIMIT_TOTAL + 3; i++) {
      await expressionService.createExpression(projectId, { text: `ユーザーNG${i}` });
    }
    const banned = await expressionService.resolveBannedExpressions(projectId);
    expect(banned.length).toBe(expressionService.BAN_LIMIT_TOTAL);
  });

  it('applies common NG expressions to every project while keeping project NG local', async () => {
    const firstProjectId = await createTrackedProject();
    const secondProjectId = await createTrackedProject();
    await expressionService.createGlobalExpression({ text: '共通の言い回し' });
    await expressionService.createExpression(firstProjectId, { text: '作品だけの言い回し' });

    await expect(expressionService.resolveBannedExpressions(firstProjectId)).resolves.toEqual(
      expect.arrayContaining(['共通の言い回し', '作品だけの言い回し'])
    );
    await expect(expressionService.resolveBannedExpressions(secondProjectId)).resolves.toEqual([
      '共通の言い回し',
    ]);
  });

  it('deduplicates normalized common and project expressions in the prompt result', async () => {
    const projectId = await createTrackedProject();
    await expressionService.createGlobalExpression({ text: '同じ  表現' });
    await expressionService.createExpression(projectId, { text: '同じ 表現' });

    await expect(expressionService.resolveBannedExpressions(projectId)).resolves.toEqual(['同じ 表現']);
  });

  it('serializes concurrent common NG updates without dropping any expression', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        expressionService.createGlobalExpression({ text: `共通-${index}` })
      )
    );

    await expect(expressionService.getGlobalExpressions()).resolves.toHaveLength(12);
  });

  it('falls back to project NG expressions when the common file is corrupt', async () => {
    const projectId = await createTrackedProject();
    await expressionService.createExpression(projectId, { text: '作品NG' });
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.writeFile(globalExpressionsPath, '{broken', 'utf8');

    await expect(expressionService.getGlobalExpressions()).rejects.toThrow(
      expressionService.GlobalExpressionsCorruptError
    );
    await expect(expressionService.resolveBannedExpressions(projectId)).resolves.toEqual(['作品NG']);
  });

});
