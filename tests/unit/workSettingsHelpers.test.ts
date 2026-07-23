import { describe, expect, it } from 'vitest';
import {
  buildRefineNudgeMessage,
  clearRemovedPresetValues,
  deriveStyleTags,
  extractExcerpt,
  formatRelativeTime,
  summarizeStoryStateReduction,
} from '../../src/client/components/workSettings/workSettingsHelpers';
import { decodeKnowledgeFile } from '../../src/client/components/workSettings/knowledgeFile';
import type { RefineReviewStatus, StoryState } from '../../src/shared/types';

describe('work settings helpers', () => {
  it('decodes UTF-8 knowledge files and rejects unsupported extensions', async () => {
    const markdown = {
      name: 'notes.md',
      arrayBuffer: async () => new TextEncoder().encode('設定メモ').buffer,
    } as File;
    const image = {
      name: 'cover.png',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as File;

    await expect(decodeKnowledgeFile(markdown)).resolves.toBe('設定メモ');
    await expect(decodeKnowledgeFile(image)).rejects.toThrow('md / txt のみ');
  });

  it('builds style tags in the stable category order', () => {
    const categories = {
      aftertaste: {
        label: '読み味',
        items: {
          warm: { id: 'warm', label: '温かい', text: '' },
        },
      },
      narration: {
        label: '視点',
        items: {
          close: { id: 'close', label: '三人称一元', text: '' },
        },
      },
    };

    expect(
      deriveStyleTags(
        { narration: 'close', aftertaste: ['warm'] },
        categories
      )
    ).toEqual(['三人称一元', '温かい']);
  });

  it('returns explicit clears for optional presets removed in the editor', () => {
    expect(
      clearRemovedPresetValues(
        {
          narration: 'third-close',
          aftertaste: ['warm'],
          painLevel: 'safe',
        },
        { narration: 'third-close' }
      )
    ).toEqual({ aftertaste: [], painLevel: '' });
  });

  it('summarizes only destructive story-state reductions', () => {
    const before = {
      currentSituation: ['A', 'B'],
      characterStates: [{ characterId: 'char-1' }],
      importantEvents: [
        { eventId: 'event-1', status: 'active' },
        { eventId: 'event-2', status: 'archived' },
      ],
      openThreads: [],
      authorUndecided: [],
    } as unknown as StoryState;
    const after = {
      ...before,
      currentSituation: ['A'],
      characterStates: [],
      importantEvents: before.importantEvents,
    } as unknown as StoryState;

    expect(summarizeStoryStateReduction(before, after)).toEqual([
      '現在の状況: 2件 → 1件（-1件）',
      'キャラ状態: 1件 → 0件（-1件）',
    ]);
  });

  it('keeps excerpt and relative-time formatting deterministic', () => {
    expect(extractExcerpt('第一文です。第二文はかなり長く続きます。', 8)).toBe('第一文です。…');
    expect(
      formatRelativeTime('2026-07-23T00:00:00.000Z', Date.parse('2026-07-23T02:00:00.000Z'))
    ).toBe('2時間前');
  });

  it('prioritizes the settings-changed review reason', () => {
    const status = {
      reasons: ['story_state_edited', 'settings_changed'],
    } as RefineReviewStatus;

    expect(buildRefineNudgeMessage(status)).toContain('設定が前回のレビューから変更');
  });
});
