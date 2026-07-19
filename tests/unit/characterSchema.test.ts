import { describe, expect, it } from 'vitest';
import {
  normalizeCharacterForStorage,
  normalizeCharacterTraits,
} from '../../src/shared/characterSchema.js';
import type { LegacyCharacterInput } from '../../src/shared/characterSchema.js';

function character(overrides: Partial<LegacyCharacterInput> = {}): LegacyCharacterInput {
  return {
    characterId: 'char-a',
    name: 'アリス',
    role: 'protagonist',
    description: '主人公',
    ...overrides,
  };
}

describe('character schema normalization', () => {
  it('migrates legacy want/fear and removes the old keys', () => {
    const normalized = normalizeCharacterForStorage(
      character({ want: '承認されたい', fear: '見捨てられること' })
    );

    expect(normalized.traits).toEqual([
      { label: '望み', text: '承認されたい' },
      { label: '恐れ', text: '見捨てられること' },
    ]);
    expect(normalized).not.toHaveProperty('want');
    expect(normalized).not.toHaveProperty('fear');
  });

  it('prefers explicit traits and only fills remaining slots from legacy values', () => {
    const normalized = normalizeCharacterForStorage(
      character({
        traits: [
          { label: '望み', text: '自分で選びたい' },
          { label: '癖', text: '緊張すると笑う' },
          { label: 'こだわり', text: '靴を磨く' },
          { label: '弱点', text: '朝に弱い' },
        ],
        want: '承認されたい',
        fear: '見捨てられること',
      })
    );

    expect(normalized.traits).toHaveLength(4);
    expect(normalized.traits?.[0]).toEqual({ label: '望み', text: '自分で選びたい' });
    expect(normalized.traits).not.toContainEqual({ label: '恐れ', text: '見捨てられること' });
  });

  it('normalizes whitespace, limits lengths, removes invalid rows and deduplicates labels', () => {
    const normalized = normalizeCharacterTraits([
      { label: '  意地\nの\t張り方  ', text: ` ${'あ'.repeat(220)} ` },
      { label: '意地 の 張り方', text: '後勝ちしない' },
      { label: '', text: '空ラベル' },
      { label: '空本文', text: '  ' },
      'broken',
    ]);

    expect(normalized).toEqual([
      {
        label: '意地 の 張り方',
        text: 'あ'.repeat(200),
      },
    ]);
  });

  it('limits label length and the number of registered traits', () => {
    const normalized = normalizeCharacterTraits(
      Array.from({ length: 5 }, (_, index) => ({
        label: `${index}123456789012345`,
        text: `軸${index}`,
      }))
    );

    expect(normalized).toHaveLength(4);
    expect(normalized[0].label).toBe('012345678901');
  });

  it('is idempotent', () => {
    const once = normalizeCharacterForStorage(
      character({
        traits: [{ label: '  こだわり  ', text: '  紅茶は熱いうちに飲む  ' }],
        want: '自由',
      })
    );
    const twice = normalizeCharacterForStorage(once);
    expect(twice).toEqual(once);
  });

  it('omits an empty traits property', () => {
    expect(normalizeCharacterForStorage(character({ traits: [] }))).not.toHaveProperty('traits');
  });
});
