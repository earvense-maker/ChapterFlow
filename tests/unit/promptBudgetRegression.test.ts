import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt } from '../../src/server/prompts/promptBuilder';
import {
  allocateSectionBudget,
  estimatePromptTokensForBudget,
  NOVEL_KNOWLEDGE_MAX_CHARS,
  tokensToReducibleChars,
} from '../../src/server/prompts/promptBudget';
import {
  chunkTextForPrompt,
  renderChunkBody,
  selectKnowledgeChunksForPrompt,
} from '../../src/server/services/knowledgePromptSelector';
import * as storage from '../../src/server/services/storageService';
import type { Character, Project, ProjectState } from '../../src/server/types/index';

const projectId = 'proj-budget-regression';

afterEach(async () => {
  await storage.deleteProjectDir(projectId);
});

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: 'Regression',
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    activeModelProvider: 'openai',
    activeModelName: 'gpt-4o-mini',
    outputLength: 3000,
    streamingEnabled: false,
    activePresetIds: { narration: 'third-close' },
    ...overrides,
  };
}

function makeState(): ProjectState {
  return {
    lastOpenedAt: '2026-07-02T00:00:00Z',
    currentEpisodeId: null,
    currentSceneId: null,
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    uiState: { readingPosition: 0, fontSize: 18 },
  };
}

function countLines(text: string, line: string): number {
  return text.split('\n').filter((l) => l === line).length;
}

// NOTE: レビュー指摘 P1-1 の回帰。合成した単体テストではなく、実際の buildPrompt へ
// 長文を渡して <data> と </data> が必ず対になることを検査する。
describe('小説ビルダーのデータブロック境界（実経路）', () => {
  const bigCharacters = (count: number): Character[] =>
    Array.from({ length: count }, (_, i) => ({
      characterId: `char-${i}`,
      name: `人物${i}`,
      role: 'supporting' as const,
      description: `説明${i}。`.repeat(400),
      speechStyle: `口調${i}。`.repeat(200),
      relationshipNotes: `関係${i}。`.repeat(200),
    }));

  it('あらゆる予算で開いたブロックが必ず閉じる', async () => {
    const built = await buildPrompt({
      project: makeProject({ coreConcept: '核。'.repeat(500), styleSample: '見本。'.repeat(300) }),
      state: makeState(),
      wish: '雨宿りの場面',
      memories: [],
      characters: bigCharacters(12),
      worldText: `## 世界の土台\n${'土台。'.repeat(4_000)}\n\n## 開始時点の状況\n${'状況。'.repeat(4_000)}`,
      knowledgeTexts: Array.from({ length: 6 }, (_, i) => ({
        knowledgeId: `kb-${i}`,
        title: `資料${i}`,
        content: `## 見出し${i}\n${'本文。'.repeat(3_000)}`,
      })),
    });

    // 予算をきつくしていくと、どの節が切られても構造は壊れてはいけない。
    for (const budget of [56_000, 40_000, 24_000, 16_000, 12_000, 9_000, 7_000]) {
      const rebuilt = built.rebuildWithUserBudget(budget);
      const open = countLines(rebuilt.userPrompt, '<data>');
      const close = countLines(rebuilt.userPrompt, '</data>');
      expect(open, `budget=${budget} で <data> と </data> の数が違う`).toBe(close);
      expect(rebuilt.userPrompt.length).toBeLessThanOrEqual(budget);
      // 最終行の希望は必ず残る
      expect(rebuilt.userPrompt.trimEnd().endsWith('雨宿りの場面')).toBe(true);
    }
  });

  it('参考資料はブロック単位で落ち、途中で切れたブロックを残さない', async () => {
    const built = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: '続き',
      memories: [],
      characters: [],
      worldText: '',
      knowledgeTexts: Array.from({ length: 4 }, (_, i) => ({
        knowledgeId: `kb-${i}`,
        title: `資料${i}`,
        content: `## 見出し${i}\n${'本文。'.repeat(500)}`,
      })),
    });

    const rebuilt = built.rebuildWithUserBudget(built.requiredUserChars + 4_000);
    expect(countLines(rebuilt.userPrompt, '<data>')).toBe(
      countLines(rebuilt.userPrompt, '</data>')
    );
    // 残った資料ブロックはすべて閉じている
    const knowledgePart = rebuilt.userPrompt.split('【参考資料】')[1] ?? '';
    if (knowledgePart) {
      expect(countLines(knowledgePart, '<data>')).toBe(countLines(knowledgePart, '</data>'));
    }
  });

  it('必須節より下へは縮まず、requiredUserChars が下限として使える', async () => {
    const built = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: '続き',
      memories: [],
      characters: bigCharacters(3),
      worldText: '世界。'.repeat(1_000),
    });

    const floored = built.rebuildWithUserBudget(1);
    expect(built.requiredUserChars).toBeGreaterThan(0);
    // 必須節が入らない予算では組み立てを諦める（空でも構造は壊れない）
    expect(countLines(floored.userPrompt, '<data>')).toBe(
      countLines(floored.userPrompt, '</data>')
    );
  });
});

