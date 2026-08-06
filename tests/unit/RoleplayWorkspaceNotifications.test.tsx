import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RoleplayWorkspace from '../../src/client/components/RoleplayWorkspace';
import { NotificationProvider } from '../../src/client/components/NotificationCenter';
import type {
  Character,
  Project,
  PromptBudgetReport,
  RoleplaySessionSummary,
  RoleplaySessionView,
} from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  archiveRoleplaySession: vi.fn(),
  createExpression: vi.fn(),
  createGlobalExpression: vi.fn(),
  createRoleplaySession: vi.fn(),
  getCharacters: vi.fn(),
  getNotificationSettings: vi.fn(),
  getProject: vi.fn(),
  getRoleplaySession: vi.fn(),
  listRoleplaySessions: vi.fn(),
  regenerateRoleplayStream: vi.fn(),
  sendRoleplayMessageStream: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const ENABLED_SETTINGS = {
  soundEnabled: false,
  systemPopupEnabled: false,
  onlyWhenUnfocused: false,
  events: {
    firstOutput: true,
    completed: true,
    failed: true,
    settingsUpdated: true,
    reviewRequired: true,
    ngRewrite: true,
    budgetTruncated: true,
  },
};

function renderRoleplayWorkspace() {
  return render(
    <NotificationProvider>
      <RoleplayWorkspace
        projectId="project-roleplay"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
      />
    </NotificationProvider>
  );
}

function project(): Project {
  return {
    schemaVersion: 1,
    projectId: 'project-roleplay',
    title: 'ロールプレイ作品',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    activeModelProvider: 'gemini',
    activeModelName: 'gemini-test',
    outputLength: 1000,
    streamingEnabled: true,
    activePresetIds: { narration: 'third-close' },
    projectType: 'roleplay',
  };
}

function character(): Character {
  return { characterId: 'character-a', name: 'アリス', role: 'protagonist', description: '穏やかな人物。' };
}

