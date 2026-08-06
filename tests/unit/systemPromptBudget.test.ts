import { describe, expect, it, vi } from 'vitest';
import { resolveSystemPrompt } from '../../src/server/prompts/systemPrompt';
import { immutableNovelContract } from '../../src/server/prompts/baseInstruction';
import {
  NOVEL_BASE_PROMPT_MAX_CHARS,
  NOVEL_CUSTOM_PROMPT_MAX_CHARS,
  NOVEL_PRESET_MAX_CHARS,
  NOVEL_SYSTEM_PROMPT_MAX_CHARS,
  PROMPT_OMISSION_MARKER,
} from '../../src/server/prompts/promptBudget';
import { NOVEL_PRESET_CATEGORY_ORDER } from '../../src/shared/presetMigration';
import type { ActivePresets, PromptBudgetEntry } from '../../src/shared/types';

// NOTE: 設計書 4.1 の「プリセット集約 4,000 字・1件 256 字の最低予約」を固定する。
// 現行組み込みプリセットは全カテゴリでも約 653 字で切り詰めが起きないため、外部編集や
// 将来の長文化を想定した長文プリセットを catalog へ注入して配分を検証する。
// renderPresetBlocks / renderPresets だけを fixture catalog 参照のフェイクへ差し替え、
// systemPrompt.ts 側の実物の配分ロジック（assembleNovelSystemPrompt）へ長文ブロックを渡す。
const LONG_PRESET_TEXT = 'あ'.repeat(3_000);
const LONG_PRESET_TEXT_2 = 'い'.repeat(3_000);

const LONG_PRESET_CATEGORIES = {
  narration: {
    label: '語り',
    items: { 'long-preset': { id: 'long-preset', label: '長文プリセット', text: LONG_PRESET_TEXT } },
  },
  aftertaste: {
    label: '余韻',
    items: {
      'long-preset-2': { id: 'long-preset-2', label: '長文プリセット2', text: LONG_PRESET_TEXT_2 },
    },
  },
};

const EMPTY_CATEGORIES = {
  narration: { label: '語り', items: {} },
  aftertaste: { label: '余韻', items: {} },
};

let longPresetsEnabled = true;
vi.mock('../../src/server/prompts/presetParts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/prompts/presetParts')>();
  const renderBlocks = async (
    activePresets: ActivePresets,
    categoryOrder: readonly (keyof ActivePresets)[] = NOVEL_PRESET_CATEGORY_ORDER
  ) => {
    const categories = longPresetsEnabled ? LONG_PRESET_CATEGORIES : EMPTY_CATEGORIES;
    const blocks: Array<{
      categoryKey: string;
      presetId: string;
      label: string;
      block: string;
    }> = [];
    for (const categoryKey of categoryOrder) {
      const category = categories[categoryKey];
      if (!category) continue;
      const selected = activePresets[categoryKey];
      const presetIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
      for (const presetId of presetIds) {
        const item = category.items[presetId];
        if (!item?.text.trim()) continue;
        const label = `【${category.label}: ${item.label}】`;
        blocks.push({ categoryKey: String(categoryKey), presetId, label, block: `${label}\n${item.text}` });
      }
    }
    return blocks;
  };
  return {
    ...original,
    renderPresetBlocks: renderBlocks,
    renderPresets: async (
      activePresets: ActivePresets,
      categoryOrder: readonly (keyof ActivePresets)[] = NOVEL_PRESET_CATEGORY_ORDER,
      heading = '【選択された設定】'
    ) => {
      const blocks = await renderBlocks(activePresets, categoryOrder);
      if (blocks.length === 0) return '';
      return `${heading}\n${blocks.map((entry) => entry.block).join('\n\n')}`;
    },
  };
});

const longPresetSelection: ActivePresets = {
  narration: 'long-preset',
  aftertaste: ['long-preset-2'],
};

function entryOf(entries: PromptBudgetEntry[], sectionId: string): PromptBudgetEntry {
  const entry = entries.find((item) => item.sectionId === sectionId);
  if (!entry) throw new Error(`budget entry not found: ${sectionId}`);
  return entry;
}

