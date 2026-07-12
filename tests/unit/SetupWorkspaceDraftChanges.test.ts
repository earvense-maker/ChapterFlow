import { describe, expect, it } from 'vitest';
import { collectDraftChanges } from '../../src/client/components/SetupWorkspace';
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
});
