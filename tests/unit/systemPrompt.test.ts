import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSystemPrompt,
  resolveSystemPrompt,
} from '../../src/server/prompts/systemPrompt';
import type { ActivePresets } from '../../src/shared/types';

const activePresets: ActivePresets = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  intimacy: 'direct-explicit',
};

describe('resolveSystemPrompt', () => {
  it('keeps generated presets and appends only the custom text', async () => {
    const result = await resolveSystemPrompt(activePresets, '作品固有の指示');

    expect(result.generatedSystemPrompt).toContain(
      '【濡れ場の描写: 露骨な語も辞さず生々しく】'
    );
    expect(result.systemPrompt).toContain(result.generatedSystemPrompt);
    expect(result.systemPrompt).toContain('【作品固有の追加指示】\n作品固有の指示');
    expect(result.systemPrompt.endsWith('作品固有の指示')).toBe(true);
    expect(result.customSystemPrompt).toBe('作品固有の指示');
    expect(result.isCustomized).toBe(true);
  });

  it.each([undefined, null, '', '   '])(
    'does not add an empty custom section for %s',
    async (custom) => {
      const result = await resolveSystemPrompt(activePresets, custom);

      expect(result.systemPrompt).toBe(result.generatedSystemPrompt);
      expect(result.systemPrompt).not.toContain('【作品固有の追加指示】');
      expect(result.isCustomized).toBe(false);
    }
  );

  it('removes an exact legacy full prompt instead of appending it twice', async () => {
    const legacyFullPrompt = await buildGeneratedSystemPrompt(activePresets);
    const result = await resolveSystemPrompt(activePresets, legacyFullPrompt);

    expect(result.systemPrompt).toBe(result.generatedSystemPrompt);
    expect(result.customSystemPrompt).toBe('');
    expect(result.isCustomized).toBe(false);
  });

  it('keeps only changed blocks from a legacy full prompt', async () => {
    const generated = await buildGeneratedSystemPrompt(activePresets);
    const legacyWithCustomGenre = generated.replace(
      '【ジャンル: 現代ドラマ】\n現代日本を舞台にした人間ドラマ。日常の小さな摩擦や感情の機微を丁寧に描く。',
      '【ジャンル: 独自ジャンル】\nこの作品固有のジャンル指示。'
    );
    const result = await resolveSystemPrompt(activePresets, legacyWithCustomGenre);

    expect(result.customSystemPrompt).toBe(
      '【ジャンル: 独自ジャンル】\nこの作品固有のジャンル指示。'
    );
    expect(result.systemPrompt).toContain(
      '【作品固有の追加指示】\n【ジャンル: 独自ジャンル】'
    );
    expect(result.systemPrompt.match(/【選択された設定】/g)).toHaveLength(1);
  });

  it('preserves a changed preamble paragraph from a legacy full prompt', async () => {
    const generated = await buildGeneratedSystemPrompt(activePresets);
    const legacyWithCustomPreamble = generated.replace(
      'あなたは経験豊かな小説家であり、ユーザー専用の連載小説の続きを書く。',
      'あなたは幻想的な比喩を得意とする小説家として書く。'
    );
    const result = await resolveSystemPrompt(activePresets, legacyWithCustomPreamble);

    expect(result.customSystemPrompt).toContain(
      'あなたは幻想的な比喩を得意とする小説家として書く。'
    );
    expect(result.systemPrompt).toContain(
      '【作品固有の追加指示】\nあなたは幻想的な比喩を得意とする小説家として書く。'
    );
  });

  it('preserves a shortened block from a legacy full prompt', async () => {
    const generated = await buildGeneratedSystemPrompt(activePresets);
    const legacyWithShortenedPreamble = generated.replace(
      'あなたは経験豊かな小説家であり、ユーザー専用の連載小説の続きを書く。\n' +
        'ユーザーは執筆者ではなく読者である。短い希望をくみ取り、自然で魅力のある場面として続きを書く。\n' +
        'あなたの出力はチャット回答ではなく、テキストファイルに保存される小説本文そのものである。本文だけを出力し、前置き・後書き・設定の説明は書かない。\n' +
        '物語はユーザーの希望なしに完結させない。重大な設定変更や関係の急進展は、ユーザーの希望や既存設定の範囲内で行う。',
      'あなたは経験豊かな小説家であり、ユーザー専用の連載小説の続きを書く。'
    );
    const result = await resolveSystemPrompt(activePresets, legacyWithShortenedPreamble);

    expect(result.customSystemPrompt).toContain(
      'あなたは経験豊かな小説家であり、ユーザー専用の連載小説の続きを書く。'
    );
    expect(result.isCustomized).toBe(true);
  });

  it('extracts the custom tail if a previously combined prompt is supplied', async () => {
    const generated = await buildGeneratedSystemPrompt(activePresets);
    const combined = `${generated}\n\n---\n\n【作品固有の追加指示】\n追加文`;
    const result = await resolveSystemPrompt(activePresets, combined);

    expect(result.customSystemPrompt).toBe('追加文');
    expect(result.systemPrompt.match(/【作品固有の追加指示】/g)).toHaveLength(1);
  });

  it('keeps a normal addition that mentions the selected-settings heading', async () => {
    const custom = '【選択された設定】より、この追加指示を優先する。';
    const result = await resolveSystemPrompt(activePresets, custom);

    expect(result.customSystemPrompt).toBe(custom);
    expect(result.systemPrompt).toContain(`【作品固有の追加指示】\n${custom}`);
  });

  it('does not truncate a normal addition that mentions the additional-instructions heading', async () => {
    const custom = '本文中で「【作品固有の追加指示】」という見出し語を使っても、その前後を削除しない。';
    const result = await resolveSystemPrompt(activePresets, custom);

    expect(result.customSystemPrompt).toBe(custom);
    expect(result.systemPrompt).toContain(`【作品固有の追加指示】\n${custom}`);
  });
});
