import { describe, expect, it } from 'vitest';
import { hasMeaningfulSetupContent } from '../../src/shared/setupContent';
import type { SetupDraft, SetupSession } from '../../src/shared/types';

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
    scenarioSeeds: [],
    ...patch,
  };
}

function session(
  draftPatch: Partial<SetupDraft> = {},
  messages: SetupSession['messages'] = []
): SetupSession {
  return {
    draft: draft(draftPatch),
    messages,
  } as SetupSession;
}

describe('hasMeaningfulSetupContent', () => {
  it('rejects a completely empty setup session', () => {
    expect(hasMeaningfulSetupContent(session())).toBe(false);
  });

  it('accepts user-authored chat or roleplay scenario content', () => {
    expect(
      hasMeaningfulSetupContent(
        session({}, [
          {
            role: 'user',
            content: '静かなミステリーにしたい',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        ])
      )
    ).toBe(true);
    expect(hasMeaningfulSetupContent(session({ scenarioSeeds: ['雨宿り中の会話'] }))).toBe(true);
  });
});
