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
    getExpressions: vi.fn(),
    getGlobalExpressions: vi.fn(),
    rewriteNgOccurrence: vi.fn(),
    getNgAutoRewriteSettings: vi.fn(),
    updateNgAutoRewriteSettings: vi.fn(),
  },
}));

const PROJECT_ID = 'proj-ng-auto-rewrite';
const generate = vi.mocked(api.generate);
const getReaderState = vi.mocked(api.getReaderState);
const getKnowledge = vi.mocked(api.getKnowledge);
const getNotificationSettings = vi.mocked(api.getNotificationSettings);
const getExpressions = vi.mocked(api.getExpressions);
const getGlobalExpressions = vi.mocked(api.getGlobalExpressions);
const rewriteNgOccurrence = vi.mocked(api.rewriteNgOccurrence);
const getNgAutoRewriteSettings = vi.mocked(api.getNgAutoRewriteSettings);

// NOTE: 「息を呑んだ」が2回出る本文。自動書き換えが1件ずつ直列に処理し、
// 都度取り直していることを検証するための土台。
const GENERATED_TEXT = '彼は息を呑んだ。少しして、彼女も息を呑んだ。';
const AFTER_FIRST = '彼は言葉を失った。少しして、彼女も息を呑んだ。';
const AFTER_SECOND = '彼は言葉を失った。少しして、彼女も肩を震わせた。';

describe('Reader NG auto rewrite', () => {
  beforeEach(() => {
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    generate.mockReset().mockResolvedValue(generationRecord());
    getReaderState.mockReset().mockResolvedValue(readerState());
    getKnowledge.mockReset().mockResolvedValue([]);
    getNotificationSettings.mockReset().mockResolvedValue(null as never);
    getExpressions.mockReset().mockResolvedValue({ ngExpressions: [] });
    getGlobalExpressions.mockReset().mockResolvedValue({
      ngExpressions: [
        {
          id: 'ngx-1',
          text: '息を呑んだ',
          source: 'manual',
          status: 'active',
          createdAt: '2026-07-25T00:00:00.000Z',
          updatedAt: '2026-07-25T00:00:00.000Z',
        },
      ],
    });
    rewriteNgOccurrence.mockReset();
    getNgAutoRewriteSettings.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when the option is off', async () => {
    getNgAutoRewriteSettings.mockResolvedValue({ enabled: false, maxRewritesPerGeneration: 3 });
    const { findByRole } = await renderAndGenerate();

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(rewriteNgOccurrence).not.toHaveBeenCalled();
    // ハイライトは出るので、手で直す導線は残っている
    await waitFor(() => expect(document.querySelectorAll('mark.ng-hit')).toHaveLength(2));
    expect(await findByRole('article')).toBeTruthy();
  });

  it('rewrites every hit one at a time, re-detecting against the updated text', async () => {
    getNgAutoRewriteSettings.mockResolvedValue({ enabled: true, maxRewritesPerGeneration: 3 });
    rewriteNgOccurrence
      .mockResolvedValueOnce(rewriteResult(AFTER_FIRST, '言葉を失った'))
      .mockResolvedValueOnce(rewriteResult(AFTER_SECOND, '肩を震わせた'));

    await renderAndGenerate();

    await waitFor(() => expect(rewriteNgOccurrence).toHaveBeenCalledTimes(2));
    // NOTE: 2件目の位置は1件目を書き換えた後の本文から取り直していなければならない。
    // 生成直後の本文で計算した位置を使い回すとここがずれる。
    const secondCall = rewriteNgOccurrence.mock.calls[1][2];
    expect(AFTER_FIRST.slice(secondCall.start, secondCall.end)).toBe('息を呑んだ');
    await waitFor(() => expect(document.querySelectorAll('mark.ng-hit')).toHaveLength(0));
  });

  it('stops at the configured limit', async () => {
    getNgAutoRewriteSettings.mockResolvedValue({ enabled: true, maxRewritesPerGeneration: 1 });
    rewriteNgOccurrence.mockResolvedValue(rewriteResult(AFTER_FIRST, '言葉を失った'));

    await renderAndGenerate();

    await waitFor(() => expect(rewriteNgOccurrence).toHaveBeenCalledTimes(1));
    // 残った1件はハイライトのままで、手で直せる
    await waitFor(() => expect(document.querySelectorAll('mark.ng-hit')).toHaveLength(1));
  });

  // NOTE: 1件が収束しなくても残りを諦めない。かつ、飛ばした箇所を再び選び続けて
  // 無限ループにならないことがここの本題。
  it('skips a hit that failed to converge and moves on to the next', async () => {
    getNgAutoRewriteSettings.mockResolvedValue({ enabled: true, maxRewritesPerGeneration: 3 });
    rewriteNgOccurrence
      .mockRejectedValueOnce(new Error('3回試しても言い換えられませんでした'))
      .mockResolvedValueOnce(rewriteResult(AFTER_SECOND_ONLY, '肩を震わせた'));

    await renderAndGenerate();

    await waitFor(() => expect(rewriteNgOccurrence).toHaveBeenCalledTimes(2));
    const [first, second] = rewriteNgOccurrence.mock.calls;
    expect(first[2].start).toBeLessThan(second[2].start);
    await waitFor(() => expect(document.querySelectorAll('mark.ng-hit')).toHaveLength(1));
  });
});