// NOTE: レビュー指摘 P1-3 の回帰。固定係数だと ASCII で必要削減量を大幅に
// 過小評価し、まだ削れるのに「収まらない」と誤判定していた。
describe('tokensToReducibleChars', () => {
  it('ASCII 本文では日本語より多くの文字を削る必要があると見積もる', () => {
    const ascii = 'hello world. '.repeat(500);
    const japanese = 'こんにちは、今日はいい天気です。'.repeat(200);

    const asciiChars = tokensToReducibleChars(1_000, ascii);
    const japaneseChars = tokensToReducibleChars(1_000, japanese);

    expect(asciiChars).toBeGreaterThan(japaneseChars);
    // 実際に削れば、その分だけトークンが確かに減る（過小評価していない）
    const before = estimatePromptTokensForBudget(ascii);
    const after = estimatePromptTokensForBudget(ascii.slice(0, Math.max(0, ascii.length - asciiChars)));
    expect(before - after).toBeGreaterThanOrEqual(1_000);
  });

  it('sample が無ければ最悪値（3 chars/token）で見積もる', () => {
    expect(tokensToReducibleChars(100)).toBe(300);
    expect(tokensToReducibleChars(0)).toBe(0);
    expect(tokensToReducibleChars(-5)).toBe(0);
  });
});

// NOTE: レビュー指摘 P2-4 の回帰。非隣接チャンクでは overlap が描画時に落ちないので、
// 予算計算でも引いてはいけない。
describe('チャンク選択の予算計上', () => {
  function renderedLength(chunks: ReturnType<typeof chunkTextForPrompt>): number {
    let total = 0;
    let previous: (typeof chunks)[number] | null = null;
    for (const chunk of chunks) {
      total += renderChunkBody(chunk, previous).length;
      previous = chunk;
    }
    return total;
  }

  it('報告する selectedChars が実描画量を下回らない', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      knowledgeId: `kb-${i}`,
      title: `資料${i}`,
      content: Array.from({ length: 12 }, (_, j) => `## 見出し${i}-${j}\nアキ の記述 ${j}。${'詳細。'.repeat(200)}`).join(
        '\n\n'
      ),
    }));

    for (const maxChars of [1_000, 2_960, 5_000, NOVEL_KNOWLEDGE_MAX_CHARS]) {
      const result = selectKnowledgeChunksForPrompt(
        files,
        { terms: ['アキ'], text: 'アキ の場面' },
        { maxChars }
      );
      const actual = renderedLength(result.selected);
      expect(result.selectedChars, `maxChars=${maxChars}`).toBeGreaterThanOrEqual(actual);
      expect(actual, `maxChars=${maxChars} で実描画が上限を超えた`).toBeLessThanOrEqual(maxChars);
    }
  });
});

// NOTE: units を使うセクションの切り詰めが、ブロックの途中で切らないこと。
describe('ユニット単位の切り詰め', () => {
  it('収まらないユニットは丸ごと落とし、閉じタグを残す', () => {
    const unit = (i: number) =>
      ['【見出し' + i + '】', '<data>', '> ' + '本文。'.repeat(50), '</data>'].join('\n');
    const units = [unit(0), unit(1), unit(2), unit(3)];

    const result = allocateSectionBudget({
      totalMax: units[0].length * 2,
      sections: [
        { sectionId: 'multi', body: units.join('\n\n'), units, hardMax: 100_000, minReserve: 0 },
      ],
    });

    const text = result.sections[0].text;
    expect(countLines(text, '<data>')).toBe(countLines(text, '</data>'));
    expect(countLines(text, '<data>')).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(units[0].length * 2);
  });

  it('先頭ユニットすら入らなければセクションごと省略する', () => {
    const units = ['a'.repeat(500), 'b'.repeat(500)];
    const result = allocateSectionBudget({
      totalMax: 50,
      sections: [
        { sectionId: 'multi', body: units.join('\n\n'), units, hardMax: 100_000, minReserve: 0 },
      ],
    });

    expect(result.sections).toHaveLength(0);
    expect(result.entries[0].action).toBe('omitted');
  });
});
