import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import { ConfirmProvider } from '../../src/client/components/ConfirmDialog';
import { NotificationProvider } from '../../src/client/components/NotificationCenter';
import type { GenerationRecord, ReaderState } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    generate: vi.fn(),
    generateStream: vi.fn(),
    createExpression: vi.fn(),
    createGlobalExpression: vi.fn(),
    getReaderState: vi.fn(),
    getKnowledge: vi.fn(),
    updateState: vi.fn(),
    navigateDraft: vi.fn(),
    shutdown: vi.fn(),
    getNotificationSettings: vi.fn(),
  },
}));

const generate = vi.mocked(api.generate);
const generateStream = vi.mocked(api.generateStream);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);
const getNotificationSettings = vi.mocked(api.getNotificationSettings);

const ENABLED_SETTINGS = {
  soundEnabled: false,
  systemPopupEnabled: false,
  onlyWhenUnfocused: false,
  events: { firstOutput: true, completed: true, failed: true, settingsUpdated: true, reviewRequired: true },
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

describe('Reader generation notifications', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset();
    generateStream.mockReset();
    getReaderState.mockReset();
    getKnowledge.mockReset().mockResolvedValue([]);
    getNotificationSettings.mockReset().mockResolvedValue(ENABLED_SETTINGS);
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
});
