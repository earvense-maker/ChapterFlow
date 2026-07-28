import { describe, expect, it } from 'vitest';
import {
  allocateSectionBudget,
  checkPromptTokenBudget,
  estimatePromptTokensForBudget,
  NOVEL_SYSTEM_PROMPT_MAX_CHARS,
  NOVEL_TOTAL_PROMPT_MAX_CHARS,
  NOVEL_USER_PROMPT_MAX_CHARS,
  PROMPT_OMISSION_MARKER,
  promptSafetyMarginTokens,
  sliceHeadByGraphemes,
  sliceTailByGraphemes,
  truncateHeadToBudget,
  truncateTailToBudget,
} from '../../src/server/prompts/promptBudget';
import { estimateTokensFromText } from '../../src/server/utils/contextEstimate';

describe('文字数予算の一次制御', () => {
  it('system と user の上限を足すと total 上限になる', () => {
    expect(NOVEL_SYSTEM_PROMPT_MAX_CHARS + NOVEL_USER_PROMPT_MAX_CHARS).toBe(
      NOVEL_TOTAL_PROMPT_MAX_CHARS
    );
  });

  it('省略マーカーを含めて上限内に収める', () => {
    const result = truncateHeadToBudget('あ'.repeat(1_000), 100);
    expect(result.action).toBe('truncated');
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text.endsWith(PROMPT_OMISSION_MARKER)).toBe(true);
    expect(result.includedChars).toBe(result.text.length);
  });

  it('マーカーすら入らない枠は断片を残さず省略する', () => {
    const result = truncateHeadToBudget('あ'.repeat(100), 5);
    expect(result.action).toBe('omitted');
    expect(result.text).toBe('');
  });

  it('末尾優先の切り詰めは新しい側を残す', () => {
    const body = Array.from({ length: 200 }, (_, i) => `行${i}`).join('\n');
    const result = truncateTailToBudget(body, 200);
    expect(result.action).toBe('truncated');
    expect(result.text.length).toBeLessThanOrEqual(200);
    expect(result.text).toContain('行199');
    expect(result.text).not.toContain('行0\n');
    expect(result.text.startsWith(PROMPT_OMISSION_MARKER)).toBe(true);
  });
});

describe('Unicode 境界', () => {
  // NOTE: 予算計算は UTF-16 code unit で数えるが、切る位置は grapheme 境界へ丸める。
  // ここが崩れると壊れた文字（不正なサロゲート）をモデルへ渡すことになる。
  const cases: Array<[string, string]> = [
    ['サロゲートペア', '𩸽'],
    ['ZWJ絵文字', '👨‍👩‍👧‍👦'],
    ['異体字セレクタ', '葛󠄀'],
    ['結合文字', 'が'],
    ['肌色修飾子', '👍🏽'],
  ];

  it.each(cases)('%s を境界へ置いても分断しない', (_label, grapheme) => {
    const body = grapheme.repeat(50);
    for (let budget = 1; budget <= 40; budget += 1) {
      const head = sliceHeadByGraphemes(body, budget);
      const tail = sliceTailByGraphemes(body, budget);
      // 不正なサロゲートを含まない（含むと � 経由で往復が壊れる）
      expect(head).toBe(Buffer.from(head, 'utf8').toString('utf8'));
      expect(tail).toBe(Buffer.from(tail, 'utf8').toString('utf8'));
      expect(head.length).toBeLessThanOrEqual(budget);
      expect(tail.length).toBeLessThanOrEqual(budget);
      // grapheme の整数個ぶんだけ残る
      expect(head.length % grapheme.length).toBe(0);
      expect(tail.length % grapheme.length).toBe(0);
    }
  });

  it('BOM と制御文字を含む本文でも上限を超えない', () => {
    const body = `﻿${'あ'.repeat(200)}`;
    const result = truncateHeadToBudget(body, 120);
    expect(result.text.length).toBeLessThanOrEqual(120);
  });
});

