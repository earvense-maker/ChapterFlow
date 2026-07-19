import { describe, expect, it } from 'vitest';
import { renderPresets } from '../../src/server/prompts/presetParts';

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
});
