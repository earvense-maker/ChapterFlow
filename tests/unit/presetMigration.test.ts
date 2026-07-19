import { describe, expect, it } from 'vitest';
import { normalizeActivePresetIds } from '../../src/shared/presetMigration';

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
    expect(normalizeActivePresetIds(raw)).toEqual(expected);
  });

  it('uses first-wins precedence for competing legacy mappings', () => {
    expect(
      normalizeActivePresetIds({ style: 'quiet', density: 'emotion-descriptive' })
    ).toEqual({ narration: 'third-close', emotionDisplay: 'restrained' });
  });

  it('validates current IDs, deduplicates aftertaste, and limits it to two', () => {
    expect(
      normalizeActivePresetIds({
        narration: 'first-person',
        aftertaste: ['poignant', 'unknown', 'poignant', 'searing', 'heartwarming'],
        emotionDisplay: 'unknown',
        painLevel: 'bittersweet',
      })
    ).toEqual({
      narration: 'first-person',
      aftertaste: ['poignant', 'searing'],
      painLevel: 'bittersweet',
    });
  });

  it('falls back to the required narration and drops unknown legacy categories', () => {
    expect(normalizeActivePresetIds({ genre: 'fantasy', conversation: 'many' })).toEqual({
      narration: 'third-close',
    });
    expect(normalizeActivePresetIds({ narration: 'unknown' })).toEqual({
      narration: 'third-close',
    });
  });
});
