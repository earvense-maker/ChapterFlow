import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkSettingsTab from '../../src/client/components/WorkSettingsTab';
import type { Project } from '../../src/shared/types';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getProjectPresets: vi.fn().mockResolvedValue({}),
    getWorld: vi.fn().mockResolvedValue({ foundation: '魔法法則', initialSituation: '停戦中' }),
    getCharacters: vi.fn().mockResolvedValue([]),
    getPresets: vi.fn().mockResolvedValue({ categories: {} }),
    getStoryState: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 1 },
      processedGenerationIds: [],
      updatedAt: '2026-07-16T00:00:00.000Z',
    }),
    getStoryStateDiffs: vi.fn().mockResolvedValue([]),
    getKnowledge: vi.fn().mockResolvedValue([]),
    previewSystemPrompt: vi.fn().mockResolvedValue({
      systemPrompt: '',
      generatedSystemPrompt: '',
      customSystemPrompt: '',
      isCustomized: false,
    }),
    getRefineScan: vi.fn().mockResolvedValue(null),
    getRefineReviewStatus: vi.fn().mockResolvedValue(null),
    getStyleSamples: vi.fn().mockResolvedValue([]),
    getSystemPromptPresets: vi.fn().mockResolvedValue([]),
    updateWorldArea: vi.fn().mockImplementation(
      async (_id, area, text) => ({
        foundation: area === 'foundation' ? text : '魔法法則',
        initialSituation: area === 'initialSituation' ? text : '祭り前夜',
      })
    ),
  },
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));
vi.mock('../../src/client/components/RefineChatPanel', () => ({
  default: ({ onSettingsChanged }: { onSettingsChanged: () => void }) => (
    <button type="button" onClick={onSettingsChanged}>
      mock-refine-refresh
    </button>
  ),
}));

const project: Project = {
  schemaVersion: 1,
  projectId: 'proj-world-ui',
  title: 'World UI',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  activeModelProvider: 'gemini',
  activeModelName: 'gemini-3.5-flash',
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: {
    genre: 'modern-drama',
    style: 'natural-dialogue',
    pov: 'third-person-close',
    pacing: 'standard',
    density: 'balanced',
  },
};

describe('WorkSettingsTab world areas', () => {
  beforeEach(() => {
    apiMock.getWorld.mockReset().mockResolvedValue({
      foundation: '魔法法則',
      initialSituation: '停戦中',
    });
    apiMock.updateWorldArea.mockReset().mockImplementation(
      async (_id, area, text) => ({
        foundation: area === 'foundation' ? text : '魔法法則',
        initialSituation: area === 'initialSituation' ? text : '祭り前夜',
      })
    );
  });

  it('opens on initialSituation and preserves the other area on each save', async () => {
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '世界' }));
    expect(screen.getByRole('tab', { name: '開始時点の状況' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('停戦中')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /編集/ }));
    fireEvent.change(
      screen.getByPlaceholderText(/勢力関係・人物の所属や所在/),
      { target: { value: '祭り前夜' } }
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(apiMock.updateWorldArea).toHaveBeenLastCalledWith(
        project.projectId,
        'initialSituation',
        '祭り前夜'
      )
    );

    fireEvent.click(screen.getByRole('tab', { name: '世界の土台' }));
    fireEvent.click(screen.getByRole('button', { name: /編集/ }));
    fireEvent.change(
      screen.getByPlaceholderText(/魔法法則・地理・文化・宇宙観/),
      { target: { value: '新しい魔法法則' } }
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(apiMock.updateWorldArea).toHaveBeenLastCalledWith(
        project.projectId,
        'foundation',
        '新しい魔法法則'
      )
    );
  });

  it('ignores a stale refine refresh that resolves after an area save', async () => {
    let resolveRefresh!: (world: { foundation: string; initialSituation: string }) => void;
    apiMock.getWorld
      .mockResolvedValueOnce({ foundation: '魔法法則', initialSituation: '停戦中' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
    apiMock.updateWorldArea.mockResolvedValueOnce({
      foundation: '新しい魔法法則',
      initialSituation: 'refineで更新済み',
    });
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '世界' }));
    fireEvent.click(screen.getByRole('button', { name: 'mock-refine-refresh' }));
    await waitFor(() => expect(apiMock.getWorld).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('tab', { name: '世界の土台' }));
    fireEvent.click(screen.getByRole('button', { name: /編集/ }));
    fireEvent.change(screen.getByPlaceholderText(/魔法法則・地理・文化・宇宙観/), {
      target: { value: '新しい魔法法則' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText('新しい魔法法則');

    resolveRefresh({ foundation: '古い魔法法則', initialSituation: '古い状況' });
    fireEvent.click(screen.getByRole('tab', { name: '開始時点の状況' }));
    expect(await screen.findByText('refineで更新済み')).toBeInTheDocument();
    expect(screen.queryByText('古い状況')).not.toBeInTheDocument();
  });
});
