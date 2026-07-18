import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RoleplayWorkspace from '../../src/client/components/RoleplayWorkspace';
import type {
  Character,
  Project,
  RoleplaySessionSummary,
  RoleplaySessionView,
} from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  archiveRoleplaySession: vi.fn(),
  createExpression: vi.fn(),
  createRoleplaySession: vi.fn(),
  getCharacters: vi.fn(),
  getProject: vi.fn(),
  getRoleplaySession: vi.fn(),
  listRoleplaySessions: vi.fn(),
  regenerateRoleplayStream: vi.fn(),
  sendRoleplayMessageStream: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

describe('RoleplayWorkspace correction send', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(apiMock)) mock.mockReset();
    apiMock.getProject.mockResolvedValue(project());
    apiMock.getCharacters.mockResolvedValue([character()]);
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [sessionSummary()] });
  });

  it('restores the stopped text and replaces the unanswered user message on resend', async () => {
    const initial = session();
    const pending = session({
      revision: 1,
      messages: [
        ...initial.messages,
        {
          messageId: 'message-pending',
          role: 'user',
          content: '間違った発言',
          createdAt: '2026-07-18T00:01:00.000Z',
        },
      ],
    });
    const corrected = session({
      revision: 3,
      messages: [
        initial.messages[0],
        {
          messageId: 'message-pending',
          role: 'user',
          content: '訂正した発言',
          createdAt: '2026-07-18T00:01:00.000Z',
        },
        {
          messageId: 'message-response',
          role: 'character',
          content: '訂正文への応答',
          createdAt: '2026-07-18T00:02:00.000Z',
        },
      ],
    });
    apiMock.getRoleplaySession
      .mockResolvedValueOnce({ session: initial })
      .mockResolvedValueOnce({ session: pending });
    apiMock.sendRoleplayMessageStream
      .mockImplementationOnce(
        async (
          _projectId,
          _sessionId,
          _body,
          handlers,
          signal?: AbortSignal
        ) => {
          handlers.onChunk('途中の応答');
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => {
                handlers.onError({
                  error: '応答の受信を中断しました。',
                  code: 'aborted',
                  retryable: false,
                });
                resolve();
              },
              { once: true }
            );
          });
        }
      )
      .mockImplementationOnce(async (_projectId, _sessionId, _body, handlers) => {
        handlers.onDone(corrected);
      });

    render(
      <RoleplayWorkspace
        projectId="project-roleplay"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
      />
    );

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '間違った発言' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(screen.getByRole('button', { name: 'アーカイブ' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(input).toBeEnabled();
    expect(input).toHaveValue('間違った発言');

    const correctionButton = await screen.findByRole('button', { name: '訂正して送信' });
    fireEvent.change(input, { target: { value: '訂正した発言' } });
    fireEvent.click(correctionButton);

    await waitFor(() => expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalledTimes(2));
    expect(apiMock.sendRoleplayMessageStream.mock.calls[1][2]).toEqual({
      message: '訂正した発言',
      revision: pending.revision,
      replacePendingMessageId: 'message-pending',
    });
  });

  it('clears the restored text when the response wins the stop race', async () => {
    const initial = session();
    const completed = session({
      revision: 2,
      messages: [
        ...initial.messages,
        {
          messageId: 'message-user',
          role: 'user',
          content: '送信済みの発言',
          createdAt: '2026-07-18T00:01:00.000Z',
        },
        {
          messageId: 'message-character',
          role: 'character',
          content: '完了済みの応答',
          createdAt: '2026-07-18T00:02:00.000Z',
        },
      ],
    });
    apiMock.getRoleplaySession.mockResolvedValueOnce({ session: initial });
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              window.setTimeout(() => {
                handlers.onDone(completed);
                resolve();
              }, 0);
            },
            { once: true }
          );
        });
      }
    );

    render(
      <RoleplayWorkspace
        projectId="project-roleplay"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
      />
    );

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '送信済みの発言' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    await waitFor(() => expect(input).toHaveValue(''));
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '訂正して送信' })).toBeNull();
  });

  it('keeps ordinary response failures on the retry path instead of correction mode', async () => {
    const initial = session();
    const pending = session({
      revision: 1,
      messages: [
        ...initial.messages,
        {
          messageId: 'message-pending',
          role: 'user',
          content: '保存済みの発言',
          createdAt: '2026-07-18T00:01:00.000Z',
        },
      ],
    });
    apiMock.getRoleplaySession
      .mockResolvedValueOnce({ session: initial })
      .mockResolvedValueOnce({ session: pending });
    apiMock.sendRoleplayMessageStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers) => {
        handlers.onError({
          error: '通信に失敗しました。',
          code: 'network_error',
          retryable: true,
        });
      }
    );

    render(
      <RoleplayWorkspace
        projectId="project-roleplay"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
      />
    );

    const input = await screen.findByRole('textbox');
    fireEvent.change(input, { target: { value: '保存済みの発言' } });
    fireEvent.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('通信に失敗しました。')).toBeVisible();
    expect(await screen.findByRole('button', { name: '↻ もう一度応答をもらう' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '訂正して送信' })).toBeNull();
    expect(input).toHaveValue('');
  });

  it('returns an aborted regenerate to retry without entering correction mode', async () => {
    const pending = session({
      revision: 1,
      messages: [
        ...session().messages,
        {
          messageId: 'message-pending',
          role: 'user',
          content: '再試行する発言',
          createdAt: '2026-07-18T00:01:00.000Z',
        },
      ],
    });
    apiMock.getRoleplaySession.mockResolvedValue({ session: pending });
    apiMock.regenerateRoleplayStream.mockImplementationOnce(
      async (_projectId, _sessionId, _body, handlers, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            'abort',
            () => {
              handlers.onError({
                error: '応答の受信を中断しました。',
                code: 'aborted',
                retryable: false,
              });
              resolve();
            },
            { once: true }
          );
        });
      }
    );

    render(
      <RoleplayWorkspace
        projectId="project-roleplay"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
      />
    );

    fireEvent.click(
      await screen.findByRole('button', { name: '↻ もう一度応答をもらう' })
    );
    fireEvent.click(await screen.findByRole('button', { name: '停止' }));

    expect(
      await screen.findByText('応答を停止しました。「もう一度応答をもらう」から再試行できます。')
    ).toBeVisible();
    expect(await screen.findByRole('button', { name: '↻ もう一度応答をもらう' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '訂正して送信' })).toBeNull();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

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
    activePresetIds: {
      genre: 'modern-drama',
      style: 'natural-dialogue',
      pov: 'third-person-close',
      pacing: 'standard',
      density: 'balanced',
      intimacy: 'suggestive',
    },
    samplingConfig: {
      frequencyPenalty: 0,
      presencePenalty: 0,
    },
    projectType: 'roleplay',
  };
}

function character(): Character {
  return {
    characterId: 'character-a',
    name: 'アリス',
    role: 'protagonist',
    description: '穏やかな人物。',
  };
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
      {
        messageId: 'message-greeting',
        role: 'character',
        content: 'こんにちは。',
        createdAt: '2026-07-18T00:00:00.000Z',
      },
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
