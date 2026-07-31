import { describe, expect, it } from 'vitest';
import { buildIntimateVocalDirection } from '../../src/server/prompts/intimateVocalDirection';

describe('buildIntimateVocalDirection', () => {
  it('activates only when a direct intimacy preset and a sexual scene signal are both present', () => {
    const active = buildIntimateVocalDirection({
      intimacyPresetId: 'direct-soft',
      primaryText: '二人が身体を重ねる場面を続けて',
    });
    expect(active).toContain('【今回の場面だけの発声演出】');

    expect(
      buildIntimateVocalDirection({
        intimacyPresetId: 'suggestive',
        primaryText: '二人が身体を重ねる場面を続けて',
      })
    ).toBe('');
    expect(
      buildIntimateVocalDirection({
        intimacyPresetId: 'direct-explicit',
        primaryText: '朝食を食べながら今日の予定を話す',
      })
    ).toBe('');
  });

  it('keeps the direction active on a short continuation request when recent context is sexual', () => {
    const result = buildIntimateVocalDirection({
      intimacyPresetId: 'direct-explicit',
      primaryText: 'このまま続けて',
      contextTexts: ['二人は寝台で裸身を重ね、快感に吐息を乱していた。'],
    });
    expect(result).toContain('【今回の場面だけの発声演出】');
  });

  it('honors a current negative instruction even when older context was sexual', () => {
    const result = buildIntimateVocalDirection({
      intimacyPresetId: 'direct-explicit',
      primaryText: 'ここから先の濡れ場は描かないで暗転する',
      contextTexts: ['二人は寝台で裸身を重ねていた。'],
    });
    expect(result).toBe('');
  });

  it('turns off when the current instruction moves beyond the sexual scene', () => {
    const result = buildIntimateVocalDirection({
      intimacyPresetId: 'direct-explicit',
      primaryText: '場面を翌朝へ移して、二人が朝食をとるところから',
      contextTexts: ['二人は寝台で裸身を重ねていた。'],
    });
    expect(result).toBe('');
  });

  it('does not carry an older sexual context into a new ordinary request', () => {
    const result = buildIntimateVocalDirection({
      intimacyPresetId: 'direct-explicit',
      primaryText: '今日読んだ本の感想を聞かせて。',
      contextTexts: ['二人は寝台で裸身を重ねていた。'],
    });
    expect(result).toBe('');
  });
});
