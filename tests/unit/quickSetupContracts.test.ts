import { afterEach, describe, expect, it } from 'vitest';
import * as setupSessionService from '../../src/server/services/setupSessionService';
import * as storage from '../../src/server/services/storageService';
import type { SetupSession } from '../../src/server/types/index';

const createdSessionIds: string[] = [];

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((id) => storage.deleteSetupSession(id).catch(() => undefined))
  );
  createdSessionIds.length = 0;
});

async function createQuickSession(): Promise<SetupSession> {
  const result = await setupSessionService.createSetupSession({
    purpose: 'novel',
    setupMode: 'quick',
  });
  createdSessionIds.push(result.sessionId);
  return result.session;
}

describe('confirmQuickContracts（レビュー指摘 P2・設計書 4.1）', () => {
  it('確認済みhardとAI提案softの両方を契約に残す', async () => {
    const session = await createQuickSession();
    const now = '2026-07-02T00:00:00Z';
    const withDraft: SetupSession = {
      ...session,
      draft: {
        ...session.draft,
        quickContracts: [
          {
            id: 'qctr-confirmed-hard',
            kind: 'promise',
            strength: 'hard',
            text: '護衛は最後まで裏切らない',
            source: 'user',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'qctr-ai-hard',
            kind: 'promise',
            strength: 'hard',
            text: '魔女は少しずつ信頼を育む',
            source: 'ai-suggested',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'qctr-ai-soft',
            kind: 'preference',
            strength: 'soft',
            text: '冷たく静かな雰囲気',
            source: 'ai-suggested',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      commitPlan: {
        plan: {
          project: {
            title: 'クイック',
            outputLength: 3000,
            activePresetIds: {},
            projectType: 'novel',
          },
          coreConcept: '人を信じられない魔女と護衛の話',
          firstWishSuggestion: '',
          styleSample: '',
          world: { foundation: '', initialSituation: '' },
          characters: [],
          memories: [],
          storyState: {
            schemaVersion: 1,
            currentSituation: [],
            characterStates: [],
            importantEvents: [],
            openThreads: [],
            authorUndecided: [],
            clock: { day: 1 },
            processedGenerationIds: [],
            updatedAt: now,
          },
          customSystemPrompt: '',
          latentSeedStatus: 'ok',
        },
        createdAt: now,
      },
    };
    await storage.writeSetupSession(withDraft);

    const result = await setupSessionService.confirmQuickContracts(session.sessionId, {
      items: [
        { id: 'qctr-confirmed-hard', confirmed: true },
        { id: 'qctr-ai-hard', confirmed: false },
        { id: 'qctr-ai-soft', confirmed: true },
      ],
      revision: session.revision,
    });

    const contractTexts = (result.plan.creativeContract ?? []).map((item) => item.text);
    // 確認済みhardは残る
    expect(contractTexts).toContain('護衛は最後まで裏切らない');
    // 未確認のAI提案hardは契約に残らない
    expect(contractTexts).not.toContain('魔女は少しずつ信頼を育む');
    // AI提案softは「確認不要」として契約に残る
    expect(contractTexts).toContain('冷たく静かな雰囲気');
    const soft = (result.plan.creativeContract ?? []).find(
      (item) => item.text === '冷たく静かな雰囲気'
    );
    expect(soft?.strength).toBe('soft');
  });

  it('hard8件・soft12件の上限を守る', async () => {
    const session = await createQuickSession();
    const now = '2026-07-02T00:00:00Z';
    const withDraft: SetupSession = {
      ...session,
      draft: {
        ...session.draft,
        quickContracts: [
          ...Array.from({ length: 9 }, (_, index) => ({
            id: `qctr-hard-${index}`,
            kind: 'promise' as const,
            strength: 'hard' as const,
            text: `hard約束${index}`,
            source: 'user' as const,
            status: 'active' as const,
            createdAt: now,
            updatedAt: now,
          })),
          ...Array.from({ length: 13 }, (_, index) => ({
            id: `qctr-soft-${index}`,
            kind: 'preference' as const,
            strength: 'soft' as const,
            text: `soft好み${index}`,
            source: 'ai-suggested' as const,
            status: 'active' as const,
            createdAt: now,
            updatedAt: now,
          })),
        ],
      },
      commitPlan: {
        plan: {
          project: { title: 'クイック', outputLength: 3000, activePresetIds: {}, projectType: 'novel' },
          coreConcept: '核',
          firstWishSuggestion: '',
          styleSample: '',
          world: { foundation: '', initialSituation: '' },
          characters: [],
          memories: [],
          storyState: {
            schemaVersion: 1,
            currentSituation: [],
            characterStates: [],
            importantEvents: [],
            openThreads: [],
            authorUndecided: [],
            clock: { day: 1 },
            processedGenerationIds: [],
            updatedAt: now,
          },
          customSystemPrompt: '',
          latentSeedStatus: 'ok',
        },
        createdAt: now,
      },
    };
    await storage.writeSetupSession(withDraft);

    const result = await setupSessionService.confirmQuickContracts(session.sessionId, {
      items: [
        ...Array.from({ length: 9 }, (_, index) => ({ id: `qctr-hard-${index}`, confirmed: true })),
        ...Array.from({ length: 13 }, (_, index) => ({ id: `qctr-soft-${index}`, confirmed: true })),
      ],
      revision: session.revision,
    });

    const hardCount = (result.plan.creativeContract ?? []).filter(
      (item) => item.strength === 'hard'
    ).length;
    const softCount = (result.plan.creativeContract ?? []).filter(
      (item) => item.strength === 'soft'
    ).length;
    expect(hardCount).toBeLessThanOrEqual(8);
    expect(softCount).toBeLessThanOrEqual(12);
  });
});