// 1件目を飛ばして2件目だけ書き換えた本文
const AFTER_SECOND_ONLY = '彼は息を呑んだ。少しして、彼女も肩を震わせた。';

async function renderAndGenerate() {
  const utils = render(
    <ConfirmProvider>
      <NotificationProvider>
        <Reader
          projectId={PROJECT_ID}
          onBack={vi.fn()}
          onOpenWorkSettings={vi.fn()}
          onOpenTechSettings={vi.fn()}
          onOpenMemories={vi.fn()}
        />
      </NotificationProvider>
    </ConfirmProvider>
  );
  await waitFor(() => expect(getReaderState).toHaveBeenCalled());
  await waitFor(() => expect(getNgAutoRewriteSettings).toHaveBeenCalled());
  await waitFor(() => expect(getGlobalExpressions).toHaveBeenCalled());
  fireEvent.click(await utils.findByRole('button', { name: '生成' }));
  return utils;
}

function rewriteResult(text: string, after: string) {
  return {
    generationId: 'gen-ng-auto-rewrite',
    text,
    expressionText: '息を呑んだ',
    before: '前の一文',
    after,
    attempts: 1,
  };
}

function generationRecord(): GenerationRecord {
  return {
    generationId: 'gen-ng-auto-rewrite',
    episodeId: 'episode-ng-auto-rewrite',
    sceneId: 'scene-ng-auto-rewrite',
    request: { wish: '', outputLength: 3000, previousContextText: '' },
    responseText: GENERATED_TEXT,
    usedPresets: { narration: 'third-close' },
    usedModel: { provider: 'openai', modelName: 'gpt-test' },
    referencedMemoryIds: [],
    status: 'draft',
    createdAt: '2026-07-25T00:01:00.000Z',
    parentGenerationId: null,
  };
}

function readerState(): ReaderState {
  return {
    project: {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      title: 'NG Auto Rewrite Test',
      createdAt: '2026-07-25T00:00:00.000Z',
      updatedAt: '2026-07-25T00:00:00.000Z',
      activeModelProvider: 'openai',
      activeModelName: 'gpt-test',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: { narration: 'third-close' },
    },
    state: {
      lastOpenedAt: '2026-07-25T00:00:00.000Z',
      currentEpisodeId: null,
      currentSceneId: null,
      selectedDraftGenerationId: null,
      lastAcceptedGenerationId: null,
      pendingMemoryCandidateIds: [],
      storyStateRefresh: {
        status: 'fresh',
        generationId: null,
        updatedAt: '2026-07-25T00:00:00.000Z',
      },
      uiState: { readingPosition: 0, fontSize: 18 },
    },
    currentEpisode: null,
    currentScene: null,
    // NOTE: 生成後の load() が本文を上書きするので、ここが null だと自動書き換えを
    // 切った場合に本文ごと消えてハイライトの検証にならない。実際の読み込みと同じく
    // 生成済みレコードを返す。
    currentGeneration: generationRecord(),
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
