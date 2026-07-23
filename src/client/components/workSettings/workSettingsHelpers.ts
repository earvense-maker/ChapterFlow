import type { PresetCategory } from '../PresetSelector';
import type {
  Project,
  RefineReviewStatus,
  StoryState,
  StoryStateDiffRecord,
} from '@shared/types';

// NOTE: プリセットカテゴリ ID → タグに使う短い日本語名。作品像サマリーでは
// preset ラベルを参照し、カテゴリ側は既知キーだけを扱う。
const STYLE_TAG_CATEGORY_ORDER = [
  'narration',
  'aftertaste',
  'emotionDisplay',
  'sceneProgression',
  'chapterEnding',
  'painLevel',
] as const;

// NOTE: 物語状態の主要な active 配列について、before → after で減った件数だけを
// ラベル付きで返す。JSON 生編集時の確認ダイアログで損失内容を具体化する。
export function summarizeStoryStateReduction(
  before: StoryState,
  after: StoryState
): string[] {
  const activeCount = <T extends { status?: string }>(items: T[] | undefined): number =>
    (items ?? []).filter((item) => (item.status ?? 'active') !== 'archived').length;

  const rows: Array<{ label: string; before: number; after: number }> = [
    {
      label: '現在の状況',
      before: (before.currentSituation ?? []).length,
      after: (after.currentSituation ?? []).length,
    },
    {
      label: '重要イベント',
      before: activeCount(before.importantEvents),
      after: activeCount(after.importantEvents),
    },
    {
      label: '未解決の糸',
      before: activeCount(before.openThreads),
      after: activeCount(after.openThreads),
    },
    {
      label: '未確定事項',
      before: activeCount(before.authorUndecided),
      after: activeCount(after.authorUndecided),
    },
    {
      label: 'キャラ状態',
      before: (before.characterStates ?? []).length,
      after: (after.characterStates ?? []).length,
    },
  ];

  return rows
    .filter((row) => row.after < row.before)
    .map((row) => `${row.label}: ${row.before}件 → ${row.after}件（-${row.before - row.after}件）`);
}

// NOTE: world 冒頭を要約代わりに使う。段落境界と maxChars で切り詰める。
export function extractExcerpt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'));
  if (lastBreak > maxChars * 0.5) return cut.slice(0, lastBreak + 1) + '…';
  return cut + '…';
}

export function deriveStyleTags(
  activePresetIds: Project['activePresetIds'],
  categories: Record<string, PresetCategory> | null
): string[] {
  if (!categories) return [];
  const tags: string[] = [];
  for (const categoryKey of STYLE_TAG_CATEGORY_ORDER) {
    const category = categories[categoryKey];
    if (!category) continue;
    const selected = activePresetIds[categoryKey];
    const presetIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
    for (const presetId of presetIds) {
      const item = Object.values(category.items).find((candidate) => candidate.id === presetId);
      if (item) tags.push(item.label);
    }
  }
  return tags;
}

export function clearRemovedPresetValues(
  current: Project['activePresetIds'],
  next: Project['activePresetIds']
): Partial<Project['activePresetIds']> {
  const cleared: Record<string, string | string[]> = {};
  if (current.aftertaste && !next.aftertaste) cleared.aftertaste = [];
  for (const key of [
    'emotionDisplay',
    'sceneProgression',
    'chapterEnding',
    'painLevel',
    'intimacy',
  ] as const) {
    if (current[key] && !next[key]) cleared[key] = '';
  }
  return cleared as Partial<Project['activePresetIds']>;
}

export function formatStoryDiffSummary(diff: StoryStateDiffRecord): string {
  const parts = [
    diff.summary.addedEvents.length ? `イベント+${diff.summary.addedEvents.length}` : '',
    diff.summary.updatedEvents.length ? `イベント更新${diff.summary.updatedEvents.length}` : '',
    diff.summary.addedThreads.length ? `未解決+${diff.summary.addedThreads.length}` : '',
    diff.summary.resolvedThreads.length ? `解決${diff.summary.resolvedThreads.length}` : '',
    diff.summary.updatedCharacters.length ? `人物${diff.summary.updatedCharacters.length}名` : '',
    diff.summary.clockChanged ? '時間更新' : '',
  ].filter(Boolean);
  return parts.join(' / ') || `自動更新 ${diff.generationId}`;
}

export function buildRefineNudgeMessage(status: RefineReviewStatus): string {
  if (status.reasons.includes('settings_changed')) {
    return '設定が前回のレビューから変更されています。設定と物語の整合性を確認しますか？';
  }
  if (status.reasons.includes('story_state_edited')) {
    return '物語の状態が手動で変更されています。設定と現状のずれを確認しますか？';
  }
  if (status.reasons.includes('history_truncated')) {
    return '前回のレビュー時点の履歴が保持上限を超えています。設定と現状のずれを確認しますか？';
  }
  return '前回のレビューから本文が進んでいます。設定と現状のずれを確認しますか？';
}

// NOTE: 「3日前」「5分前」等の相対時刻表示。
export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'たった今';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  const month = Math.floor(day / 30);
  return `${month}ヶ月前`;
}