function session(overrides: Partial<RoleplaySessionView> = {}): RoleplaySessionView {
  return {
    schemaVersion: 1,
    sessionId: 'session-a',
    projectId: 'project-roleplay',
    characterId: 'character-a',
    characterName: 'アリス',
    status: 'active',
    messages: [
      { messageId: 'message-greeting', role: 'character', content: 'こんにちは。', createdAt: '2026-07-18T00:00:00.000Z' },
    ],
    model: { provider: 'gemini', modelName: 'gemini-test' },
    revision: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function budgetReport(entries: PromptBudgetReport['entries']): PromptBudgetReport {
  return { maxChars: 24_000, assembledChars: 18_000, entries };
}

function sessionWithBudgetNotice(messageReport: PromptBudgetReport): RoleplaySessionView {
  return session({
    revision: 1,
    messages: [
      { messageId: 'message-greeting', role: 'character', content: 'こんにちは。', createdAt: '2026-07-18T00:00:00.000Z' },
      {
        messageId: 'message-budget',
        role: 'character',
        content: '返答。',
        createdAt: '2026-07-18T00:01:00.000Z',
        promptBudgetReport: messageReport,
      },
    ],
  });
}

function sessionSummary(): RoleplaySessionSummary {
  return {
    sessionId: 'session-a',
    characterId: 'character-a',
    characterName: 'アリス',
    status: 'active',
    messageCount: 1,
    lastExcerpt: 'こんにちは。',
    revision: 0,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('RoleplayWorkspace generation notifications', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(apiMock)) mock.mockReset();
    apiMock.getProject.mockResolvedValue(project());
    apiMock.getCharacters.mockResolvedValue([character()]);
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [sessionSummary()] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: session() });
    apiMock.getNotificationSettings.mockResolvedValue(ENABLED_SETTINGS);
  });

  it('fires firstOutput once and completed after a successful streamed reply', async () => {
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(async (_projectId, _sessionId, _body, handlers) => {
      handlers.onChunk('最初のかけら');
      handlers.onChunk('');
      handlers.onChunk('つづき');
      handlers.onDone(session({ revision: 1 }));
    });

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => expect(screen.queryByText('応答が完了しました')).not.toBeNull());
    expect(screen.getAllByText('応答の生成が始まりました')).toHaveLength(1);
  });

  it('fires failed on a real send error but not on an explicit stop', async () => {
    let signal: AbortSignal | undefined;
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers, abortSignal?: AbortSignal) => {
        signal = abortSignal;
        return new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              handlers.onError({ error: '中断しました', code: 'aborted', retryable: false });
              resolve();
            },
            { once: true }
          );
        });
      }
    );

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(screen.queryByText('応答の生成に失敗しました')).toBeNull();
  });

  it('fires a failed notification for a genuine (non-abort) send error', async () => {
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(async (_projectId, _sessionId, _body, handlers) => {
      handlers.onError({ error: 'サーバーエラー', code: 'server_error', retryable: false });
    });

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => expect(screen.queryByText('応答の生成に失敗しました')).not.toBeNull());
  });

  // NOTE: AC13。done.session の末尾 character メッセージに予算調整の report があれば通知し、
  // ラベルは日本語で生の sectionId は出さない。
  it('notifies about budget adjustment after a streamed reply (done path)', async () => {
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers) => {
        handlers.onChunk('返答。');
        handlers.onDone(
          sessionWithBudgetNotice(
            budgetReport([
              {
                sectionId: 'roleplay.recentMessages',
                originalChars: 16_000,
                includedChars: 12_000,
                action: 'truncated',
              },
            ])
          )
        );
      }
    );

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() =>
      expect(screen.queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(screen.queryByText('直近の会話の一部を省略しました')).not.toBeNull();
    expect(screen.queryByText('roleplay.recentMessages')).toBeNull();
  });

  it('notifies about budget adjustment when a saved session is reloaded (AC13)', async () => {
    apiMock.getRoleplaySession.mockResolvedValue({
      session: sessionWithBudgetNotice(
        budgetReport([
          {
            sectionId: 'roleplay.variablePrompt',
            originalChars: 24_000,
            includedChars: 20_000,
            action: 'truncated',
          },
        ])
      ),
    });

    renderRoleplayWorkspace();

    await waitFor(() =>
      expect(screen.queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(screen.queryByText('会話プロンプトの一部を省略しました')).not.toBeNull();
  });

  it('does not notify about budget when every entry is full (AC13)', async () => {
    apiMock.getRoleplaySession.mockResolvedValue({
      session: sessionWithBudgetNotice(
        budgetReport([
          {
            sectionId: 'roleplay.fixedRules',
            originalChars: 1_200,
            includedChars: 1_200,
            action: 'full',
          },
          {
            sectionId: 'roleplay.variablePrompt',
            originalChars: 5_000,
            includedChars: 5_000,
            action: 'full',
          },
        ])
      ),
    });

    renderRoleplayWorkspace();
    await waitFor(() => expect(apiMock.getRoleplaySession).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('プロンプト予算のため一部を調整しました')).toBeNull();
  });

  it('keeps working without budget reports in old sessions (AC13 / 要件6)', async () => {
    // session() は promptBudgetReport を持たない旧形式。
    apiMock.getRoleplaySession.mockResolvedValue({ session: session() });

    renderRoleplayWorkspace();
    await waitFor(() => expect(apiMock.getRoleplaySession).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText('プロンプト予算のため一部を調整しました')).toBeNull();
    expect(await screen.findByRole('textbox')).not.toBeNull();
  });

  // NOTE: system 側の縮小（対象キャラ等）はセッション作成時に一度だけ通知する。
  // ターンの結合 report に system 調整が含まれても、ターン通知では出さない。
  it('does not notify per turn when only system sections were adjusted in the turn report', async () => {
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers) => {
        handlers.onChunk('返答。');
        handlers.onDone(
          sessionWithBudgetNotice(
            budgetReport([
              {
                sectionId: 'roleplay.character',
                originalChars: 6_000,
                includedChars: 4_000,
                action: 'truncated',
              },
              {
                sectionId: 'roleplay.variablePrompt',
                originalChars: 5_000,
                includedChars: 5_000,
                action: 'full',
              },
            ])
          )
        );
      }
    );

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() => expect(screen.queryByText('応答が完了しました')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    // ターン通知は出ない（system 調整はセッション作成時のみ）。
    expect(screen.queryByText('プロンプト予算のため一部を調整しました')).toBeNull();
    expect(screen.queryByText('対象キャラクター')).toBeNull();
  });

  it('notifies the turn-specific part only when the turn report mixes system and turn adjustments', async () => {
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers) => {
        handlers.onChunk('返答。');
        handlers.onDone(
          sessionWithBudgetNotice(
            budgetReport([
              {
                sectionId: 'roleplay.character',
                originalChars: 6_000,
                includedChars: 4_000,
                action: 'truncated',
              },
              {
                sectionId: 'roleplay.recentMessages',
                originalChars: 16_000,
                includedChars: 12_000,
                action: 'truncated',
              },
            ])
          )
        );
      }
    );

    renderRoleplayWorkspace();
    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: 'こんにちは' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    await waitFor(() =>
      expect(screen.queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    // ターン固有（直近の会話）だけが通知され、system 側（対象キャラクター）は出ない。
    expect(screen.queryByText('直近の会話の一部を省略しました')).not.toBeNull();
    expect(screen.queryByText('対象キャラクター')).toBeNull();
  });

  // NOTE: セッション作成時の system 縮小は appliedSettings.promptBudgetReport として
  // 一度だけ通知される（dedupeKey は sessionId）。
  it('notifies once about the system adjustment from the session snapshot on reload', async () => {
    apiMock.getRoleplaySession.mockResolvedValue({
      session: session({
        appliedSettings: {
          capturedAt: '2026-07-18T00:00:00.000Z',
          presets: [],
          promptBudgetReport: budgetReport([
            {
              sectionId: 'roleplay.character',
              originalChars: 6_000,
              includedChars: 4_000,
              action: 'truncated',
            },
          ]),
        },
      }),
    });

    renderRoleplayWorkspace();

    await waitFor(() =>
      expect(screen.queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(screen.queryByText('対象キャラクターの一部を省略しました')).not.toBeNull();
    expect(screen.queryByText('roleplay.character')).toBeNull();
  });
});
