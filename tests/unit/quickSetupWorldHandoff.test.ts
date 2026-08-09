import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import * as setupSessionService from '../../src/server/services/setupSessionService';
import * as storage from '../../src/server/services/storageService';

const createdSessionIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((id) => storage.deleteSetupSession(id).catch(() => undefined))
  );
  createdSessionIds.length = 0;
});

describe('quick setup world handoff', () => {
  it('keeps structured world sections in the draft resumed by full setup', async () => {
    const created = await setupSessionService.createSetupSession({
      purpose: 'novel',
      setupMode: 'quick',
    });
    createdSessionIds.push(created.sessionId);
    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        title: 'Quick world handoff',
        coreConcept: 'A world that must survive the handoff.',
        contracts: [],
        characters: [],
        world: {
          foundation: 'Magic is powered by memories.',
          initialSituation: 'The city is under an uneasy truce.',
        },
        openingSeeds: [],
        latentCanon: [],
      }),
      finishReason: 'stop',
      retryable: false,
    });

    try {
      const result = await setupSessionService.createQuickSetupPlan(created.sessionId, {
        wish: 'A fantasy story.',
        revision: created.session.revision,
      });

      expect(result.plan.world).toEqual({
        foundation: 'Magic is powered by memories.',
        initialSituation: 'The city is under an uneasy truce.',
      });
      expect(result.session.draft.world).toEqual([
        'Magic is powered by memories.',
        'The city is under an uneasy truce.',
      ]);
    } finally {
      generateSpy.mockRestore();
    }
  });
});
