import { fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Reader from '../../src/client/components/Reader';
import { api } from '../../src/client/clientApi';
import { ConfirmProvider } from '../../src/client/components/ConfirmDialog';
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
    getNotificationSettings: vi.fn().mockResolvedValue(null),
  },
}));

const generate = vi.mocked(api.generate);
const generateStream = vi.mocked(api.generateStream);
const createExpression = vi.mocked(api.createExpression);
const createGlobalExpression = vi.mocked(api.createGlobalExpression);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);
const navigateDraft = vi.mocked(api.navigateDraft);
const shutdown = vi.mocked(api.shutdown);

describe('Reader interactions', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset();
    generateStream.mockReset();
    createExpression.mockReset();
    createGlobalExpression.mockReset().mockResolvedValue({
      id: 'ngx-common',
      text: 'Draft scene text',
      source: 'selection',
      status: 'active',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    });
    getReaderState.mockReset();
    getKnowledge.mockReset();
    navigateDraft.mockReset();
    shutdown.mockReset().mockResolvedValue({ ok: true });
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

  it('blocks every generation trigger while story-state extraction is within the pending grace period', async () => {
    const state = readerState();
    state.state.storyStateRefresh = {
      status: 'pending',
      generationId: 'gen-pending',
      updatedAt: new Date().toISOString(),
    };
    getReaderState.mockResolvedValue(state);

    const { container, findByRole } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await findByRole('button', { name: '生成' });
    const generateButton = await findByRole('button', { name: '生成' });
    expect(generateButton).toBeDisabled();
    const textarea = container.querySelector('.wish-input textarea')!;
    fireEvent.submit(textarea.closest('form')!);
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
  });

  it('asks before a delayed pending generation and preserves the request when cancelled', async () => {
    const state = readerState();
    state.state.storyStateRefresh = {
      status: 'pending',
      generationId: 'gen-delayed',
      updatedAt: new Date(Date.now() - 61_000).toISOString(),
    };
    getReaderState.mockResolvedValue(state);

    const { container, findByRole } = render(
      <ConfirmProvider>
        <Reader
          projectId="proj-reader-interaction"
          onBack={vi.fn()}
          onOpenWorkSettings={vi.fn()}
          onOpenTechSettings={vi.fn()}
          onOpenMemories={vi.fn()}
        />
      </ConfirmProvider>
    );

    const textarea = container.querySelector('.wish-input textarea')!;
    fireEvent.change(textarea, { target: { value: '確認付きで生成' } });
    fireEvent.click(await findByRole('button', { name: '生成' }));
    expect(await findByRole('dialog')).toBeVisible();
    const cancel = await findByRole('button', { name: '戻る' });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);

    await Promise.resolve();
    expect(generate).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('確認付きで生成');
  });

  it('continues exactly once after confirming a stale story-state warning', async () => {
    const state = readerState();
    state.state.storyStateRefresh = {
      status: 'stale',
      generationId: 'gen-stale',
      updatedAt: new Date().toISOString(),
    };
    getReaderState.mockResolvedValue(state);
    generate.mockResolvedValue(generationRecord());

    const { findByRole } = render(
      <ConfirmProvider>
        <Reader
          projectId="proj-reader-interaction"
          onBack={vi.fn()}
          onOpenWorkSettings={vi.fn()}
          onOpenTechSettings={vi.fn()}
          onOpenMemories={vi.fn()}
        />
      </ConfirmProvider>
    );

    fireEvent.click(await findByRole('button', { name: '生成' }));
    fireEvent.click(await findByRole('button', { name: 'このまま生成' }));

    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith('proj-reader-interaction', {
        wish: '',
        mode: 'continue',
      })
    );
    expect(generate).toHaveBeenCalledTimes(1);
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

  it('registers a selected reader phrase through the common NG API only', async () => {
    getReaderState.mockResolvedValue(readerStateWithDraft());
    const { findByText, findByRole } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    const article = await findByText('Draft scene text');
    const range = document.createRange();
    range.selectNodeContents(article);
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: () => new DOMRect(10, 10, 80, 16),
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(article);

    fireEvent.click(await findByRole('button', { name: '共通NGに登録' }));
    await waitFor(() => {
      expect(createGlobalExpression).toHaveBeenCalledWith({
        text: 'Draft scene text',
        source: 'selection',
      });
    });
    expect(createExpression).not.toHaveBeenCalled();
  });

  it('shows draft and scene metadata before navigation and uses the simplified options menu', async () => {
    getReaderState.mockResolvedValue(readerStateWithDraft());

    const { container, findByRole, findByText, getByRole, getByText, queryByText } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await findByText('場面 2/4');
    const sceneNav = container.querySelector('.scene-nav');
    expect(sceneNav).not.toBeNull();
    const navText = sceneNav!.textContent ?? '';
    expect(navText.indexOf('下案 2/3')).toBeLessThan(navText.indexOf('場面 2/4'));
    expect(navText.indexOf('場面 2/4')).toBeLessThan(navText.indexOf('前'));
    expect(navText.indexOf('前')).toBeLessThan(navText.indexOf('次'));
    expect(container.querySelector('.reader-subheader')).toBeNull();

    const optionsButton = await findByRole('button', { name: 'オプションを開く' });
    expect(optionsButton.querySelector('svg')).not.toBeNull();
    fireEvent.click(optionsButton);

    expect(getByRole('button', { name: '記憶' })).toBeVisible();
    expect(getByRole('button', { name: '作品設定' })).toBeVisible();
    expect(getByRole('button', { name: '生成設定' })).toBeVisible();
    expect(getByText('テーマ')).toBeVisible();
    expect(getByRole('radio', { name: 'ライト' }).querySelector('svg')).not.toBeNull();
    expect(getByRole('radio', { name: 'ダーク' }).querySelector('svg')).not.toBeNull();
    expect(queryByText(/🧠|📖|⚙/)).toBeNull();
  });

  it('moves to both the previous and next draft without changing draft status', async () => {
    getReaderState.mockResolvedValue(readerStateWithDraft());
    navigateDraft.mockResolvedValue({
      ...generationRecord(),
      generationId: 'gen-c',
      responseText: 'Next draft text',
      status: 'superseded',
    });

    const { findByRole, findByText } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    await findByText('Draft scene text');
    expect(await findByRole('button', { name: '前の案' })).toBeEnabled();
    const nextButton = await findByRole('button', { name: '次の案' });
    expect(nextButton).toBeEnabled();

    fireEvent.click(nextButton);

    await waitFor(() =>
      expect(navigateDraft).toHaveBeenCalledWith('proj-reader-interaction', 'next')
    );
    expect(await findByText('Next draft text')).toBeInTheDocument();
    expect(await findByRole('button', { name: '前の案' })).toBeEnabled();
    expect(await findByRole('button', { name: '次の案' })).toBeDisabled();
  });

  it('shuts down immediately without opening a confirmation dialog', async () => {
    getReaderState.mockResolvedValue(readerState());

    const { findByRole, queryByRole } = render(
      <Reader
        projectId="proj-reader-interaction"
        onBack={vi.fn()}
        onOpenWorkSettings={vi.fn()}
        onOpenTechSettings={vi.fn()}
        onOpenMemories={vi.fn()}
      />
    );

    fireEvent.click(await findByRole('button', { name: 'オプションを開く' }));
    fireEvent.click(await findByRole('button', { name: 'サーバー終了' }));

    await waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1));
    expect(queryByRole('dialog')).toBeNull();
  });

  it('does not let a slow load from the previous project overwrite the current project', async () => {
    const firstLoad = deferred<ReaderState>();
    const secondState = readerStateWithDraft();
    secondState.project = {
      ...secondState.project,
      projectId: 'proj-reader-second',
      title: 'Second project',
    };
    secondState.currentGeneration = {
      ...secondState.currentGeneration!,
      responseText: 'Second project text',
    };
    getReaderState.mockImplementation((projectId) =>
      projectId === 'proj-reader-first' ? firstLoad.promise : Promise.resolve(secondState)
    );

    const props = {
      onBack: vi.fn(),
      onOpenWorkSettings: vi.fn(),
      onOpenTechSettings: vi.fn(),
      onOpenMemories: vi.fn(),
    };
    const { findByText, queryByText, rerender } = render(
      <Reader projectId="proj-reader-first" {...props} />
    );
    await waitFor(() => expect(getReaderState).toHaveBeenCalledWith('proj-reader-first'));

    rerender(<Reader projectId="proj-reader-second" {...props} />);
    await findByText('Second project text');

    firstLoad.resolve({
      ...readerStateWithDraft(),
      currentGeneration: {
        ...readerStateWithDraft().currentGeneration!,
        responseText: 'Stale first project text',
      },
    });
    await firstLoad.promise;
    await Promise.resolve();

    expect(queryByText('Stale first project text')).toBeNull();
    expect(queryByText('Second project text')).not.toBeNull();
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
      narration: 'third-close',
    },
    usedModel: { provider: 'openai', modelName: 'gpt-test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-04T12:01:00.000Z',
    parentGenerationId: null,
  };
}