describe('セクション配分', () => {
  const section = (
    sectionId: string,
    body: string,
    hardMax: number,
    minReserve: number,
    required = false
  ) => ({ sectionId, body, hardMax, minReserve, ...(required ? { required: true } : {}) });

  it('高優先セクションが長くても、下位の最低予約を奪わない', () => {
    const result = allocateSectionBudget({
      totalMax: 1_000,
      sections: [
        section('high', 'あ'.repeat(5_000), 5_000, 200, true),
        section('mid', 'い'.repeat(500), 500, 200),
        section('low', 'う'.repeat(500), 500, 200),
      ],
      reserveOrder: ['high', 'mid', 'low'],
    });

    expect(result.overflowByChars).toBe(0);
    // 3セクションとも生き残る（旧 serial break は mid/low が丸ごと消えていた）
    expect(result.sections.map((s) => s.sectionId)).toEqual(['high', 'mid', 'low']);
    expect(result.assembledChars).toBeLessThanOrEqual(1_000);
    for (const entry of result.entries) {
      expect(entry.includedChars).toBeGreaterThanOrEqual(1);
    }
  });

  it('枠が足りないときは優先順位の低い側から予約を外す', () => {
    const result = allocateSectionBudget({
      totalMax: 700,
      sections: [
        section('high', 'あ'.repeat(600), 600, 600, true),
        section('mid', 'い'.repeat(300), 300, 300),
        section('low', 'う'.repeat(300), 300, 300),
      ],
      reserveOrder: ['high', 'mid', 'low'],
    });

    const omitted = result.entries.filter((e) => e.action === 'omitted').map((e) => e.sectionId);
    expect(omitted).toContain('low');
    expect(omitted).not.toContain('high');
  });

  it('必須節の最低予約だけで超えたら overflow を返す', () => {
    const result = allocateSectionBudget({
      totalMax: 100,
      sections: [section('high', 'あ'.repeat(500), 500, 500, true)],
    });

    expect(result.overflowByChars).toBe(400);
    expect(result.sections).toHaveLength(0);
  });

  // NOTE: render を通すセクションは、整形後の長さで予算を守る必要がある。
  // 引用描画は行ごとに「> 」を足すので、固定 overhead を引くだけでは足りない。
  it('引用描画で膨らんでも整形後の上限を守り、閉じタグを落とさない', () => {
    const body = Array.from({ length: 300 }, (_, i) => `行${i}`).join('\n');
    const result = allocateSectionBudget({
      totalMax: 500,
      sections: [
        {
          sectionId: 'quoted',
          body,
          render: (text) =>
            ['【見出し】', '<data>', text.split('\n').map((l) => `> ${l}`).join('\n'), '</data>'].join('\n'),
          hardMax: 500,
          minReserve: 100,
        },
      ],
    });

    const text = result.sections[0].text;
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('</data>')).toBe(true);
    expect((text.match(/^<data>$/gm) ?? []).length).toBe(1);
    expect((text.match(/^<\/data>$/gm) ?? []).length).toBe(1);
  });

  it('同じ入力からは常に同じ配分になる（共有可変状態を持たない）', async () => {
    const build = () =>
      allocateSectionBudget({
        totalMax: 900,
        sections: [
          section('a', 'あ'.repeat(800), 800, 200, true),
          section('b', 'い'.repeat(800), 800, 200),
          section('c', 'う'.repeat(800), 800, 200),
        ],
        reserveOrder: ['a', 'b', 'c'],
      });

    const results = await Promise.all(Array.from({ length: 20 }, async () => build()));
    const first = JSON.stringify(results[0].entries);
    for (const result of results) {
      expect(JSON.stringify(result.entries)).toBe(first);
    }
  });
});

describe('二次トークン確認', () => {
  it('予算判定用の推定は表示用より必ず保守的', () => {
    const japanese = 'あ'.repeat(10_000);
    expect(estimatePromptTokensForBudget(japanese)).toBeGreaterThan(
      estimateTokensFromText(japanese)
    );
  });

  it('安全余白は context の10%か4,096の大きい方', () => {
    expect(promptSafetyMarginTokens(128_000)).toBe(12_800);
    expect(promptSafetyMarginTokens(32_000)).toBe(4_096);
  });

  // NOTE: 設計書 10.1 の中心的な回帰。既存の 0.8 token/char 推定では通ってしまう入力が、
  // 保守的推定では通らないこと（＝80,000字を安全量として扱っていないこと）を固定する。
  it('日本語80,000字は128kモデルでも保守的推定では収まらない', () => {
    const systemInstructions = 'あ'.repeat(24_000);
    const userPrompt = 'い'.repeat(56_000);
    const result = checkPromptTokenBudget({
      systemInstructions,
      userPrompt,
      contextWindowTokens: 128_000,
      inputTokenLimit: 128_000,
      estimatedMaxOutputTokens: 32_048,
      providerTokens: null,
    });

    expect(result.tokenCheck.source).toBe('conservative');
    expect(result.ok).toBe(false);
    expect(result.overByTokens).toBeGreaterThan(0);
    // 表示用の推定だけなら通ってしまう
    expect(estimateTokensFromText(`${systemInstructions}\n\n${userPrompt}`)).toBeLessThan(128_000);
  });

  it('provider 実測があればそちらを使い、source で判別できる', () => {
    const result = checkPromptTokenBudget({
      systemInstructions: 'あ'.repeat(10_000),
      userPrompt: 'い'.repeat(10_000),
      contextWindowTokens: 128_000,
      inputTokenLimit: 128_000,
      estimatedMaxOutputTokens: 8_000,
      providerTokens: 12_345,
    });

    expect(result.tokenCheck.source).toBe('provider');
    expect(result.tokenCheck.promptTokens).toBe(12_345);
    expect(result.ok).toBe(true);
  });

  it('inputTokenLimit が無ければ context 側だけで判定する', () => {
    const result = checkPromptTokenBudget({
      systemInstructions: 'a',
      userPrompt: 'b',
      contextWindowTokens: 8_000,
      estimatedMaxOutputTokens: 4_000,
      providerTokens: 100,
    });

    expect(result.tokenCheck.inputTokenLimit).toBeUndefined();
    expect(result.withinInputLimit).toBe(true);
    // 100 + 4000 + 4096 > 8000 なので context 側で落ちる
    expect(result.withinContextWindow).toBe(false);
    expect(result.ok).toBe(false);
  });
});
