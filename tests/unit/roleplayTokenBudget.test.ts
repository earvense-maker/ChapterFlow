import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as roleplayService from '../../src/server/services/roleplaySessionService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type { AdapterGenerateStreamEvent, Character } from '../../src/server/types/index';
import type { ModelTokenLimits } from '../../src/server/services/modelInfoService';

// NOTE: 設計書 5.2 末尾 / 10.1（32k/64k fixture 相当）。ロールプレイは 128k 級モデル限定にせず、
// 選択モデルの実際の上限で二次トークン確認を行う。必須節（固定規則・対象キャラ最低予約・
// scenario・最終指示）だけで収まらない場合は、stream を開始せず
// roleplay_context_budget_exceeded（retryable=false）を返すことを固定する。

let tokenLimitsOverride: ModelTokenLimits | null = null;
vi.mock('../../src/server/services/modelInfoService.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/services/modelInfoService')>();
  return {
    ...original,
    resolveModelTokenLimits: vi.fn(async (provider: string, modelName: string) => {
      if (tokenLimitsOverride) return tokenLimitsOverride;
      return original.resolveModelTokenLimits(provider, modelName);
    }),
  };
});

const createdProjectIds: string[] = [];

function baseCharacter(): Character {
  return {
    characterId: 'char-a',
    name: 'アリス',
    role: 'protagonist',
    description: '穏やかな女子高生。',
    speechStyle: '柔らかい丁寧語',
    greeting: 'あ、来てくれたんだ。',
    dialogueExamples: ['……ここ、隣あいてるよ。'],
  };
}

async function makeRoleplayProject(): Promise<Awaited<ReturnType<typeof projectService.createProject>>> {
  const project = await projectService.createProject({
    title: 'RP Token Budget Test',
    projectType: 'roleplay',
    scenarioSeeds: ['放課後の教室で二人きり'],
    characters: [baseCharacter()],
    worldText: '架空の日本の高校を舞台にした穏やかな日常。',
  });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  vi.restoreAllMocks();
  tokenLimitsOverride = null;
  await Promise.all(
    createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
  createdProjectIds.length = 0;
});

describe('ロールプレイの二次トークン予算（設計書 5.2 / 11-5）', () => {
  it('必須節だけで選択モデルのcontext上限へ収まらない場合、streamを開始せず roleplay_context_budget_exceeded を返す', async () => {
    const project = await makeRoleplayProject();
    // 保守的推定（非ASCII 2.5 tokens/char）では最小構成の system+user でも超過する
    // 小さい context の fixture。文字数 24,000 字の上限は満たしている。
    tokenLimitsOverride = {
      contextWindowTokens: 4_000,
      inputTokenLimit: 4_000,
      outputTokenLimit: 1_024,
      source: 'inferred',
    };
    const streamText = vi.spyOn(GeminiAdapter.prototype, 'generateTextStream');
    const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText');

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const errors: Array<{ code?: string; retryable?: boolean }> = [];
    try {
      for await (const event of roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'こんにちは',
        revision: created.revision,
      })) {
        if (event.type === 'error') errors.push(event.error);
      }
    } catch (err) {
      if (err instanceof roleplayService.RoleplayServiceError) {
        errors.push({ code: err.code, retryable: err.retryable });
      } else {
        throw err;
      }
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'roleplay_context_budget_exceeded',
      retryable: false,
    });
    // トークン確認は本文生成より前。チャンクは一切送らず、モデルも呼ばない。
    expect(streamText).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });
});
