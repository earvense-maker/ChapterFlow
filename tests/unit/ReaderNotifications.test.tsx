import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import { ConfirmProvider } from '../../src/client/components/ConfirmDialog';
import { NotificationProvider } from '../../src/client/components/NotificationCenter';
import type { GenerationRecord, PromptBudgetReport, ReaderState } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    // NOTE: 視点セレクト用の人物一覧。取得できなくても「自動」は選べる想定なので空で足りる。
    getCharacters: vi.fn().mockResolvedValue([]),
    generate: vi.fn(),
    generateStream: vi.fn(),
    createExpression: vi.fn(),
    createGlobalExpression: vi.fn(),
    getReaderState: vi.fn(),
    getKnowledge: vi.fn(),
    updateState: vi.fn(),
    navigateDraft: vi.fn(),
    navigateScene: vi.fn(),
    shutdown: vi.fn(),
    getNotificationSettings: vi.fn(),
    getExpressions: vi.fn().mockResolvedValue({ ngExpressions: [] }),
    getGlobalExpressions: vi.fn().mockResolvedValue({ ngExpressions: [] }),
    rewriteNgOccurrence: vi.fn(),
    getNgAutoRewriteSettings: vi.fn().mockResolvedValue({ enabled: false, maxRewritesPerGeneration: 3 }),
    updateNgAutoRewriteSettings: vi.fn(),
  },
}));

const generate = vi.mocked(api.generate);
const generateStream = vi.mocked(api.generateStream);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);
const getNotificationSettings = vi.mocked(api.getNotificationSettings);
const navigateDraft = vi.mocked(api.navigateDraft);

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

function renderReader() {
  return render(
    <ConfirmProvider>
      <NotificationProvider>
        <Reader
          projectId="proj-reader-notifications"
          onBack={vi.fn()}
          onOpenWorkSettings={vi.fn()}
          onOpenTechSettings={vi.fn()}
          onOpenMemories={vi.fn()}
        />
      </NotificationProvider>
    </ConfirmProvider>
  );
}

function readerState(overrides: Partial<ReaderState['project']> = {}): ReaderState {
  return {
    project: {
      schemaVersion: 1,
      projectId: 'proj-reader-notifications',
      title: 'Reader Notifications Test',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
      outputLength: 3000,
      streamingEnabled: false,
      ...overrides,
      activePresetIds: { narration: 'third-close' },
    },
    state: {
      lastOpenedAt: '2026-07-22T00:00:00.000Z',
      currentEpisodeId: null,
      currentSceneId: null,
      selectedDraftGenerationId: null,
      lastAcceptedGenerationId: null,
      pendingMemoryCandidateIds: [],
      storyStateRefresh: { status: 'fresh', generationId: null, updatedAt: '2026-07-22T00:00:00.000Z' },
      uiState: { readingPosition: 0, fontSize: 18 },
    },
    currentEpisode: null,
    currentScene: null,
    currentGeneration: null,
    memories: [],
    knowledgeFiles: [],
    navigation: { currentSceneOrder: null, totalScenes: 0, hasPreviousScene: false, hasNextScene: false },
    contextUsage: null,
    contextSummaryExcerpt: '',
  };
}

