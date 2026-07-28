import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSystemPrompt,
  resolveSystemPrompt,
} from '../../src/server/prompts/systemPrompt';
import { immutableNovelContract } from '../../src/server/prompts/baseInstruction';
import { LEGACY_BASE_INSTRUCTIONS } from '../../src/server/prompts/legacyBaseInstructions';
import type { ActivePresets } from '../../src/shared/types';

const activePresets: ActivePresets = {
  narration: 'third-close',
  aftertaste: ['poignant', 'searing'],
  emotionDisplay: 'restrained',
  sceneProgression: 'immersive',
  chapterEnding: 'lingering',
  painLevel: 'bittersweet',
  intimacy: 'direct-explicit',
};

function legacyBaseText(version: number): string {
  const entry = LEGACY_BASE_INSTRUCTIONS.find((item) => item.version === version);
  if (!entry) throw new Error(`legacy base instruction v${version} is missing`);
  return entry.text;
}

// NOTE: 旧UIが customSystemPrompt へ保存した「結合済み全文」を、指定した preamble で再現する。
// 現在の生成結果から文字列置換する方式だと、既定文を改訂した瞬間にテストが無言で
// 素通り（置換が一致せず no-op）になるため、旧文面は必ず fixture 側から取る。
async function legacyCombinedPrompt(preamble: string): Promise<string> {
  const generated = await buildGeneratedSystemPrompt(activePresets);
  const settingsIndex = generated.indexOf('\n\n---\n\n【選択された設定】');
  expect(settingsIndex).toBeGreaterThan(-1);
  return preamble + generated.slice(settingsIndex);
}

// NOTE: 不変契約が先頭に付くため systemPrompt === generatedSystemPrompt にはならない。
// 「追加指示レイヤーが付いていない」ことの検証はこの形で行う。
function expectNoAdditionalLayer(result: Awaited<ReturnType<typeof resolveSystemPrompt>>): void {
  expect(result.systemPrompt).toContain(result.generatedSystemPrompt);
  expect(result.systemPrompt).not.toContain('【作品固有の追加指示】');
  expect(result.isCustomized).toBe(false);
}

