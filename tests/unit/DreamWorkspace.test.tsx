import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DreamWorkspace from '../../src/client/components/DreamWorkspace';
import type {
  DreamMemorySettingsResponse,
  Project,
  RoleplaySessionSummary,
  RoleplaySessionView,
} from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  archiveRoleplaySession: vi.fn(),
  createRoleplaySession: vi.fn(),
  getDreamMemorySettings: vi.fn(),
  getProject: vi.fn(),
  getRoleplaySession: vi.fn(),
  listRoleplaySessions: vi.fn(),
  sendRoleplayMessageStream: vi.fn(),
  updateDreamMemorySettings: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

function project(): Project {
  return {
    schemaVersion: 1,
    projectId: 'project-dream',
    title: '夢の作品',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    activeModelProvider: 'gemini',
    activeModelName: 'gemini-3.6-flash',
    outputLength: 250,
    streamingEnabled: true,
    activePresetIds: {
      narration: 'third-close',
      rpResponseStyle: 'bracketed-action',
    },
    projectType: 'roleplay',
    experienceMode: 'dream',
    coreConcept: '雨の街を歩く夢。',
  };
}

function dreamSettings(overrides: Partial<DreamMemorySettingsResponse['settings']> = {}): DreamMemorySettingsResponse {
  return {
    settings: {
      schemaVersion: 1,
      recordingEnabled: true,
      disclosureAcknowledged: true,
      wipedAt: null,
      updatedAt: '2026-08-18T00:00:00.000Z',
      ...overrides,
    },
    eventCount: 0,
  };
}

function emptySession(): RoleplaySessionView {
  return {
    sessionId: 'rp-dream-1',
    projectId: 'project-dream',
    characterId: 'char-a',
    characterName: 'アリス',
    status: 'active',
    messages: [],
    revision: 1,
    model: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
    settingsChanged: false,
    sessionMode: 'dream',
  };
}

function dreamSessionWithProse(): RoleplaySessionView {
  return {
    ...emptySession(),
    revision: 3,
    messages: [
      {
        messageId: 'rm-user-1',
        role: 'user',
        content: 'しばらく眺める',
        inputKind: 'observe',
        createdAt: '2026-08-18T00:00:01.000Z',
      },
      {
        messageId: 'rm-char-1',
        role: 'character',
        content: '雨が石畳を濡らしていた。',
        createdAt: '2026-08-18T00:00:02.000Z',
      },
    ],
  };
}

function pendingUserSession(): RoleplaySessionView {
  return {
    ...emptySession(),
    revision: 2,
    messages: [
      {
        messageId: 'rm-user-pending',
        role: 'user',
        content: '  鍵を拾う。  ',
        inputKind: 'text',
        createdAt: '2026-08-18T00:00:01.000Z',
      },
    ],
  };
}

function summary(sessionId: string): RoleplaySessionSummary {
  return {
    sessionId,
    characterId: 'char-a',
    characterName: 'アリス',
    status: 'active',
    messageCount: 2,
    lastExcerpt: '雨が石畳を濡らしていた。',
    revision: 3,
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:02.000Z',
  };
}

interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: (session: RoleplaySessionView) => void;
  onError: (error: { error: string; code?: string; retryable?: boolean; revision?: number }) => void;
  onReplace?: (text: string) => void;
}

let capturedHandlers: StreamHandlers | null = null;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  for (const mock of Object.values(apiMock)) mock.mockReset();
  apiMock.getProject.mockResolvedValue(project());
  apiMock.getDreamMemorySettings.mockResolvedValue(dreamSettings());
  capturedHandlers = null;
  apiMock.sendRoleplayMessageStream.mockImplementation(
    async (_projectId: string, _sessionId: string, _body: unknown, handlers: StreamHandlers) => {
      capturedHandlers = handlers;
    }
  );
});

