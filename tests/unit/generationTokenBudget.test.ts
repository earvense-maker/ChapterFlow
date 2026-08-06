import { afterEach, describe, expect, it, vi } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as generationService from '../../src/server/services/generationService';
import * as knowledgeService from '../../src/server/services/knowledgeService';
import * as storage from '../../src/server/services/storageService';
import { OpenAIAdapter } from '../../src/server/adapters/openaiAdapter';
import {
  NOVEL_TOTAL_PROMPT_MAX_CHARS,
  NOVEL_USER_PROMPT_MAX_CHARS,
} from '../../src/server/prompts/promptBudget';
import type { ModelTokenLimits } from '../../src/server/services/modelInfoService';
import type { GenerateError } from '../../src/server/services/generationErrors';

// NOTE: AC1（設計書 11-1）の回帰テスト。128k モデルで日本語入力を渡すと
// 保守的推定（非ASCII 2.5 tokens/char）で必ず超過するため、組み立て直し（最大3回）の
// 縮小ループが動いて収まること、収まらない場合は生成を開始せず型付きエラーを返すこと、
// を固定する。provider 実測（countPromptTokens）は gemini のみで、テストは openai を
// 使うため常に null → 保守的推定経路で決定的に走る。

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

async function createTrackedProject(): Promise<Awaited<ReturnType<typeof projectService.createProject>>> {
  const project = await projectService.createProject({
    title: 'Token Budget Test',
    activeModelProvider: 'openai',
    activeModelName: 'gpt-4o-mini',
  });
  createdProjectIds.push(project.projectId);
  return projectService.updateProject(project.projectId, {
    refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
  });
}

function enableDevDiagnostics(): void {
  process.env.CHAPTERFLOW_DEV_DIAGNOSTICS = '1';
}

afterEach(async () => {
  vi.restoreAllMocks();
  tokenLimitsOverride = null;
  delete process.env.CHAPTERFLOW_DEV_DIAGNOSTICS;
  await Promise.all(
    createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
  createdProjectIds.length = 0;
});

describe('小説の二次トークン予算（設計書 3.1 / 11-1）', () => {
  it('200,000字資料を積んでも、保守的推定で予算超過を検出し縮小してから生成を開始する', async () => {
    enableDevDiagnostics();
    const project = await createTrackedProject();
    await knowledgeService.createKnowledge(project.projectId, {
      fileName: 'long.md',
      content: 'あ'.repeat(200_000),
    });
    await storage.writeWorld(project.projectId, {
      foundation: 'あ'.repeat(50_000),
      initialSituation: 'い'.repeat(10_000),
    });
    const presets = await storage.readPresets(project.projectId);
    if (!presets) throw new Error('Project presets not found');
    await storage.writePresets(project.projectId, {
      ...presets,
      // system 側も実行時上限近くまで埋め、128k context でも初回の保守的推定が
      // 必ず超過するようにする。保存原文は systemPrompt 側で部分採用される。
      baseSystemPrompt: '基'.repeat(100_000),
      customSystemPrompt: '追'.repeat(100_000),
    });
    // 人物欄も埋めて初期組み立てを 56,000 字付近へ寄せる（文字数予算は保証済みでも
    // トークン予算は必ず超過する構成）。
    await storage.writeCharacters(
      project.projectId,
      Array.from({ length: 8 }, (_, index) => ({
        characterId: `char-${index}`,
        name: `人物${index}`,
        role: index === 0 ? ('protagonist' as const) : ('supporting' as const),
        description: '地'.repeat(4_000),
        speechStyle: '',
      }))
    );

    const generateText = vi.spyOn(OpenAIAdapter.prototype, 'generateText').mockResolvedValue({
      text: '予算内に縮小されて生成された本文',
      finishReason: 'stop',
      retryable: false,
    });

    const record = await generationService.generateScene(project.projectId, {
      wish: '続き',
      mode: 'continue',
    });

    // 文字数一次上限は絶対に守られる。
    expect(record.promptBudgetReport?.assembledChars).toBeLessThanOrEqual(
      NOVEL_TOTAL_PROMPT_MAX_CHARS
    );
    // buildPrompt の初回予算は NOVEL_USER_PROMPT_MAX_CHARS。これより小さい maxChars が
    // 記録されていれば、二次トークン確認後に rebuildWithUserBudget が実行された証拠になる。
    expect(record.promptBudgetReport?.maxChars).toBeLessThan(NOVEL_USER_PROMPT_MAX_CHARS);
    // 二次トークン確認は保守的推定（provider実測なし）で走り、判定不能のまま生成しない。
    expect(record.promptBudgetReport?.tokenCheck?.source).toBe('conservative');
    const check = record.promptBudgetReport?.tokenCheck;
    expect(check).toBeDefined();
    expect(check!.promptTokens + check!.estimatedMaxOutputTokens + check!.safetyMarginTokens).toBeLessThanOrEqual(
      128_000
    );
    // 縮小後に一度だけ本文生成へ進む。
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('必須節だけでモデル入力上限に収まらない場合、生成を開始せず prompt_budget_exceeded を返す', async () => {
    const project = await createTrackedProject();
    // 32k 級より小さい context の fixture。必須節（今回希望・出力形式・直近本文末尾等）は
    // 残す契約のため、これ以上縮められない時点で型付きエラーになる（設計書 3.1 step 7）。
    tokenLimitsOverride = {
      contextWindowTokens: 8_000,
      inputTokenLimit: 8_000,
      outputTokenLimit: 2_048,
      source: 'inferred',
    };
    const generateText = vi.spyOn(OpenAIAdapter.prototype, 'generateText');

    const error = await generationService
      .generateScene(project.projectId, { wish: '続き', mode: 'continue' })
      .catch((err: GenerateError) => err);

    expect(error.code).toBe('prompt_budget_exceeded');
    expect(error.retryable).toBe(false);
    // ストリーミング・非ストリーミングのどちらもモデルへは一度も送っていない。
    expect(generateText).not.toHaveBeenCalled();
  });
});
