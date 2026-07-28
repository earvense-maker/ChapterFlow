import { describe, expect, it } from 'vitest';
import { normalizeActivePresetIds } from '../../src/shared/presetMigration';
import { DEFAULT_ACTIVE_PRESET_IDS } from '../../src/shared/defaults';

// NOTE: 必須カテゴリ（narration / rpResponseStyle）は常に既定で埋まる。個々のテストは
// 「その上に何が乗るか」だけを述べたいので、期待値は既定へのマージで書く。
function withDefaults(overrides: Record<string, unknown>) {
  return { ...DEFAULT_ACTIVE_PRESET_IDS, ...overrides };
}

describe('normalizeActivePresetIds', () => {
  it.each([
    [{ pov: 'first-person' }, { narration: 'first-person' }],
    [{ pov: 'third-person-fixed' }, { narration: 'third-close' }],
    [{ pov: 'third-person-close' }, { narration: 'third-close' }],
    [{ pov: 'per-scene' }, { narration: 'third-close' }],
    [{ intimacy: 'suggestive' }, { narration: 'third-close', intimacy: 'suggestive' }],
    [{ intimacy: 'none' }, { narration: 'third-close' }],
    [{ distance: 'emotional' }, { narration: 'third-close', emotionDisplay: 'expressive' }],
    [{ distance: 'factual' }, { narration: 'third-close', emotionDisplay: 'restrained' }],
    [{ style: 'quiet' }, { narration: 'third-close', emotionDisplay: 'restrained' }],
    [{ style: 'afterglow' }, { narration: 'third-close', chapterEnding: 'lingering' }],
    [{ style: 'tense' }, { narration: 'third-close', aftertaste: ['searing'] }],
    [{ pacing: 'slow' }, { narration: 'third-close', sceneProgression: 'immersive' }],
    [{ pacing: 'fast' }, { narration: 'third-close', sceneProgression: 'brisk' }],
    [{ pacing: 'action-driven' }, { narration: 'third-close', sceneProgression: 'brisk' }],
    [
      { density: 'emotion-descriptive' },
      { narration: 'third-close', emotionDisplay: 'expressive' },
    ],
  ])('maps a legacy selection %#', (raw, expected) => {
    expect(normalizeActivePresetIds(raw)).toEqual(withDefaults(expected));
  });

  it('uses first-wins precedence for competing legacy mappings', () => {
    expect(
      normalizeActivePresetIds({ style: 'quiet', density: 'emotion-descriptive' })
    ).toEqual(withDefaults({ narration: 'third-close', emotionDisplay: 'restrained' }));
  });

  it('validates current IDs, deduplicates aftertaste, and limits it to two', () => {
    expect(
      normalizeActivePresetIds({
        narration: 'first-person',
        aftertaste: ['poignant', 'unknown', 'poignant', 'searing', 'heartwarming'],
        emotionDisplay: 'unknown',
        painLevel: 'bittersweet',
      })
    ).toEqual(
      withDefaults({
        narration: 'first-person',
        aftertaste: ['poignant', 'searing'],
        painLevel: 'bittersweet',
      })
    );
  });

  it('falls back to the required narration and drops unknown legacy categories', () => {
    expect(normalizeActivePresetIds({ genre: 'fantasy', conversation: 'many' })).toEqual(
      withDefaults({ narration: 'third-close' })
    );
    expect(normalizeActivePresetIds({ narration: 'unknown' })).toEqual(
      withDefaults({ narration: 'third-close' })
    );
  });

  it('validates roleplay categories and keeps them alongside novel ones', () => {
    expect(
      normalizeActivePresetIds({
        narration: 'first-person',
        rpResponseStyle: 'prose-mixed',
        rpInitiative: 'lead',
        rpDistance: 'guarded',
        rpEmotionDisplay: 'restrained',
        rpPainLevel: 'unflinching',
        rpIntimacy: 'suggestive',
      })
    ).toEqual({
      narration: 'first-person',
      rpResponseStyle: 'prose-mixed',
      rpInitiative: 'lead',
      rpDistance: 'guarded',
      rpEmotionDisplay: 'restrained',
      rpPainLevel: 'unflinching',
      rpIntimacy: 'suggestive',
    });
  });

  it('keeps roleplay-only current selections without requiring a narration marker', () => {
    expect(
      normalizeActivePresetIds({
        rpResponseStyle: 'dialogue-only',
        rpInitiative: 'lead',
        rpMood: ['warm', 'playful'],
      })
    ).toEqual({
      narration: 'third-close',
      rpResponseStyle: 'dialogue-only',
      rpInitiative: 'lead',
      rpMood: ['warm', 'playful'],
    });
  });

  it('falls back to the required rpResponseStyle and drops unknown roleplay IDs', () => {
    expect(
      normalizeActivePresetIds({
        narration: 'third-close',
        rpResponseStyle: 'unknown',
        rpInitiative: 'unknown',
      })
    ).toEqual(withDefaults({}));
  });

  it('deduplicates rpMood and limits it to two', () => {
    expect(
      normalizeActivePresetIds({
        narration: 'third-close',
        rpMood: ['warm', 'unknown', 'warm', 'tense', 'playful'],
      })
    ).toEqual(withDefaults({ rpMood: ['warm', 'tense'] }));
  });
});