function readerStateWithDraft(): ReaderState {
  const base = readerState();
  const generation: GenerationRecord = {
    ...generationRecord(),
    generationId: 'gen-b',
    responseText: 'Draft scene text',
  };

  return {
    ...base,
    state: {
      ...base.state,
      currentEpisodeId: 'episode-reader-interaction',
      currentSceneId: 'scene-reader-interaction',
      selectedDraftGenerationId: 'gen-b',
    },
    currentEpisode: {
      episodeId: 'episode-reader-interaction',
      title: 'Episode',
      order: 1,
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      scenes: [
        {
          sceneId: 'scene-reader-interaction',
          episodeId: 'episode-reader-interaction',
          order: 2,
          createdAt: '2026-07-04T12:00:00.000Z',
          updatedAt: '2026-07-04T12:00:00.000Z',
          acceptedGenerationId: null,
          draftGenerationIds: ['gen-a', 'gen-b', 'gen-c'],
        },
      ],
    },
    currentScene: {
      sceneId: 'scene-reader-interaction',
      episodeId: 'episode-reader-interaction',
      order: 2,
      createdAt: '2026-07-04T12:00:00.000Z',
      updatedAt: '2026-07-04T12:00:00.000Z',
      acceptedGenerationId: null,
      draftGenerationIds: ['gen-a', 'gen-b', 'gen-c'],
    },
    currentGeneration: generation,
    navigation: {
      currentSceneOrder: 2,
      totalScenes: 4,
      hasPreviousScene: true,
      hasNextScene: true,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
