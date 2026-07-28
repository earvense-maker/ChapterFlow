import { promises as fs } from 'node:fs';
import { PRESETS_PATH } from '../config.js';
import { NOVEL_PRESET_CATEGORY_ORDER } from '../../shared/presetMigration.js';
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

// NOTE: categoryOrder で「どの語彙セットを流すか」を切り替える。既定は小説用で、
// ロールプレイは ROLEPLAY_RENDERED_PRESET_CATEGORY_ORDER を明示的に渡す。
export async function renderPresets(
  activePresets: ActivePresets,
  categoryOrder: readonly (keyof ActivePresets)[] = NOVEL_PRESET_CATEGORY_ORDER,
  // NOTE: 既定の見出しは systemPrompt.ts の SELECTED_SETTINGS_HEADING と同値。旧データから
  // 追加指示を切り出す際の目印になっているので、小説側では変更しないこと。
  heading = '【選択された設定】'
): Promise<string> {
  const categories = await loadPresetCategories();
  const parts: string[] = [];

  for (const categoryKey of categoryOrder) {
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
  return `${heading}\n${parts.join('\n\n')}`;
}

export async function getPresetLabel(categoryKey: string, presetId: string): Promise<string | null> {
  const categories = await loadPresetCategories();
  return categories[categoryKey]?.items[presetId]?.label ?? null;
}
