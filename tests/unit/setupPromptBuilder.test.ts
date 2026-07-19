import { describe, expect, it } from 'vitest';
import { buildSetupChatPrompt, buildSetupCommitPrompt } from '../../src/server/services/setupPromptBuilder';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';

function baseSession(): SetupSession {
  return {
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
        narration: 'third-close',
        aftertaste: ['poignant'],
      },
    },
    messages: [],
    draft: createEmptySetupDraft(),
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

const presetIdsByCategory = {
  narration: ['third-close'],
  aftertaste: ['poignant', 'searing'],
  emotionDisplay: ['restrained', 'expressive'],
  sceneProgression: ['immersive', 'brisk'],
  chapterEnding: ['hook', 'lingering'],
  painLevel: ['safe', 'bittersweet', 'unflinching'],
};

describe('setupPromptBuilder', () => {
  it('omits archived draft items from commit prompts', () => {
    const session: SetupSession = {
      ...baseSession(),
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
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory,
    });

    expect(userPrompt).toContain('残す設定');
    expect(userPrompt).not.toContain('削除済み設定');
  });

  it('limits commit prompt conversation history and message length', () => {
    const longText = '長い相談'.repeat(300);
    const session: SetupSession = {
      ...baseSession(),
      sessionId: 'setup-prompt-long-chat',
      messages: Array.from({ length: 30 }, (_, index) => ({
        messageId: `msg-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0 ? '古すぎる相談' : index === 29 ? longText : `相談${index}`,
        createdAt: now,
      })),
    };

    const { userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory,
    });

    expect(userPrompt).toContain('【直近の会話ログ】');
    expect(userPrompt).not.toContain('古すぎる相談');
    expect(userPrompt).toContain(`${longText.slice(0, 800)}...`);
    expect(userPrompt).not.toContain(longText);
  });

  it('includes latest preview in chat prompt truncated to 800 chars', () => {
    const longPreview = '試し書きの本文。'.repeat(150);
    const session: SetupSession = {
      ...baseSession(),
      previews: [
        { previewId: 'preview-old', text: '古い試し書き', createdAt: now },
        { previewId: 'preview-latest', text: longPreview, createdAt: now },
      ],
    };

    const { userPrompt } = buildSetupChatPrompt({ session, userMessage: 'もっと軽くして' });

    expect(userPrompt).toContain('【直近の試し書きサンプル】');
    expect(userPrompt).toContain(longPreview.slice(0, 800));
    expect(userPrompt).not.toContain('古い試し書き');
    expect(userPrompt).not.toContain(longPreview.slice(0, 801));
  });

  it('includes latest preview in commit prompt as style reference', () => {
    const session: SetupSession = {
      ...baseSession(),
      previews: [{ previewId: 'preview-1', text: 'さわやかな朝の情景。', createdAt: now }],
    };

    const { userPrompt } = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(userPrompt).toContain('【試し書きサンプル(文体・温度の参考)】');
    expect(userPrompt).toContain('さわやかな朝の情景。');
  });

  it('omits preview section when no previews exist', () => {
    const session = baseSession();

    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).not.toContain('【直近の試し書きサンプル】');
    expect(commit.userPrompt).not.toContain('【試し書きサンプル(文体・温度の参考)】');
  });

  it('includes conversation summary in chat and commit prompts when present', () => {
    const session: SetupSession = {
      ...baseSession(),
      conversationSummary: 'これまでに主人公は気弱な絵師に決定。',
    };

    const chat = buildSetupChatPrompt({ session, userMessage: '続き' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).toContain('【これまでの相談の要約】');
    expect(chat.userPrompt).toContain(session.conversationSummary);
    expect(commit.userPrompt).toContain('【これまでの相談の要約】');
    expect(commit.userPrompt).toContain(session.conversationSummary);
  });

  it('omits conversation summary section when summary is empty', () => {
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });
    const commit = buildSetupCommitPrompt({ session, presetIdsByCategory });

    expect(chat.userPrompt).not.toContain('【これまでの相談の要約】');
    expect(commit.userPrompt).not.toContain('【これまでの相談の要約】');
  });

  it('uses the marker-based two-part output format in chat prompt', () => {
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: 'hello' });

    expect(chat.systemInstructions).toContain('===DRAFT_PATCH===');
    expect(chat.userPrompt).toContain('===DRAFT_PATCH===');
    expect(chat.userPrompt).toContain('"conversationSummary"');
  });

  it('guides the consultation while omitting internal session identifiers from the prompt', () => {
    const session = baseSession();
    const chat = buildSetupChatPrompt({ session, userMessage: '相談を始めたい' });

    expect(chat.systemInstructions).toContain('A/B/C');
    expect(chat.systemInstructions).toContain('気に入った要素は混ぜても大丈夫');
    expect(chat.systemInstructions).toContain('何に揺れるか');
    expect(chat.systemInstructions).toContain('物語を動かす火種');
    expect(chat.systemInstructions).toContain('suggestedActions');
    expect(chat.systemInstructions).toContain('intent:"preview"');
    expect(chat.userPrompt).toContain('"intent": "preview"');
    expect(chat.userPrompt).not.toContain(session.sessionId);
    expect(chat.userPrompt).not.toContain('"revision": 1');
  });
});