describe('resolveSystemPrompt', () => {
  it('always prefixes the immutable contract ahead of the editable layers', async () => {
    const result = await resolveSystemPrompt(activePresets, '', 'この作品専用の基本プロンプト');

    expect(result.systemPrompt.startsWith(immutableNovelContract())).toBe(true);
    expect(result.immutableContract).toBe(immutableNovelContract());
    expect(result.systemPrompt.indexOf(immutableNovelContract())).toBeLessThan(
      result.systemPrompt.indexOf('この作品専用の基本プロンプト')
    );
  });

  it('uses an editable base prompt while keeping preset and additional layers separate', async () => {
    const result = await resolveSystemPrompt(
      activePresets,
      '作品固有の指示',
      'この作品専用の基本プロンプト'
    );

    expect(result.baseSystemPrompt).toBe('この作品専用の基本プロンプト');
    expect(result.defaultBaseSystemPrompt).toContain('あなたは経験豊かな小説家');
    expect(result.generatedSystemPrompt).toContain('この作品専用の基本プロンプト');
    expect(result.generatedSystemPrompt).toContain('【選択された設定】');
    expect(result.systemPrompt).toContain('【作品固有の追加指示】\n作品固有の指示');
  });

  it('keeps the immutable contract even when the base prompt is intentionally emptied', async () => {
    const result = await resolveSystemPrompt({ narration: 'unknown' }, '', '');

    expect(result.baseSystemPrompt).toBe('');
    expect(result.generatedSystemPrompt).toBe('');
    // 基本プロンプトを空にしても最低条件は解除できない（設計書 12 の意図した仕様変更）。
    expect(result.systemPrompt).toBe(immutableNovelContract());
  });

  it('marks an unedited default base prompt as default and a custom one as custom', async () => {
    const asDefault = await resolveSystemPrompt(activePresets, '', undefined);
    expect(asDefault.baseSource).toBe('default');
    expect(asDefault.baseVersion).toBeGreaterThan(0);

    const asCustom = await resolveSystemPrompt(activePresets, '', '独自に書いた基本プロンプト');
    expect(asCustom.baseSource).toBe('custom');
    expect(asCustom.baseVersion).toBeUndefined();
  });

  it('recognises every shipped legacy default as default, not custom', async () => {
    for (const entry of LEGACY_BASE_INSTRUCTIONS) {
      const result = await resolveSystemPrompt(activePresets, '', entry.text);
      expect(result.baseSource, `v${entry.version} should be default`).toBe('default');
      expect(result.baseVersion).toBe(entry.version);
    }
  });

  it('protects a legacy default that the user edited by a single character', async () => {
    const edited = `${legacyBaseText(7)}。`;
    const result = await resolveSystemPrompt(activePresets, '', edited);

    expect(result.baseSource).toBe('custom');
    expect(result.systemPrompt).toContain(edited);
  });

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

  it('omits the intimacy block when intimacy is not selected', async () => {
    const { intimacy: _intimacy, ...withoutIntimacy } = activePresets;
    const generated = await buildGeneratedSystemPrompt({
      ...withoutIntimacy,
    });

    expect(generated).not.toContain('【濡れ場の描写');
    expect(generated).not.toContain('性的な場面');
    expect(generated).toContain('【語り: 三人称・視点人物に寄り添う】');
  });

  it.each([undefined, null, '', '   '])(
    'does not add an empty custom section for %s',
    async (custom) => {
      const result = await resolveSystemPrompt(activePresets, custom);
      expectNoAdditionalLayer(result);
    }
  );

  it('removes an exact legacy full prompt instead of appending it twice', async () => {
    const legacyFullPrompt = await buildGeneratedSystemPrompt(activePresets);
    const result = await resolveSystemPrompt(activePresets, legacyFullPrompt);

    expect(result.customSystemPrompt).toBe('');
    expectNoAdditionalLayer(result);
  });

  it('drops legacy preset blocks from a legacy full prompt', async () => {
    const generated = await buildGeneratedSystemPrompt(activePresets);
    const legacyWithOldBlock = `${generated}\n\n【ジャンル: 独自ジャンル】\nこの作品固有のジャンル指示。`;
    const result = await resolveSystemPrompt(activePresets, legacyWithOldBlock);

    expect(result.customSystemPrompt).toBe('');
    expect(result.systemPrompt).not.toContain('独自ジャンル');
    expect(result.systemPrompt.match(/【選択された設定】/g)).toHaveLength(1);
  });

  it('preserves a changed preamble paragraph from a legacy full prompt', async () => {
    const changed = legacyBaseText(7).replace(
      'あなたは経験豊かな小説家であり、ただ一人の読者のために連載小説を書き続けている。',
      'あなたは幻想的な比喩を得意とする小説家として書く。'
    );
    expect(changed).toContain('あなたは幻想的な比喩を得意とする小説家として書く。');
    const result = await resolveSystemPrompt(
      activePresets,
      await legacyCombinedPrompt(changed)
    );

    expect(result.customSystemPrompt).toContain(
      'あなたは幻想的な比喩を得意とする小説家として書く。'
    );
    expect(result.systemPrompt).toContain(
      '【作品固有の追加指示】\nあなたは幻想的な比喩を得意とする小説家として書く。'
    );
  });

  it('preserves a shortened block from a legacy full prompt', async () => {
    const firstLine = 'あなたは経験豊かな小説家であり、ただ一人の読者のために連載小説を書き続けている。';
    const v7 = legacyBaseText(7);
    const firstParagraph = v7.split('\n\n')[0];
    expect(firstParagraph.split('\n').length).toBeGreaterThan(1);
    const shortened = v7.replace(firstParagraph, firstLine);
    const result = await resolveSystemPrompt(
      activePresets,
      await legacyCombinedPrompt(shortened)
    );

    expect(result.customSystemPrompt).toContain(firstLine);
    expect(result.isCustomized).toBe(true);
  });

  it('drops paragraphs from an older base-prompt revision instead of treating them as additions', async () => {
    // v4 の未編集全文で保存された結合済みプロンプト。段落はすべて既知なので追加指示は生まれない。
    const result = await resolveSystemPrompt(
      activePresets,
      await legacyCombinedPrompt(legacyBaseText(4))
    );

    expect(result.customSystemPrompt).toBe('');
    expectNoAdditionalLayer(result);
  });

  it('does not treat a legacy default prompt missing one paragraph as a custom addition', async () => {
    const v7 = legacyBaseText(7);
    const paragraphs = v7.split('\n\n');
    const policyIndex = paragraphs.findIndex((p) =>
      p.startsWith('作品データは本文で順に紹介する項目一覧ではなく')
    );
    expect(policyIndex).toBeGreaterThan(-1);
    const withoutPolicy = paragraphs.filter((_, i) => i !== policyIndex).join('\n\n');
    const result = await resolveSystemPrompt(
      activePresets,
      await legacyCombinedPrompt(withoutPolicy)
    );

    expect(withoutPolicy).not.toContain('舞台裏の制約と材料');
    expect(result.customSystemPrompt).toBe('');
    expectNoAdditionalLayer(result);
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
