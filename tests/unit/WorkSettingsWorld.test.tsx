import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../../src/client/components/ConfirmDialog';
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
    updateProject: vi.fn(),
    updateProjectPresets: vi.fn().mockResolvedValue({}),
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
    narration: 'third-close',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WorkSettingsTab world areas', () => {
  beforeEach(() => {
    apiMock.getProjectPresets.mockReset().mockResolvedValue({});
    apiMock.previewSystemPrompt.mockReset().mockResolvedValue({
      systemPrompt: '',
      generatedSystemPrompt: '',
      customSystemPrompt: '',
      isCustomized: false,
    });
    apiMock.updateProjectPresets.mockReset().mockResolvedValue({});
    apiMock.updateProject.mockReset().mockResolvedValue(project);
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

describe('WorkSettingsTab style sample gallery', () => {
  beforeEach(() => {
    apiMock.getStyleSamples.mockReset().mockResolvedValue([
      {
        id: 'quiet-prose',
        label: '静かな文体',
        description: '落ち着いた描写',
        text: '雨音だけが、静かな部屋に残っていた。',
      },
    ]);
    apiMock.updateProject.mockReset().mockImplementation(async (_id, updates) => ({
      ...project,
      styleSample: updates.styleSample,
    }));
  });

  it('replaces an existing sample through the in-app confirmation and saves it', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(
      <ConfirmProvider>
        <WorkSettingsTab
          projectId={project.projectId}
          project={{ ...project, styleSample: '既存の文体見本' }}
          onError={vi.fn()}
          onFlashMessage={vi.fn()}
          onProjectUpdated={vi.fn()}
        />
      </ConfirmProvider>
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    const section = screen.getByRole('heading', { name: '文体見本' }).closest('section');
    expect(section).not.toBeNull();
    fireEvent.click(within(section!).getByRole('button', { name: /編集/ }));

    fireEvent.change(within(section!).getByLabelText('見本ギャラリーから選ぶ'), {
      target: { value: 'quiet-prose' },
    });
    fireEvent.click(within(section!).getByRole('button', { name: 'この見本を採用' }));

    expect(await screen.findByRole('dialog', { name: '確認' })).toBeVisible();
    expect(nativeConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '置き換える' }));

    const textarea = within(section!).getByPlaceholderText('文体見本（1000字まで）');
    await waitFor(() =>
      expect(textarea).toHaveValue('雨音だけが、静かな部屋に残っていた。')
    );
    fireEvent.click(within(section!).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(apiMock.updateProject).toHaveBeenCalledWith(project.projectId, {
        styleSample: '雨音だけが、静かな部屋に残っていた。',
      })
    );
  });
});

