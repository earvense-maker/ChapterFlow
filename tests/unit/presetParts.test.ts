import { describe, expect, it } from 'vitest';
import { renderPresets } from '../../src/server/prompts/presetParts';
import { ROLEPLAY_RENDERED_PRESET_CATEGORY_ORDER } from '../../src/shared/presetMigration';
import { ROLEPLAY_STYLE_HEADING } from '../../src/server/services/roleplayPromptBuilder';

describe('renderPresets', () => {
  it('renders categories in the fixed definition order', async () => {
    const rendered = await renderPresets({
      narration: 'third-close',
      intimacy: 'fade-to-black',
      painLevel: 'safe',
      chapterEnding: 'hook',
      sceneProgression: 'brisk',
      emotionDisplay: 'restrained',
      aftertaste: ['poignant'],
    });

    const headings = [...rendered.matchAll(/^【([^】]+)】$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      '選択された設定',
      '語り: 三人称・視点人物に寄り添う',
      '読後感: 切ない',
      '感情の見せ方: 抑えて示す',
      '場面の進み方: 語りも交えて速く',
      '章の幕引き: 引きで終わる',
      '痛みの上限: 安心して読める',
      '濡れ場の描写: 描かない（暗転）',
    ]);
  });

  it('renders each aftertaste item as an independent block', async () => {
    const rendered = await renderPresets({
      narration: 'third-close',
      aftertaste: ['poignant', 'searing'],
    });

    expect(rendered).toContain('【読後感: 切ない】\n届きそうで届かないもの');
    expect(rendered).toContain('【読後感: ひりつく】\n各場面に小さな不和');
    expect(rendered.match(/【読後感:/g)).toHaveLength(2);
  });

  it('skips unselected and unknown categories', async () => {
    const rendered = await renderPresets({ narration: 'third-close' });
    expect(rendered.match(/^【[^】]+】$/gm)).toHaveLength(2);
    expect(rendered).not.toContain('読後感');
    expect(await renderPresets({ narration: 'unknown' })).toBe('');
  });

  it('renders only roleplay categories under the roleplay heading', async () => {
    const rendered = await renderPresets(
      {
        narration: 'first-person',
        chapterEnding: 'hook',
        rpResponseStyle: 'prose-mixed',
        rpInitiative: 'lead',
        rpDistance: 'guarded',
        rpMood: ['warm', 'melancholic'],
        rpEmotionDisplay: 'restrained',
        rpPainLevel: 'safe',
        rpIntimacy: 'suggestive',
      },
      ROLEPLAY_RENDERED_PRESET_CATEGORY_ORDER,
      ROLEPLAY_STYLE_HEADING
    );

    const headings = [...rendered.matchAll(/^【([^】]+)】$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      '会話の作風',
      '会話の主導権: キャラから動かす',
      '距離の詰め方: 慎重に縮める',
      '会話の空気: あたたかい',
      '会話の空気: 陰のある',
      '感情の出し方: 抑えて示す',
      '踏み込みの上限: 安心して話せる',
      '性的な場面: 気配だけ匂わせる',
    ]);
    // 応答の形は固定規則側で埋め込むため、ここには出さない
    expect(rendered).not.toContain('応答の形:');
  });

  it('omits the roleplay section entirely when nothing beyond the response style is selected', async () => {
    const rendered = await renderPresets(
      { narration: 'third-close', rpResponseStyle: 'bracketed-action' },
      ROLEPLAY_RENDERED_PRESET_CATEGORY_ORDER,
      ROLEPLAY_STYLE_HEADING
    );
    expect(rendered).toBe('');
  });
});