describe('DreamWorkspace', () => {
  it('resumes the latest active session and shows only the dream prose (AC5)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText('雨が石畳を濡らしていた。')).toBeInTheDocument();
    });
    // ユーザー入力（observe の正規化文字列）は本文に再表示されない
    expect(screen.queryByText('しばらく眺める')).not.toBeInTheDocument();
    // 発言者名・吹き出しラベルを出さない
    expect(screen.queryByText('アリス')).not.toBeInTheDocument();
  });

  it('creates a dream session and sends the first observe turn automatically (AC3/AC4)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [] });
    apiMock.createRoleplaySession.mockResolvedValue({ session: emptySession() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    await waitFor(() => {
      expect(apiMock.createRoleplaySession).toHaveBeenCalledWith('project-dream', {
        characterId: '',
        sessionMode: 'dream',
      });
    });
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalledWith(
      'project-dream',
      'rp-dream-1',
      expect.objectContaining({ inputKind: 'observe', revision: 1 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('sends observe on empty Enter and text on filled Enter', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalledWith(
      'project-dream',
      'rp-dream-1',
      expect.objectContaining({ inputKind: 'observe', revision: 3 }),
      expect.anything(),
      expect.anything()
    );

    // 生成完了を完了させてから次の入力を送る
    await waitFor(() => expect(capturedHandlers).not.toBeNull());
    capturedHandlers!.onDone(dreamSessionWithProse());
    const input2 = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input2, { target: { value: '鍵を拾う' } });
    fireEvent.keyDown(input2, { key: 'Enter' });
    // NOTE: text は inputKind を省略し（欠損 = 'text'）、message で送る（設計書 §5）。
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenLastCalledWith(
      'project-dream',
      'rp-dream-1',
      expect.objectContaining({ message: '鍵を拾う', revision: 3 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not send while IME composing', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: 'かぎ' } });
    // NOTE: KeyboardEvent の isComposing は KeyboardEventInit のプロパティ。IME 変換中の
    // Enter は送信にしない（設計書 §2）。
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(apiMock.sendRoleplayMessageStream).not.toHaveBeenCalled();
  });

  it('sends once when Enter confirms IME composition (変換確定の Enter で1回送信)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: '鍵を拾う' } });
    // 変換確定の Enter（isComposing=true）ではまだ送信しない
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(apiMock.sendRoleplayMessageStream).not.toHaveBeenCalled();
    // compositionend（変換確定）で一度だけ送信する
    fireEvent.compositionEnd(input, { data: '鍵を拾う' });
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalledTimes(1);
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalledWith(
      'project-dream',
      'rp-dream-1',
      expect.objectContaining({ message: '鍵を拾う', revision: 3 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not send when IME composition is cancelled (Escape) even after a composing Enter', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: 'かぎ' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    // 変換キャンセルでは compositionend の data が空になる
    fireEvent.compositionEnd(input, { data: '' });
    expect(apiMock.sendRoleplayMessageStream).not.toHaveBeenCalled();
  });

  it('restores the pending user message after an error and retries via replace (AC8/AC10)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession
      .mockResolvedValueOnce({ session: dreamSessionWithProse() })
      .mockResolvedValueOnce({ session: pendingUserSession() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: '鍵を拾う' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalled());
    await waitFor(() => expect(capturedHandlers).not.toBeNull());
    capturedHandlers!.onError({ error: '接続が切れました', code: 'network_error', retryable: true });

    // 再同期後、末尾が未応答 user なら訂正送信（replacePendingMessageId）で再試行できる
    const input2 = await screen.findByPlaceholderText(/Enter で明晰夢を続ける/);
    // 送信した言葉が入力欄へ戻り、同じ入力を追加せず訂正送信できる（AC8/設計書 §10）
    expect(input2).toHaveValue('鍵を拾う');
    fireEvent.keyDown(input2, { key: 'Enter' });
    expect(apiMock.sendRoleplayMessageStream).toHaveBeenLastCalledWith(
      'project-dream',
      'rp-dream-1',
      expect.objectContaining({
        message: '鍵を拾う',
        replacePendingMessageId: 'rm-user-pending',
        revision: 2,
      }),
      expect.anything(),
      expect.anything()
    );
  });

  it('does not restore a sent input when resync finds a committed character response', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession
      .mockResolvedValueOnce({ session: dreamSessionWithProse() })
      .mockResolvedValueOnce({ session: { ...dreamSessionWithProse(), revision: 5 } });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: '鍵を拾う' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(capturedHandlers).not.toBeNull());

    await act(async () => {
      await capturedHandlers!.onError({
        error: '接続が切れました',
        code: 'network_error',
        retryable: true,
      });
    });

    const recovered = await screen.findByRole('textbox');
    expect(recovered).toHaveValue('');
  });

  it('wakes via /wake + Enter and archives the session (AC9)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });
    apiMock.archiveRoleplaySession.mockResolvedValue({ session: { ...dreamSessionWithProse(), status: 'archived' } });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: '/wake' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(apiMock.archiveRoleplaySession).toHaveBeenCalledWith('project-dream', 'rp-dream-1', {
        revision: 3,
      });
    });
    await waitFor(() => expect(screen.getByText('目が覚めました。')).toBeInTheDocument());
  });

  it('requires disclosure acknowledgement before starting the first dream (AC: 初回明示)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [] });
    apiMock.getDreamMemorySettings.mockResolvedValue(
      dreamSettings({ disclosureAcknowledged: false })
    );
    apiMock.updateDreamMemorySettings.mockResolvedValue(dreamSettings());
    apiMock.createRoleplaySession.mockResolvedValue({ session: emptySession() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const acknowledge = await screen.findByRole('button', { name: '了解しました' });
    expect(apiMock.createRoleplaySession).not.toHaveBeenCalled();

    fireEvent.click(acknowledge);
    await waitFor(() => {
      expect(apiMock.updateDreamMemorySettings).toHaveBeenCalledWith({
        disclosureAcknowledged: true,
      });
    });
    await waitFor(() => {
      expect(apiMock.createRoleplaySession).toHaveBeenCalled();
    });
  });

  it('blocks sending while the disclosure is not acknowledged, even for an existing session', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });
    apiMock.getDreamMemorySettings.mockResolvedValue(
      dreamSettings({ disclosureAcknowledged: false })
    );

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    // 既存の夢は閲覧できる
    await waitFor(() => {
      expect(screen.getByText('雨が石畳を濡らしていた。')).toBeInTheDocument();
    });
    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(apiMock.sendRoleplayMessageStream).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText(/説明を確認してから始めてください/)).toBeInTheDocument();
    });
  });

  it('hides the wake button during generation (Escape stops instead)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiMock.sendRoleplayMessageStream).toHaveBeenCalled());

    // 生成中は「目覚める」が無効になる
    expect(screen.getByRole('button', { name: '目覚める' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '停止 (Esc)' })).toBeInTheDocument();
  });

  it('shows the lucid dream name and the observe guide in the input placeholder (改修設計書 §12 / §16)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    // 空 Enter の案内が「世界の出方を観察する」に変わる（旧「しばらく眺める」は出さない）
    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    expect(input.getAttribute('placeholder')).toContain('世界の出方を観察する');
    expect(input.getAttribute('placeholder')).not.toContain('しばらく眺める');
  });

  it('shows 明晰夢 in the ended screen and restarts a lucid dream (改修設計書 §12)', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [summary('rp-dream-1')] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: dreamSessionWithProse() });
    apiMock.archiveRoleplaySession.mockResolvedValue({ session: { ...dreamSessionWithProse(), status: 'archived' } });

    render(<DreamWorkspace projectId="project-dream" onBack={() => {}} onOpenWorkSettings={() => {}} onOpenTechSettings={() => {}} />);

    const input = await screen.findByPlaceholderText(/浮かんだ言葉を書いて Enter/);
    fireEvent.change(input, { target: { value: '/wake' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByText('目が覚めました。')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'もう一度明晰夢を見る' })).toBeInTheDocument();
  });
});
