import { describe, it, expect } from 'vitest';
import {
  loadStyleSamples,
  validateStyleSamplesFile,
} from '../../src/server/prompts/styleSamplePresets';

describe('loadStyleSamples', () => {
  it('loads presets with required fields and reasonable text length', async () => {
    const items = await loadStyleSamples();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.description.length).toBeGreaterThan(0);
      expect(typeof item.text).toBe('string');
      expect(item.text.trim().length).toBeGreaterThan(0);
      expect(item.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it('has no duplicate ids', async () => {
    const items = await loadStyleSamples();
    const ids = items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('validateStyleSamplesFile', () => {
  const validItem = {
    id: 'sample-a',
    label: '見本A',
    description: '説明',
    text: '本文',
  };

  it('rejects when root is not an object', () => {
    expect(() => validateStyleSamplesFile(null)).toThrow(/root must be an object/);
    expect(() => validateStyleSamplesFile([])).toThrow(/root must be an object/);
  });

  it('rejects when version is missing or not a number', () => {
    expect(() => validateStyleSamplesFile({ items: [] })).toThrow(/version/);
    expect(() => validateStyleSamplesFile({ version: '1', items: [] })).toThrow(/version/);
  });

  it('rejects when items is missing or not an array', () => {
    expect(() => validateStyleSamplesFile({ version: 1 })).toThrow(/items.*array/);
    expect(() => validateStyleSamplesFile({ version: 1, items: {} })).toThrow(/items.*array/);
  });

  it('rejects when a required field is missing or empty', () => {
    for (const field of ['id', 'label', 'description', 'text'] as const) {
      const broken = { ...validItem, [field]: '   ' };
      expect(() =>
        validateStyleSamplesFile({ version: 1, items: [broken] })
      ).toThrow(new RegExp(`items\\[0\\]\\.${field} must be a non-empty string`));
    }
  });

  it('rejects when text exceeds 1000 characters', () => {
    const tooLong = { ...validItem, text: 'あ'.repeat(1001) };
    expect(() => validateStyleSamplesFile({ version: 1, items: [tooLong] })).toThrow(
      /exceeds 1000 characters/
    );
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      validateStyleSamplesFile({
        version: 1,
        items: [validItem, { ...validItem, label: '別ラベル' }],
      })
    ).toThrow(/duplicates an earlier item/);
  });

  it('accepts valid input and returns typed items', () => {
    const items = validateStyleSamplesFile({ version: 1, items: [validItem] });
    expect(items).toEqual([validItem]);
  });
});