describe('resolveSystemPrompt 予算配分（設計書 4.1）', () => {
  it('部分採用しても各選択プリセットのラベルと最低予約が残り、system 24,000字を超えず即エラーにもならない', async () => {
    // 集約 6,000 字のプリセットを2件選択。system 全体は 24,000 字へ収める。
    const result = await resolveSystemPrompt(longPresetSelection, '', '');

    expect(result.overflowByChars).toBe(0);
    expect(result.systemChars).toBeLessThanOrEqual(NOVEL_SYSTEM_PROMPT_MAX_CHARS);
    // 各選択プリセットの「存在」は必ず残す（設計書 4.1 ステップ2）。
    expect(result.systemPrompt).toContain('【語り: 長文プリセット】');
    expect(result.systemPrompt).toContain('【余韻: 長文プリセット2】');
    expect(result.systemPrompt.startsWith(immutableNovelContract())).toBe(true);
    // 集約 4,000 字を超えるので段落境界で部分採用し、省略マーカーを付ける。
    expect(result.systemPrompt).toContain(PROMPT_OMISSION_MARKER);

    const presetEntries = result.budgetEntries.filter((entry) =>
      entry.sectionId.startsWith('system.preset:')
    );
    expect(presetEntries).toHaveLength(2);
    // 各プリセットへ最低予約を配った後、選択順に拡張する。枠が尽きた側だけが
    // 部分採用（truncated）になり、最後まで全文が入る側は full のまま残る。
    for (const entry of presetEntries) {
      expect(['full', 'truncated']).toContain(entry.action);
      expect(entry.originalChars).toBeGreaterThanOrEqual(entry.includedChars);
    }
    expect(presetEntries.some((entry) => entry.action === 'truncated')).toBe(true);
    // 集約上限（NOVEL_PRESET_MAX_CHARS）を超えて採用されない。
    const presetTotal = presetEntries.reduce((sum, entry) => sum + entry.includedChars, 0);
    expect(presetTotal).toBeLessThanOrEqual(NOVEL_PRESET_MAX_CHARS);
  });

  it('100,000字の基本・追加プロンプトを実行時だけ部分採用し、保存原文へは触れない（設計書 4.1 / 7.1）', async () => {
    longPresetsEnabled = false;
    const base = 'あ'.repeat(100_000);
    const custom = 'い'.repeat(100_000);

    const result = await resolveSystemPrompt({ narration: 'missing' }, custom, base);

    expect(result.overflowByChars).toBe(0);
    expect(result.systemChars).toBeLessThanOrEqual(NOVEL_SYSTEM_PROMPT_MAX_CHARS);
    expect(result.systemPrompt.startsWith(immutableNovelContract())).toBe(true);
    expect(result.systemPrompt).toContain(PROMPT_OMISSION_MARKER);

    // 実行時上限で部分採用（hard max は同時最大採用の保証ではない）。
    const baseEntry = entryOf(result.budgetEntries, 'system.baseInstruction');
    expect(baseEntry.includedChars).toBeLessThanOrEqual(NOVEL_BASE_PROMPT_MAX_CHARS);
    expect(baseEntry.action).toBe('truncated');
    expect(baseEntry.originalChars).toBe(100_000);

    const customEntry = entryOf(result.budgetEntries, 'system.customInstructions');
    expect(customEntry.includedChars).toBeLessThanOrEqual(NOVEL_CUSTOM_PROMPT_MAX_CHARS);
    expect(customEntry.action).toBe('truncated');
    expect(customEntry.originalChars).toBe(100_000);

    // 関数は純粋な組み立てのみ。保存済み本文を書き換える経路を持たない。
    expect(base).toHaveLength(100_000);
    expect(custom).toHaveLength(100_000);
  });

  it('基本・追加・プリセットの同時最大入力でも即エラーにせず、不変契約は必ず残る', async () => {
    longPresetsEnabled = true;
    const result = await resolveSystemPrompt(
      longPresetSelection,
      'カスタム'.repeat(1_000),
      '基本'.repeat(1_000)
    );

    expect(result.overflowByChars).toBe(0);
    expect(result.systemChars).toBeLessThanOrEqual(NOVEL_SYSTEM_PROMPT_MAX_CHARS);
    expect(result.systemPrompt.startsWith(immutableNovelContract())).toBe(true);
    expect(result.systemPrompt).toContain('【語り: 長文プリセット】');
    expect(result.systemPrompt).toContain('【余韻: 長文プリセット2】');
    expect(result.systemPrompt).toContain(PROMPT_OMISSION_MARKER);
  });
});
