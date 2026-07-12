import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import type { GenerationRecord, ReaderState } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    generate: vi.fn(),
    getReaderState: vi.fn(),
    getKnowledge: vi.fn(),
    updateState: vi.fn(),
  },
}));

const generate = vi.mocked(api.generate);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);

describe('Reader interactions', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset();
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
});

function readerState(): ReaderState {
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
