import { describe, expect, it } from 'vitest';
import { normalizeSetupCommitData } from '../../src/server/services/setupCommitService';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';

function session(): SetupSession {
  return {
    schemaVersion: 1,
    sessionId: 'setup-test',
    projectId: null,
    status: 'active',
    revision: 1,
    model: {
      provider: 'gemini',
      modelName: 'gemini-3.5-flash',
    },
    projectSettings: {
      title: '',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {
        genre: 'modern-drama',
        style: 'natural-dialogue',
        pov: 'third-person-close',
        pacing: 'standard',
        density: 'balanced',
        relationshipPacing: 'standard',
      },
    },
    messages: [],
    draft: {
      ...createEmptySetupDraft(),
      coreConcept: '気弱な絵師と強気な岡っ引きの事件もの',
      world: ['江戸時代風の町'],
    },
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('setupCommitService', () => {
  it('normalizes commit data into existing project files shape', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        genre: ['modern-drama', 'mystery'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced', 'dialogue-rich'],
        relationshipPacing: ['standard'],
      },
      raw: {
        project: {
          title: '臆病絵師と岡っ引き',
          outputLength: 12000,
          activePresetIds: {
            genre: 'period-drama',
            style: 'natural-dialogue',
            pov: 'third-person-close',
            pacing: 'standard',
            density: 'dialogue-rich',
          },
        },
        worldText: '江戸時代風の町を舞台にした軽妙な事件もの。',
        characters: [
          {
            characterId: '../bad',
            role: 'protagonist',
            name: '',
            description: '気弱だが観察眼が鋭い絵師。',
          },
        ],
        memories: [
          {
            type: 'preference',
            content: '暗すぎず、少し笑える掛け合いを優先する。',
            importance: 'high',
          },
        ],
        storyState: {
          currentSituation: ['二人は小さな事件をきっかけに関わり始める。'],
          openThreads: [
            {
              summary: '主人公が顔色を読む理由は未確定。',
              importance: 'medium',
            },
          ],
        },
      },
    });

    expect(normalized.projectInput.title).toBe('臆病絵師と岡っ引き');
    expect(normalized.projectInput.outputLength).toBe(10000);
    expect(normalized.projectInput.activePresetIds?.genre).toBe('modern-drama');
    expect(normalized.projectInput.activePresetIds?.density).toBe('dialogue-rich');
    expect(normalized.projectInput.characters?.[0].characterId).toMatch(/^char-/);
    expect(normalized.memories[0]).toMatchObject({
      type: 'preference',
      importance: 'high',
      source: 'manual',
      status: 'active',
    });
    expect(normalized.storyState.schemaVersion).toBe(1);
    expect(normalized.storyState.openThreads[0].threadId).toMatch(/^thread-/);
  });

  it('falls back to draft world text when final conversion omits it', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
      },
      raw: {},
    });

    expect(normalized.projectInput.worldText).toContain('気弱な絵師');
    expect(normalized.projectInput.worldText).toContain('江戸時代風の町');
  });

  it('falls back to active draft characters when final conversion omits characters', () => {
    const setupSession = session();
    setupSession.draft.characters = [
      {
        id: 'char-draft-protagonist',
        role: 'protagonist',
        name: '',
        label: '気弱な絵師',
        description: '観察眼は鋭いが押しに弱い。',
        speechStyle: '控えめ',
        relationshipNotes: '岡っ引きに振り回される。',
        source: 'manual',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'char-draft-archived',
        role: 'supporting',
        name: '削除済み',
        label: '削除済み',
        description: '使わない。',
        source: 'manual',
        status: 'archived',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const normalized = normalizeSetupCommitData({
      session: setupSession,
      now,
      presetIdsByCategory: {
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
      },
      raw: {},
    });

    expect(normalized.projectInput.characters).toEqual([
      expect.objectContaining({
        characterId: 'char-draft-protagonist',
        name: '気弱な絵師',
        role: 'protagonist',
        description: '観察眼は鋭いが押しに弱い。',
        speechStyle: '控えめ',
        relationshipNotes: '岡っ引きに振り回される。',
      }),
    ]);
  });
});
