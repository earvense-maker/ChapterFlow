import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import type { GenerationRecord, ReaderState } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    generate: vi.fn(),
    generateStream: vi.fn(),
    getReaderState: vi.fn(),
    getKnowledge: vi.fn(),
    updateState: vi.fn(),
  },
}));

const generate = vi.mocked(api.generate);
const generateStream = vi.mocked(api.generateStream);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);

describe('Reader interactions', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset();
    generateStream.mockReset();
    getReaderState.mockReset();
    getKnowledge.mockReset();
    getKnowledge.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('submits an empty wish with Ctrl+Enter just like the generate button', async () => {
    getReaderState.mockResolvedValue(readerState());
    generate.mockResolvedValue(generationRecord());

    const { container } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    const textarea = container.querySelector('.wish-input textarea');
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    fireEvent.keyDown(textarea!, { key: 'Enter', ctrlKey: true });

    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith('proj-reader-interaction', {
        wish: '',
        mode: 'continue',
      })
    );
  });

  it('stops a streaming generation without showing an error', async () => {
    getReaderState.mockResolvedValue(readerState({ streamingEnabled: true }));
    let generationSignal: AbortSignal | undefined;
    generateStream.mockImplementation((_id, _body, onChunk, signal) => {
      generationSignal = signal;
      onChunk('途中までの生成文');
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const { findByRole, queryByText } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await waitFor(() => expect(getReaderState).toHaveBeenCalledTimes(1));
    fireEvent.click(await findByRole('button', { name: '生成' }));

    const stopButton = await findByRole('button', { name: '生成を停止' });
    fireEvent.click(stopButton);

    await waitFor(() => expect(queryByText('生成を停止しました')).not.toBeNull());
    expect(generationSignal?.aborted).toBe(true);
    expect(queryByText('途中までの生成文')).toBeNull();
    expect(await findByRole('button', { name: '生成' })).toBeEnabled();
  });
});

function readerState(overrides: Partial<ReaderState['project']> = {}): ReaderState {
  return {
    project: {
      schemaVersion: 1,
      projectId: 'proj-reader-interaction',
      title: 'Reader Interaction Test',
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
      outputLength: 3000,
      streamingEnabled: false,
      ...overrides,
      activePresetIds: {
        genre: 'modern-drama',
        style: 'natural-dialogue',
        pov: 'third-person-close',
        pacing: 'standard',
        density: 'balanced',
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
        status: 'fresh',
        generationId: null,
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

function generationRecord(): GenerationRecord {
  return {
    generationId: 'gen-reader-interaction',
    episodeId: 'episode-reader-interaction',
    sceneId: 'scene-reader-interaction',
    request: { wish: '', outputLength: 3000, previousContextText: '' },
    responseText: 'Generated text',
    usedPresets: {
      genre: 'modern-drama',
      style: 'natural-dialogue',
      pov: 'third-person-close',
      pacing: 'standard',
      density: 'balanced',
    },
    usedModel: { provider: 'openai', modelName: 'gpt-test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-04T12:01:00.000Z',
    parentGenerationId: null,
  };
}
