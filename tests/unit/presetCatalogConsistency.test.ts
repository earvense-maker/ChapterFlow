import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PRESET_ID_SETS,
  NOVEL_PRESET_CATEGORY_ORDER,
  ROLEPLAY_PRESET_CATEGORY_ORDER,
} from '../../src/shared/presetMigration';

interface PresetCatalog {
  categories: Record<
    string,
    {
      items: Record<string, { id: string }>;
    }
  >;
}

const catalog = JSON.parse(
  readFileSync(resolve(process.cwd(), 'presets', 'default-presets.json'), 'utf8')
) as PresetCatalog;

describe('default preset catalog consistency', () => {
  it('keeps JSON item IDs and normalization allowlists exactly in sync', () => {
    const categoryKeys = [
      ...NOVEL_PRESET_CATEGORY_ORDER,
      ...ROLEPLAY_PRESET_CATEGORY_ORDER,
    ];

    for (const categoryKey of categoryKeys) {
      const category = catalog.categories[categoryKey];
      expect(category, `${categoryKey} category`).toBeDefined();

      const jsonIds = Object.keys(category.items).sort();
      const allowedIds = [...BUILT_IN_PRESET_ID_SETS[categoryKey]].sort();
      expect(jsonIds, `${categoryKey} IDs`).toEqual(allowedIds);

      for (const [itemKey, item] of Object.entries(category.items)) {
        expect(item.id, `${categoryKey}.${itemKey}.id`).toBe(itemKey);
      }
    }
  });
});
