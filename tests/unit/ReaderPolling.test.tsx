import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import type { ReaderState } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    getReaderState: vi.fn(),
    getKnowledge: vi.fn(),
    updateState: vi.fn(),
  },
}));

const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);

describe('Reader story state polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getReaderState.mockReset();
    getKnowledge.mockReset();
    getKnowledge.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps polling pending story state refresh without overlapping requests', async () => {
    const pendingState = readerState('pending');
    const freshState = readerState('fresh');
    const slowReload = deferred<ReaderState>();

    getReaderState
      .mockResolvedValueOnce(pendingState)
      .mockReturnValueOnce(slowReload.promise)
      .mockResolvedValueOnce(freshState);

    render(
      <Reader
        projectId="proj-reader-poll"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('続きに反映する情報を整理しています')).toBeInTheDocument();
    expect(
      screen.getByText('採用した場面から人物の状況や伏線を読み取り、次の場面に反映する準備をしています。')
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(getReaderState).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(getReaderState).toHaveBeenCalledTimes(2);

    await act(async () => {
      slowReload.resolve(pendingState);
      await slowReload.promise;
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(getReaderState).toHaveBeenCalledTimes(3);

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText('続きに反映する情報を整理しています')).not.toBeInTheDocument();
  });
});

function readerState(status: 'pending' | 'fresh'): ReaderState {
  return {
    project: {
      schemaVersion: 1,
      projectId: 'proj-reader-poll',
      title: 'Reader Poll Test',
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {
        narration: 'third-close',
      },
    },
    state: {
      lastOpenedAt: '2026-07-04T12:00:00.000Z',
      currentEpisodeId: null,
      currentSceneId: null,
      selectedDraftGenerationId: null,
      lastAcceptedGenerationId: null,
      pendingMemoryCandidateIds: [],
      storyStateRefresh: {
        status,
        generationId: 'gen-reader-poll',
        updatedAt: '2026-07-04T12:00:00.000Z',
      },
      uiState: {
        readingPosition: 0,
        fontSize: 18,
      },
    },
    currentEpisode: null,
    currentScene: null,
    currentGeneration: null,
    memories: [],
    knowledgeFiles: [],
    navigation: {
      currentSceneOrder: null,
      totalScenes: 0,
      hasPreviousScene: false,
      hasNextScene: false,
    },
    contextUsage: null,
    contextSummaryExcerpt: '',
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
