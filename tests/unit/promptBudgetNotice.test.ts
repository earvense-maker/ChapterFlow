import { describe, expect, it } from 'vitest';
import {
  ADJUSTED_BUDGET_ACTIONS,
  budgetSectionLabel,
  collectAdjustedBudgetEntries,
  formatBudgetNotice,
  hasAdjustedBudgetEntries,
  ROLEPLAY_TURN_SECTION_IDS,
} from '../../src/shared/promptBudgetNotice';
import type { PromptBudgetReport } from '../../src/shared/types';

function report(entries: PromptBudgetReport['entries']): PromptBudgetReport {
  return { maxChars: 80_000, assembledChars: 40_000, entries };
}

const knownSectionIds = [
  'system.baseInstruction',
  'system.presets',
  'system.customInstructions',
  'system.preset:narration:third-close',
  'user.coreConcept',
  'user.worldSettings',
  'user.characters',
  'user.relationships',
  'user.knowledge',
  'user.currentState',
  'user.characterKnowledgeState',
  'user.importantPast',
  'user.preferenceNotes',
  'user.contextSummary',
  'user.recentContext',
  'user.rewriteTarget',
  'user.frequentPhrases',
  'user.styleLens',
  'user.styleSample',
  'user.sceneDirection',
  'user.outputConditions',
  'user.wish',
  'user.knowledgeChunks',
  'user.worldChunks',
  'roleplay.fixedRules',
  'roleplay.character',
  'roleplay.userPersona',
  'roleplay.dialogueExamples',
  'roleplay.stylePreset',
  'roleplay.projectSystemPrompt',
  'roleplay.customSystemPrompt',
  'roleplay.worldDigest',
  'roleplay.otherCharacters',
  'roleplay.variablePrompt',
  'roleplay.recentMessages',
] as const;

