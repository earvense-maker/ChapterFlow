import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RoleplayWorkspace from '../../src/client/components/RoleplayWorkspace';
import { NotificationProvider } from '../../src/client/components/NotificationCenter';
import type { Character, Project, RoleplaySessionSummary, RoleplaySessionView } from '../../src/shared/types';

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
  events: { firstOutput: true, completed: true, failed: true, settingsUpdated: true, reviewRequired: true },
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
});
