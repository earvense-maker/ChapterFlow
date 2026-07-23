import type { SetupSession } from './types.js';

/**
 * Returns whether a setup session contains enough user-authored material to
 * continue beyond the initial empty state.
 *
 * NOTE: This predicate is shared by the client and server so the cold-start UI
 * and commit validation cannot drift apart as draft fields evolve.
 */
export function hasMeaningfulSetupContent(session: SetupSession): boolean {
  const draft = session.draft;
  return Boolean(
    session.messages.some((message) => message.role === 'user' && message.content.trim()) ||
      draft.coreConcept.trim() ||
      draft.confirmed.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.candidates.some(
        (item) => item.status === 'active' && (item.title.trim() || item.summary.trim())
      ) ||
      draft.undecided.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.characters.some(
        (item) =>
          item.status === 'active' &&
          (item.name.trim() || item.label.trim() || item.description.trim())
      ) ||
      draft.relationshipSeeds.some((item) => item.trim()) ||
      draft.world.some((item) => item.trim()) ||
      draft.tone.some((item) => item.trim()) ||
      draft.ng.some((item) => item.trim()) ||
      draft.openingSeeds.some((item) => item.trim()) ||
      (draft.scenarioSeeds ?? []).some((item) => item.trim())
  );
}