function generationRecord(): GenerationRecord {
  return {
    generationId: 'gen-reader-notifications',
    episodeId: 'episode-reader-notifications',
    sceneId: 'scene-reader-notifications',
    request: { wish: '', outputLength: 3000, previousContextText: '' },
    responseText: '生成された本文',
    usedPresets: { narration: 'third-close' },
    usedModel: { provider: 'openai', modelName: 'gpt-test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-22T00:01:00.000Z',
    parentGenerationId: null,
  };
}

function budgetReport(entries: PromptBudgetReport['entries']): PromptBudgetReport {
  return { maxChars: 80_000, assembledChars: 40_000, entries };
}

function readerStateWithGeneration(record: GenerationRecord): ReaderState {
  return {
    ...readerState(),
    currentGeneration: record,
    navigation: {
      currentSceneOrder: 1,
      totalScenes: 1,
      hasPreviousScene: false,
      hasNextScene: false,
    },
  };
}

function readerStateWithDrafts(record: GenerationRecord, draftIds: string[]): ReaderState {
  return {
    ...readerState(),
    currentGeneration: record,
    currentScene: {
      sceneId: 'scene-drafts',
      episodeId: 'episode-drafts',
      order: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      acceptedGenerationId: null,
      draftGenerationIds: draftIds,
    },
    navigation: {
      currentSceneOrder: 1,
      totalScenes: 1,
      hasPreviousScene: false,
      hasNextScene: false,
    },
  };
}

describe('Reader generation notifications', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset();
    generateStream.mockReset();
    getReaderState.mockReset();
    getKnowledge.mockReset().mockResolvedValue([]);
    getNotificationSettings.mockReset().mockResolvedValue(ENABLED_SETTINGS);
    navigateDraft.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires a completed notification (not firstOutput) after a non-streaming generation', async () => {
    getReaderState.mockResolvedValue(readerState({ streamingEnabled: false }));
    generate.mockResolvedValue(generationRecord());

    const { findByRole, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    fireEvent.click(await findByRole('button', { name: '生成' }));

    await waitFor(() => expect(queryByText('生成が完了しました')).not.toBeNull());
    expect(queryByText('本文の生成が始まりました')).toBeNull();
  });

  it('fires firstOutput exactly once for a streaming generation with multiple chunks', async () => {
    getReaderState.mockResolvedValue(readerState({ streamingEnabled: true }));
    generateStream.mockImplementation(async (_id, _body, onChunk) => {
      onChunk('最初のかけら');
      onChunk('');
      onChunk('つづきのかけら');
      return generationRecord();
    });

    const { findByRole, queryAllByText, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    fireEvent.click(await findByRole('button', { name: '生成' }));

    await waitFor(() => expect(queryByText('生成が完了しました')).not.toBeNull());
    expect(queryAllByText('本文の生成が始まりました')).toHaveLength(1);
  });

  it('fires a failed notification on a real generation error', async () => {
    getReaderState.mockResolvedValue(readerState({ streamingEnabled: false }));
    generate.mockRejectedValue(new Error('生成プロバイダーがエラーを返しました'));

    const { findByRole, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    fireEvent.click(await findByRole('button', { name: '生成' }));

    await waitFor(() => expect(queryByText('生成に失敗しました')).not.toBeNull());
  });

  it('does not fire a failed notification when the user explicitly stops generation', async () => {
    getReaderState.mockResolvedValue(readerState({ streamingEnabled: true }));
    let signalRef: AbortSignal | undefined;
    generateStream.mockImplementation((_id, _body, onChunk, signal) => {
      signalRef = signal;
      onChunk('途中までの生成文');
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const { findByRole, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    fireEvent.click(await findByRole('button', { name: '生成' }));

    const stopButton = await findByRole('button', { name: '生成を停止' });
    fireEvent.click(stopButton);

    await waitFor(() => expect(signalRef?.aborted).toBe(true));
    await waitFor(() => expect(queryByText('生成を停止しました')).not.toBeNull());
    expect(queryByText('生成に失敗しました')).toBeNull();
  });

  // NOTE: AC13。保存済み結果の再読込で、予算調整の report があれば通知し、
  // ラベルは日本語で生の sectionId は出さない。
  it('notifies about budget truncation when the reloaded generation has adjusted entries (AC13)', async () => {
    getReaderState.mockResolvedValue(
      readerStateWithGeneration({
        ...generationRecord(),
        promptBudgetReport: budgetReport([
          {
            sectionId: 'user.recentContext',
            originalChars: 12_000,
            includedChars: 8_000,
            action: 'truncated',
          },
        ]),
      })
    );

    const { findByText, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());

    await waitFor(() =>
      expect(queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(await findByText('直近の本文の一部を省略しました')).not.toBeNull();
    // 利用者向けラベルに生の sectionId が出ない（AC13 / 要件7）。
    expect(queryByText('user.recentContext')).toBeNull();
  });

  it('notifies about budget selection right after a generation completes (generate path)', async () => {
    // 初回ロードは生成なし。生成完了後の再読込でサーバーが新しい生成記録を返す想定。
    getReaderState
      .mockResolvedValueOnce(readerState({ streamingEnabled: false }))
      .mockResolvedValue(
        readerStateWithGeneration({
          ...generationRecord(),
          promptBudgetReport: budgetReport([
            {
              sectionId: 'user.knowledgeChunks',
              originalChars: 18,
              includedChars: 9,
              action: 'selected',
            },
          ]),
        })
      );
    generate.mockResolvedValue({
      ...generationRecord(),
      promptBudgetReport: budgetReport([
        {
          sectionId: 'user.knowledgeChunks',
          originalChars: 18,
          includedChars: 9,
          action: 'selected',
        },
      ]),
    });

    const { findByRole, findByText, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    fireEvent.click(await findByRole('button', { name: '生成' }));

    await waitFor(() =>
      expect(queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(await findByText('参考資料の一部のみを使用しました')).not.toBeNull();
  });

  it('does not notify about budget when every entry is full (AC13)', async () => {
    getReaderState.mockResolvedValue(
      readerStateWithGeneration({
        ...generationRecord(),
        promptBudgetReport: budgetReport([
          {
            sectionId: 'user.knowledge',
            originalChars: 1_000,
            includedChars: 1_000,
            action: 'full',
          },
          {
            sectionId: 'user.recentContext',
            originalChars: 8_000,
            includedChars: 8_000,
            action: 'full',
          },
        ]),
      })
    );

    const { queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());

    // 通知が発生しないことを少し待って確認する。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByText('プロンプト予算のため一部を調整しました')).toBeNull();
  });

  it('keeps working without a budget report in old records (AC13 / 要件6)', async () => {
    // generationRecord() は promptBudgetReport を持たない旧形式。
    getReaderState.mockResolvedValue(readerStateWithGeneration(generationRecord()));

    const { findByRole, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByText('プロンプト予算のため一部を調整しました')).toBeNull();
    // 生成ボタンなど Reader 自体は正常に動く。
    expect(await findByRole('button', { name: '生成' })).not.toBeNull();
  });

  // NOTE: AC13。案の移動（前の案/次の案）でも表示中の生成記録が変わるため、
  // report を更新して通知する。
  it('notifies about budget adjustment when navigating to an adjusted draft', async () => {
    getReaderState.mockResolvedValue(
      readerStateWithDrafts(generationRecord(), ['gen-reader-notifications', 'gen-draft-next'])
    );
    navigateDraft.mockResolvedValue({
      ...generationRecord(),
      generationId: 'gen-draft-next',
      promptBudgetReport: budgetReport([
        {
          sectionId: 'user.recentContext',
          originalChars: 12_000,
          includedChars: 8_000,
          action: 'truncated',
        },
      ]),
    });

    const { findByRole, findByText, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    // 初期案（report なし）では通知が出ていない。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryByText('プロンプト予算のため一部を調整しました')).toBeNull();

    fireEvent.click(await findByRole('button', { name: '次の案' }));

    await waitFor(() =>
      expect(queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );
    expect(await findByText('直近の本文の一部を省略しました')).not.toBeNull();
  });

  it('clears the previous draft budget notice when navigating to a full draft', async () => {
    getReaderState.mockResolvedValue(
      readerStateWithDrafts(
        {
          ...generationRecord(),
          promptBudgetReport: budgetReport([
            {
              sectionId: 'user.recentContext',
              originalChars: 12_000,
              includedChars: 8_000,
              action: 'truncated',
            },
          ]),
        },
        ['gen-reader-notifications', 'gen-draft-next']
      )
    );
    // 移動先の案は全項目 full（report なし相当）。
    navigateDraft.mockResolvedValue({
      ...generationRecord(),
      generationId: 'gen-draft-next',
    });

    const { findByRole, queryAllByText, queryByText } = renderReader();
    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getNotificationSettings).toHaveBeenCalled());
    await waitFor(() =>
      expect(queryByText('プロンプト予算のため一部を調整しました')).not.toBeNull()
    );

    fireEvent.click(await findByRole('button', { name: '次の案' }));
    await waitFor(() => expect(navigateDraft).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 移動先に調整がないため新しい通知は出ない（直前案の通知文は破棄される）。
    expect(queryAllByText('プロンプト予算のため一部を調整しました')).toHaveLength(1);
  });
});