describe('WorkSettingsTab system prompt additions', () => {
  beforeEach(() => {
    apiMock.getPresets.mockReset().mockResolvedValue({ categories: {} });
    apiMock.getProjectPresets.mockReset().mockResolvedValue({
      customSystemPrompt: '既存の追加指示',
    });
    apiMock.previewSystemPrompt.mockReset().mockImplementation(
      async (_id, _presets, customSystemPrompt?: string | null) => {
        const custom = customSystemPrompt ?? '';
        return {
          systemPrompt: custom
            ? `基本プロンプト\n\n---\n\n【作品固有の追加指示】\n${custom}`
            : '基本プロンプト',
          generatedSystemPrompt: '基本プロンプト',
          customSystemPrompt: custom,
          isCustomized: custom.trim().length > 0,
        };
      }
    );
    apiMock.updateProjectPresets.mockReset().mockImplementation(async (_id, presets) => presets);
    apiMock.getSystemPromptPresets.mockReset().mockResolvedValue([]);
  });

  it('edits and saves only the custom addition without persisting the generated prompt', async () => {
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    await screen.findByText('追加指示あり');
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);

    const editor = screen.getByRole('textbox', {
      name: 'システムプロンプトの追加指示',
    });
    expect(editor).toHaveValue('既存の追加指示');
    expect((editor as HTMLTextAreaElement).value).not.toContain('基本プロンプト');

    fireEvent.change(editor, { target: { value: '新しい追加指示' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(apiMock.updateProjectPresets).toHaveBeenCalledWith(
        project.projectId,
        expect.objectContaining({ customSystemPrompt: '新しい追加指示' })
      )
    );
    expect(apiMock.previewSystemPrompt).toHaveBeenLastCalledWith(
      project.projectId,
      expect.objectContaining({ customSystemPrompt: '新しい追加指示' }),
      '新しい追加指示'
    );
    expect(screen.getByText('追加指示あり')).toBeInTheDocument();
  });

  it('edits and saves the always-applied base prompt separately', async () => {
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);

    const baseEditor = screen.getByRole('textbox', {
      name: '常に適用される基本プロンプト',
    });
    expect(baseEditor).toHaveValue('基本プロンプト');
    fireEvent.change(baseEditor, {
      target: { value: '編集した基本プロンプト' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(apiMock.updateProjectPresets).toHaveBeenCalledWith(
        project.projectId,
        expect.objectContaining({
          baseSystemPrompt: '編集した基本プロンプト',
          customSystemPrompt: '既存の追加指示',
        })
      )
    );
  });

  it('clears only the custom addition and keeps the generated prompt active', async () => {
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    await screen.findByText('追加指示あり');
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);
    const previewCallsBeforeClear = apiMock.previewSystemPrompt.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '追加指示をクリア' }));

    const editor = screen.getByRole('textbox', {
      name: 'システムプロンプトの追加指示',
    });
    await waitFor(() => expect(editor).toHaveValue(''));
    expect(apiMock.previewSystemPrompt).toHaveBeenCalledTimes(previewCallsBeforeClear);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(apiMock.updateProjectPresets).toHaveBeenCalledWith(
        project.projectId,
        expect.objectContaining({ customSystemPrompt: '' })
      )
    );
    expect(apiMock.previewSystemPrompt).toHaveBeenLastCalledWith(
      project.projectId,
      expect.objectContaining({ customSystemPrompt: '' }),
      ''
    );
    expect(screen.getByText('作風設定由来')).toBeInTheDocument();
    expect(screen.getByText('システムプロンプト全文（7 字）')).toBeInTheDocument();
  });

  it('keeps the normalized saved value when preview refresh fails', async () => {
    apiMock.updateProjectPresets.mockReset().mockResolvedValue({
      customSystemPrompt: '正規化済みの追加指示',
    });
    apiMock.previewSystemPrompt.mockReset()
      .mockImplementationOnce(async (_id, _presets, customSystemPrompt?: string | null) => {
        const custom = customSystemPrompt ?? '';
        return {
          systemPrompt: `基本プロンプト\n${custom}`,
          generatedSystemPrompt: '基本プロンプト',
          customSystemPrompt: custom,
          isCustomized: Boolean(custom),
        };
      })
      .mockRejectedValueOnce(new Error('preview unavailable'));
    const onError = vi.fn();
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={onError}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    await screen.findByText('追加指示あり');
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: 'システムプロンプトの追加指示' }), {
      target: { value: '正規化前の値' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('システムプロンプトは保存されましたが、プレビューの更新に失敗しました')
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);
    expect(screen.getByRole('textbox', { name: 'システムプロンプトの追加指示' })).toHaveValue(
      '正規化済みの追加指示'
    );
  });

  it('loads a saved addition locally without requesting a prompt preview', async () => {
    apiMock.getSystemPromptPresets.mockReset().mockResolvedValue([
      {
        id: 'preset-local',
        name: '会話中心',
        prompt: '会話を短く保つ。',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      },
    ]);
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    await screen.findByText('追加指示あり');
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);
    const select = await screen.findByRole('combobox', { name: 'システムプロンプトのプリセット' });
    fireEvent.change(select, { target: { value: 'preset-local' } });
    const previewCallsBeforeLoad = apiMock.previewSystemPrompt.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));

    expect(screen.getByRole('textbox', { name: 'システムプロンプトの追加指示' })).toHaveValue(
      '会話を短く保つ。'
    );
    expect(apiMock.previewSystemPrompt).toHaveBeenCalledTimes(previewCallsBeforeLoad);
  });

  it('updates active presets and refreshes the normalized prompt preview', async () => {
    apiMock.getProjectPresets.mockReset().mockResolvedValue({
      userCustomPromptParts: [],
      customSystemPrompt: '旧プロンプト全文',
    });
    apiMock.getPresets.mockReset().mockResolvedValue({
      categories: {
        intimacy: {
          label: '濡れ場の描写',
          items: {
            suggestive: { id: 'suggestive', label: '控えめ', text: '控えめに書く。' },
            'direct-soft': { id: 'direct-soft', label: '直接的', text: '直接的に書く。' },
          },
        },
      },
    });
    apiMock.updateProject.mockReset().mockResolvedValue({
      ...project,
      activePresetIds: { ...project.activePresetIds, intimacy: 'direct-soft' },
    });
    apiMock.previewSystemPrompt.mockReset().mockImplementation(
      async (_id, _presets, customSystemPrompt?: string | null) => {
        const isLegacy = customSystemPrompt === '旧プロンプト全文';
        return {
          systemPrompt: '基本プロンプト',
          generatedSystemPrompt: '基本プロンプト',
          customSystemPrompt: isLegacy ? '正規化済みの追加指示' : customSystemPrompt ?? '',
          isCustomized: true,
        };
      }
    );
    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={project}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    await screen.findByText('追加指示あり');
    fireEvent.click(await screen.findByDisplayValue('direct-soft'));
    await waitFor(() =>
      expect(apiMock.updateProject).toHaveBeenCalledWith(
        project.projectId,
        { activePresetIds: { narration: 'third-close', intimacy: 'direct-soft' } }
      )
    );
    fireEvent.click(screen.getAllByRole('button', { name: /編集/ })[0]);

    expect(screen.getByRole('textbox', { name: 'システムプロンプトの追加指示' })).toHaveValue(
      '正規化済みの追加指示'
    );
  });

  it('sends an explicit empty value when an optional preset is cleared', async () => {
    const projectWithIntimacy: Project = {
      ...project,
      activePresetIds: { narration: 'third-close', intimacy: 'suggestive' },
    };
    apiMock.getPresets.mockReset().mockResolvedValue({
      categories: {
        intimacy: {
          label: '濡れ場の描写',
          items: {
            suggestive: { id: 'suggestive', label: '気配だけ', text: '気配だけにする。' },
          },
        },
      },
    });
    apiMock.updateProject.mockReset().mockResolvedValue({
      ...projectWithIntimacy,
      activePresetIds: { narration: 'third-close' },
    });

    render(
      <WorkSettingsTab
        projectId={project.projectId}
        project={projectWithIntimacy}
        onError={vi.fn()}
        onFlashMessage={vi.fn()}
        onProjectUpdated={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: '作風設定' }));
    fireEvent.click(await screen.findByRole('radio', { name: '指定しない' }));
    await waitFor(() =>
      expect(apiMock.updateProject).toHaveBeenCalledWith(project.projectId, {
        activePresetIds: { narration: 'third-close', intimacy: '' },
      })
    );
  });
});
