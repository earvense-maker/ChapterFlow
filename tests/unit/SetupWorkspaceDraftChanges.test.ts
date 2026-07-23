import { describe, expect, it } from 'vitest';
import { collectDraftChanges } from '../../src/client/components/setupWorkspace/draftChanges';
import type { SetupDraft } from '../../src/shared/types';

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return {
    coreConcept: '',
    confirmed: [],
    candidates: [],
    undecided: [],
    characters: [],
    relationshipSeeds: [],
    world: [],
    tone: [],
    ng: [],
    openingSeeds: [],
    ...patch,
  };
}

describe('SetupWorkspace draft change summaries', () => {
  it('folds same-text string remove/add pairs into a reorder summary', () => {
    const changes = collectDraftChanges(
      draft({ world: ['City', 'Library'] }),
      draft({ world: ['Library', 'City'] })
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'updated',
      text: '世界観「City」の順番を変更',
    });
  });

  it('detects trait and secrets changes on an existing character', () => {
    const baseCharacter = {
      id: 'char-1',
      role: 'protagonist' as const,
      name: 'ユイ',
      label: '旅人',
      description: '旅をしている',
      traits: [{ label: 'こだわり', text: '約束は守る' }],
      secrets: '王家の血を引く',
      source: 'manual' as const,
      status: 'active' as const,
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    };
    const changes = collectDraftChanges(
      draft({ characters: [baseCharacter] }),
      draft({
        characters: [
          {
            ...baseCharacter,
            traits: [{ label: 'こだわり', text: '約束より仲間を選ぶ' }],
            secrets: '',
          },
        ],
      })
    );

    expect(changes).toEqual([
      expect.objectContaining({ kind: 'updated', text: '人物「旅人」を更新' }),
    ]);
  });
});
