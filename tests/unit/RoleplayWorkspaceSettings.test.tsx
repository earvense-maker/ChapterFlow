import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

describe('RoleplayWorkspace session settings', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(apiMock)) mock.mockReset();
    apiMock.getProject.mockResolvedValue(project());
    apiMock.getCharacters.mockResolvedValue([character()]);
    apiMock.getNotificationSettings.mockResolvedValue(null);
  });

  it('sends the user persona entered in the new conversation modal', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [] });
    apiMock.createRoleplaySession.mockResolvedValue({ session: session() });

    renderWorkspace();

    const dialog = await screen.findByRole('dialog', { name: '新しい会話を始める' });
    fireEvent.click(within(dialog).getByText('あなたの情報（任意）'));
    const name = within(dialog).getByLabelText('名前');
    const relationship = within(dialog).getByLabelText('キャラクターとの関係');
    const preferredAddress = within(dialog).getByLabelText('呼ばれ方');
    const knownFacts = within(dialog).getByLabelText('キャラクターが知っていること');
    expect(name).toHaveAttribute('maxlength', '80');
    expect(relationship).toHaveAttribute('maxlength', '200');
    expect(preferredAddress).toHaveAttribute('maxlength', '80');
    expect(knownFacts).toHaveAttribute('maxlength', '1000');

    fireEvent.change(name, { target: { value: 'ユウ' } });
    fireEvent.change(relationship, { target: { value: '幼なじみ' } });
    fireEvent.change(preferredAddress, { target: { value: 'ユウくん' } });
    fireEvent.change(knownFacts, { target: { value: '雨の日が好き。' } });
    fireEvent.change(within(dialog).getByLabelText('あなたの行動の補完'), {
      target: { value: 'collaborative' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '会話を始める' }));

    await waitFor(() => {
      expect(apiMock.createRoleplaySession).toHaveBeenCalledWith('project-roleplay', {
        characterId: 'character-a',
        scenario: undefined,
        userPersona: {
          name: 'ユウ',
          relationship: '幼なじみ',
          preferredAddress: 'ユウくん',
          knownFacts: '雨の日が好き。',
          actionPolicy: 'collaborative',
        },
      });
    });
  });

  it('sends the conservative action policy even when persona text is blank', async () => {
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [] });
    apiMock.createRoleplaySession.mockResolvedValue({ session: session() });

    renderWorkspace();
    const dialog = await screen.findByRole('dialog', { name: '新しい会話を始める' });
    fireEvent.click(within(dialog).getByRole('button', { name: '会話を始める' }));

    await waitFor(() => {
      expect(apiMock.createRoleplaySession).toHaveBeenCalledWith('project-roleplay', {
        characterId: 'character-a',
        scenario: undefined,
        userPersona: {
          name: undefined,
          relationship: undefined,
          preferredAddress: undefined,
          knownFacts: undefined,
          actionPolicy: 'conservative',
        },
      });
    });
  });

  it('shows captured settings and restarts a changed session with its scenario and persona', async () => {
    const current = session({ settingsChanged: true });
    apiMock.listRoleplaySessions.mockResolvedValue({ sessions: [sessionSummary()] });
    apiMock.getRoleplaySession.mockResolvedValue({ session: current });
    let resolveCreate!: (value: { session: RoleplaySessionView }) => void;
    apiMock.createRoleplaySession.mockImplementation(
      () => new Promise((resolve) => { resolveCreate = resolve; })
    );

    renderWorkspace();

    expect(await screen.findByText('設定変更あり')).toBeVisible();
    expect(screen.getByText('応答の形: 台詞＋動作')).toBeVisible();
    expect(screen.getByText('距離の詰め方: 慎重')).toBeVisible();
    expect(screen.getByText('会話の空気: 温かい・遊び心')).toBeVisible();

    fireEvent.click(screen.getByText('使用中の設定と関係性'));
    expect(screen.getByText('語り口').closest('li')).toHaveTextContent('三人称・近接');
    expect(screen.getByText('幼なじみ')).toBeVisible();
    expect(screen.getByText('秘密を守る')).toBeVisible();
    expect(screen.getByText('先週の口論')).toBeVisible();
    expect(screen.getByText('信頼')).toBeVisible();
    expect(screen.getByText('72')).toBeVisible();

    const restart = screen.getByRole('button', { name: '現在の設定で新しい会話' });
    fireEvent.click(restart);

    await waitFor(() => {
      expect(apiMock.createRoleplaySession).toHaveBeenCalledWith('project-roleplay', {
        characterId: 'character-a',
        scenario: '放課後の教室',
        userPersona: current.userPersona,
      });
    });
    expect(screen.getByRole('button', { name: '新しい会話を作成中…' })).toBeDisabled();

    resolveCreate({ session: session({ sessionId: 'session-new', settingsChanged: false }) });
    await waitFor(() => expect(apiMock.listRoleplaySessions).toHaveBeenCalledTimes(2));
  });
});

function renderWorkspace() {
  return render(
    <RoleplayWorkspace
      projectId="project-roleplay"
      onBack={vi.fn()}
      onOpenWorkSettings={vi.fn()}
      onOpenTechSettings={vi.fn()}
    />
  );
}

function project(): Project {
  return {
    schemaVersion: 1,
    projectId: 'project-roleplay',
    title: 'ロールプレイ作品',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    activeModelProvider: 'gemini',
    activeModelName: 'gemini-test',
    outputLength: 1000,
    streamingEnabled: true,
    activePresetIds: {
      narration: 'third-close',
      rpResponseStyle: 'bracketed-action',
    },
    samplingConfig: { frequencyPenalty: 0, presencePenalty: 0 },
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
    scenario: '放課後の教室',
    status: 'active',
    messages: [],
    userPersona: {
      name: 'ユウ',
      relationship: '幼なじみ',
      preferredAddress: 'ユウくん',
      knownFacts: '雨の日が好き。',
      actionPolicy: 'conservative',
    },
    appliedSettings: {
      capturedAt: '2026-07-28T00:00:00.000Z',
      presets: [
        { category: 'narration', categoryLabel: '語り口', itemLabels: ['三人称・近接'] },
        { category: 'rpResponseStyle', categoryLabel: '応答の形', itemLabels: ['台詞＋動作'] },
        { category: 'rpDistance', categoryLabel: '距離の詰め方', itemLabels: ['慎重'] },
        { category: 'rpMood', categoryLabel: '会話の空気', itemLabels: ['温かい', '遊び心'] },
      ],
    },
    relationshipState: {
      trust: 72,
      intimacy: 48,
      tension: 15,
      currentAddress: 'ユウくん',
      promises: ['秘密を守る'],
      unresolvedTopics: ['先週の口論'],
      updatedAt: '2026-07-28T00:00:00.000Z',
    },
    settingsChanged: false,
    model: { provider: 'gemini', modelName: 'gemini-test' },
    revision: 0,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function sessionSummary(): RoleplaySessionSummary {
  return {
    sessionId: 'session-a',
    characterId: 'character-a',
    characterName: 'アリス',
    scenario: '放課後の教室',
    status: 'active',
    messageCount: 0,
    lastExcerpt: '',
    revision: 0,
    settingsChanged: true,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };
}
