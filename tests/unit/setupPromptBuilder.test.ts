import { describe, expect, it } from 'vitest';
import { buildSetupCommitPrompt } from '../../src/server/services/setupPromptBuilder';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';

describe('setupPromptBuilder', () => {
  it('omits archived draft items from commit prompts', () => {
    const session: SetupSession = {
      schemaVersion: 1,
      sessionId: 'setup-prompt-test',
      projectId: null,
      status: 'active',
      revision: 1,
      model: { provider: 'gemini', modelName: 'gemini-test' },
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
        },
      },
      messages: [],
      draft: {
        ...createEmptySetupDraft(),
        confirmed: [
          {
            id: 'fact-active',
            text: '残す設定',
            source: 'manual',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'fact-archived',
            text: '削除済み設定',
            source: 'manual',
            status: 'archived',
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      locks: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory: {
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
      },
    });

    expect(userPrompt).toContain('残す設定');
    expect(userPrompt).not.toContain('削除済み設定');
  });

  it('limits commit prompt conversation history and message length', () => {
    const longText = '長い相談'.repeat(300);
    const session: SetupSession = {
      schemaVersion: 1,
      sessionId: 'setup-prompt-long-chat',
      projectId: null,
      status: 'active',
      revision: 1,
      model: { provider: 'gemini', modelName: 'gemini-test' },
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
        },
      },
      messages: Array.from({ length: 30 }, (_, index) => ({
        messageId: `msg-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0 ? '古すぎる相談' : index === 29 ? longText : `相談${index}`,
        createdAt: now,
      })),
      draft: createEmptySetupDraft(),
      locks: [],
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory: {
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
      },
    });

    expect(userPrompt).toContain('【直近の会話ログ】');
    expect(userPrompt).not.toContain('古すぎる相談');
    expect(userPrompt).toContain(`${longText.slice(0, 800)}...`);
    expect(userPrompt).not.toContain(longText);
  });
});
