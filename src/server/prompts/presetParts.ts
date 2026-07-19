import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import { PRESET_CATEGORY_ORDER } from '../../shared/presetMigration.js';
import type { ActivePresets } from '../types/index.js';

let presetCache: Record<string, PresetCategory> | null = null;

interface PresetCategory {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
}

export async function loadPresetCategories(): Promise<Record<string, PresetCategory>> {
  if (presetCache) return presetCache;
  const text = await fs.readFile(PRESETS_PATH, 'utf-8');
  const data = JSON.parse(text) as { categories: Record<string, PresetCategory> };
  presetCache = data.categories;
  return presetCache;
}

export async function renderPresets(activePresets: ActivePresets): Promise<string> {
  const categories = await loadPresetCategories();
  const parts: string[] = [];

  for (const categoryKey of PRESET_CATEGORY_ORDER) {
    const category = categories[categoryKey];
    if (!category) continue;
    const selected = activePresets[categoryKey];
    const presetIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
    for (const presetId of presetIds) {
      const item = category.items[presetId];
      if (!item?.text.trim()) continue;
      parts.push(`【${category.label}: ${item.label}】\n${item.text}`);
    }
  }

  if (parts.length === 0) return '';
  return `【選択された設定】\n${parts.join('\n\n')}`;
}

export async function getPresetLabel(categoryKey: string, presetId: string): Promise<string | null> {
  const categories = await loadPresetCategories();
  return categories[categoryKey]?.items[presetId]?.label ?? null;
}