describe('promptBudgetNotice（AC13 の通知・ラベル変換）', () => {
  it('does not leak raw sectionIds into user-facing labels', () => {
    for (const sectionId of knownSectionIds) {
      const label = budgetSectionLabel(sectionId);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain(sectionId);
      expect(label).not.toContain('.');
    }
    // 未知の sectionId は一般的なラベルへ落ち、生の識別子は出ない。
    expect(budgetSectionLabel('user.futureSection')).toBe('プロンプトの一部');
  });

  it('returns null when every entry is full (通常生成では通知しない)', () => {
    const full = report([
      { sectionId: 'user.knowledge', originalChars: 100, includedChars: 100, action: 'full' },
      { sectionId: 'roleplay.fixedRules', originalChars: 200, includedChars: 200, action: 'full' },
    ]);
    expect(hasAdjustedBudgetEntries(full)).toBe(false);
    expect(formatBudgetNotice(full)).toBeNull();
    expect(collectAdjustedBudgetEntries(full)).toEqual([]);
  });

  it('formats concise notices for truncated / omitted / selected / summarized without raw sectionIds', () => {
    const adjusted = report([
      { sectionId: 'user.recentContext', originalChars: 12_000, includedChars: 8_000, action: 'truncated' },
      { sectionId: 'user.knowledgeChunks', originalChars: 18, includedChars: 9, action: 'selected' },
      { sectionId: 'user.worldChunks', originalChars: 6, includedChars: 2, action: 'selected' },
      { sectionId: 'roleplay.otherCharacters', originalChars: 500, includedChars: 0, action: 'omitted' },
      { sectionId: 'user.contextSummary', originalChars: 9_000, includedChars: 3_000, action: 'summarized' },
    ]);
    expect(hasAdjustedBudgetEntries(adjusted)).toBe(true);

    const text = formatBudgetNotice(adjusted);
    expect(text).not.toBeNull();
    // 日本語ラベルが出て、生の sectionId は本文に出ない。
    expect(text).toContain('直近の本文');
    expect(text).toContain('参考資料・世界設定');
    expect(text).toContain('他の登場人物');
    expect(text).toContain('要約');
    for (const sectionId of knownSectionIds) {
      expect(text).not.toContain(sectionId);
    }
  });

  it('deduplicates the same label across multiple entries (選択プリセット2件で1回)', () => {
    const adjusted = report([
      { sectionId: 'system.preset:narration:long', originalChars: 3_000, includedChars: 1_000, action: 'truncated' },
      { sectionId: 'system.preset:aftertaste:long', originalChars: 3_000, includedChars: 1_000, action: 'truncated' },
    ]);
    const text = formatBudgetNotice(adjusted);
    expect(text).toBe('選択プリセットの一部を省略しました');
  });

  it('keeps the report DTO free of any raw text fields (AC13: 原文なし)', () => {
    // 実データに近い形で、本文らしい文字列を決して持たないことの契約。
    const adjusted = report([
      { sectionId: 'user.recentContext', originalChars: 12_000, includedChars: 8_000, action: 'truncated' },
      { sectionId: 'roleplay.character', originalChars: 4_000, includedChars: 0, action: 'omitted' },
    ]);
    const serialized = JSON.stringify({ report: adjusted });
    expect(Object.keys(adjusted.entries[0]).sort()).toEqual([
      'action',
      'includedChars',
      'originalChars',
      'sectionId',
    ]);
    expect(Object.keys(adjusted).sort()).toEqual(['assembledChars', 'entries', 'maxChars']);
    // 本文・人物設定・プロンプト原文を運べるフィールドが存在しない。
    expect(serialized).not.toMatch(/"text"|"content"|"body"|"prompt"|"原文"/);
  });

  it('treats a missing report (旧データ) as no adjustment', () => {
    expect(hasAdjustedBudgetEntries(undefined)).toBe(false);
    expect(hasAdjustedBudgetEntries(null)).toBe(false);
    expect(formatBudgetNotice(undefined)).toBeNull();
    expect(formatBudgetNotice(null)).toBeNull();
    expect(collectAdjustedBudgetEntries(undefined)).toEqual([]);
    expect(ADJUSTED_BUDGET_ACTIONS.has('full')).toBe(false);
  });

  it('filters roleplay turn reports to turn-specific sections only (system調整はセッション作成時に一度だけ)', () => {
    // ターンの結合 report には system 側の縮小も含まれる（buildTurnPrompt の構成）。
    const turnReport = report([
      { sectionId: 'roleplay.character', originalChars: 6_000, includedChars: 4_000, action: 'truncated' },
      { sectionId: 'roleplay.variablePrompt', originalChars: 24_000, includedChars: 20_000, action: 'truncated' },
      { sectionId: 'roleplay.recentMessages', originalChars: 18, includedChars: 12, action: 'truncated' },
    ]);

    const all = collectAdjustedBudgetEntries(turnReport);
    expect(all.map((entry) => entry.sectionId)).toEqual([
      'roleplay.character',
      'roleplay.variablePrompt',
      'roleplay.recentMessages',
    ]);

    const turnOnly = collectAdjustedBudgetEntries(turnReport, ROLEPLAY_TURN_SECTION_IDS);
    expect(turnOnly.map((entry) => entry.sectionId)).toEqual([
      'roleplay.variablePrompt',
      'roleplay.recentMessages',
    ]);

    const notice = formatBudgetNotice(turnReport, { sectionIds: ROLEPLAY_TURN_SECTION_IDS });
    expect(notice).not.toBeNull();
    // system 側（対象キャラクター）は通知に出ない。
    expect(notice).not.toContain('対象キャラクター');
    expect(notice).toContain('会話プロンプト');
    expect(notice).toContain('直近の会話');
    expect(notice).not.toContain('roleplay.character');
  });

  it('returns null when only system sections were adjusted in a roleplay turn report', () => {
    const turnReport = report([
      { sectionId: 'roleplay.character', originalChars: 6_000, includedChars: 4_000, action: 'truncated' },
      { sectionId: 'roleplay.variablePrompt', originalChars: 5_000, includedChars: 5_000, action: 'full' },
      { sectionId: 'roleplay.recentMessages', originalChars: 12, includedChars: 12, action: 'full' },
    ]);
    expect(formatBudgetNotice(turnReport, { sectionIds: ROLEPLAY_TURN_SECTION_IDS })).toBeNull();
  });
});
