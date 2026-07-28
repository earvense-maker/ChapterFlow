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

export interface RenderedPresetBlock {
  categoryKey: string;
  presetId: string;
  /** 【カテゴリ: ラベル】。予算配分でも必ず残す識別子。 */
  label: string;
  /** ラベルを含む完成ブロック。 */
  block: string;
}

// NOTE: 予算配分は「選択された各プリセットへ最低予約を配ってから拡張する」ため、
// 結合済み文字列ではなくブロック単位が要る（設計書 4.1）。renderPresets はこの結果を
// 結合するだけの薄いラッパにして、描画規則が二重定義にならないようにする。
export async function renderPresetBlocks(
  activePresets: ActivePresets,
  categoryOrder: readonly (keyof ActivePresets)[] = NOVEL_PRESET_CATEGORY_ORDER
): Promise<RenderedPresetBlock[]> {
  const categories = await loadPresetCategories();
  const blocks: RenderedPresetBlock[] = [];

  for (const categoryKey of categoryOrder) {
    const category = categories[categoryKey];
    if (!category) continue;
    const selected = activePresets[categoryKey];
    const presetIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
    for (const presetId of presetIds) {
      const item = category.items[presetId];
      if (!item?.text.trim()) continue;
      const label = `【${category.label}: ${item.label}】`;
      blocks.push({
        categoryKey: String(categoryKey),
        presetId,
        label,
        block: `${label}\n${item.text}`,
      });
    }
  }

  return blocks;
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
  const blocks = await renderPresetBlocks(activePresets, categoryOrder);
  if (blocks.length === 0) return '';
  return `${heading}\n${blocks.map((entry) => entry.block).join('\n\n')}`;
}

export async function getPresetLabel(categoryKey: string, presetId: string): Promise<string | null> {
  const categories = await loadPresetCategories();
  return categories[categoryKey]?.items[presetId]?.label ?? null;
}
