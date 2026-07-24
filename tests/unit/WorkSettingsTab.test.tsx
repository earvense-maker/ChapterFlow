import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WorkSettingsTab from '../../src/client/components/WorkSettingsTab';
import { api } from '../../src/client/clientApi';
import type {
  KnowledgeListItem,
  Project,
  StoryState,
  SystemPromptPreview,
} from '../../src/shared/types';

// NOTE: WorkSettingsTab は 1,800 行規模で単体テストが無かった。ここでは初期ロードと、
// カスタムフックへ切り出した「資料タブ(useKnowledgeManager)」「物語状態タブ
// (useStoryStatePanel)」の描画・状態遷移を回帰対象にする。重い子コンポーネントと
// 確認ダイアログはスタブ化し、この画面自身のロジックだけを検証する。

vi.mock('../../src/client/clientApi', () => ({
  api: {
    getProjectPresets: vi.fn(),
    getWorld: vi.fn(),
    getCharacters: vi.fn(),
    getPresets: vi.fn(),
    getStoryState: vi.fn(),
    getStoryStateDiffs: vi.fn(),
    getKnowledge: vi.fn(),
    previewSystemPrompt: vi.fn(),
    getRefineScan: vi.fn(),
    getRefineReviewStatus: vi.fn(),
    getStyleSamples: vi.fn(),
    getSystemPromptPresets: vi.fn(),
    updateWorldArea: vi.fn(),
    updateKnowledge: vi.fn(),
    getKnowledgeContent: vi.fn(),
  },
}));

vi.mock('../../src/client/components/ConfirmDialog', () => ({
  useConfirm: () => vi.fn(async () => true),
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// 重い子コンポーネントは自前の API 取得や描画を持つのでスタブ化する。
vi.mock('../../src/client/components/RefineChatPanel', () => ({ default: () => <div /> }));
vi.mock('../../src/client/components/RefineAutomationSettingsCard', () => ({ default: () => <div /> }));
vi.mock('../../src/client/components/StyleVariationSettingsCard', () => ({ default: () => <div /> }));
vi.mock('../../src/client/components/CharacterTraitsEditor', () => ({ default: () => <div /> }));
vi.mock('../../src/client/components/PresetSelector', () => ({ default: () => <div /> }));

const project: Project = {
  schemaVersion: 1,
  projectId: 'proj-1',
  title: 'テスト作品',
  coreConcept: '核となる概念',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  activeModelProvider: 'gemini',
  activeModelName: 'gemini-2.5-flash',
  outputLength: 2000,
  streamingEnabled: false,
  activePresetIds: { narration: 'third-close' },
  projectType: 'novel',
};

const preview: SystemPromptPreview = {
  systemPrompt: 'システム',
  customSystemPrompt: '',
  baseSystemPrompt: 'ベース',
  defaultBaseSystemPrompt: 'ベース',
  generatedSystemPrompt: '生成',
  isCustomized: false,
};

const storyState: StoryState = {
  schemaVersion: 1,
  currentSituation: ['港町の古書店に客が少ない。'],
  characterStates: [],
  importantEvents: [],
  openThreads: [],
  authorUndecided: [],
  clock: { day: 1 },
  updatedAt: '2026-07-09T12:00:00.000Z',
};

const knowledgeItem: KnowledgeListItem = {
  knowledgeId: 'kb-1',
  title: '用語集',
  originalFileName: 'terms.md',
  extension: 'md',
  enabled: true,
  order: 0,
  charCount: 120,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  contentStatus: 'ok',
};

function noop() {
  /* テスト用の空コールバック */
}

function renderPanel() {
  return render(
    <WorkSettingsTab
      projectId="proj-1"
      project={project}
      onError={noop}
      onFlashMessage={noop}
      onProjectUpdated={noop}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getProjectPresets).mockResolvedValue({ customSystemPrompt: '' } as never);
  vi.mocked(api.getWorld).mockResolvedValue({ foundation: '土台', initialSituation: '開始' });
  vi.mocked(api.getCharacters).mockResolvedValue([]);
  vi.mocked(api.getPresets).mockResolvedValue({ categories: {} } as never);
  vi.mocked(api.getStoryState).mockResolvedValue(storyState);
  vi.mocked(api.getStoryStateDiffs).mockResolvedValue([]);
  vi.mocked(api.getKnowledge).mockResolvedValue([knowledgeItem]);
  vi.mocked(api.previewSystemPrompt).mockResolvedValue(preview);
  vi.mocked(api.getRefineScan).mockResolvedValue(null);
  vi.mocked(api.getRefineReviewStatus).mockResolvedValue(null);
  vi.mocked(api.getStyleSamples).mockResolvedValue([]);
  vi.mocked(api.getSystemPromptPresets).mockResolvedValue([]);
});

describe('WorkSettingsTab', () => {
  it('loads project data and renders the detail settings tabs', async () => {
    renderPanel();

    // 初期スピナーが実データ取得後に詳細設定タブへ置き換わる。
    expect(await screen.findByRole('tab', { name: /基本/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /世界/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /人物/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /物語状態/ })).toBeInTheDocument();
    expect(api.getWorld).toHaveBeenCalledWith('proj-1');
  });

  it('reflects the knowledge item from useKnowledgeManager and lists it on the 資料 tab', async () => {
    renderPanel();

    // 初期一括ロードで取得した資料件数が、フックの派生値としてバッジに出る。
    expect(await screen.findByText('資料 1件')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /資料/ }));

    const item = (await screen.findByText('用語集')).closest('li') as HTMLElement;
    expect(within(item).getByText(/120 字/)).toBeInTheDocument();
  });

  it('shows story state and enters JSON edit mode via useStoryStatePanel', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('tab', { name: /物語状態/ }));

    expect(await screen.findByText('1日目')).toBeInTheDocument();
    expect(screen.getByText('2026-07-09')).toBeInTheDocument();

    // ✎ JSON編集 で編集モードに入り、draft が現在状態の JSON で満たされる。
    fireEvent.click(screen.getByRole('button', { name: /JSON編集/ }));

    const textarea = await screen.findByRole('textbox');
    expect((textarea as HTMLTextAreaElement).value).toContain('"currentSituation"');
    expect((textarea as HTMLTextAreaElement).value).toContain('港町の古書店に客が少ない。');
  });

  it('saves a knowledge enabled toggle through the hook handler', async () => {
    vi.mocked(api.updateKnowledge).mockResolvedValue({ ok: true } as never);
    renderPanel();

    fireEvent.click(await screen.findByRole('tab', { name: /資料/ }));
    const item = (await screen.findByText('用語集')).closest('li') as HTMLElement;

    // 有効/無効トグル（チェックボックス）が handleToggleKnowledge を通す。
    fireEvent.click(within(item).getByRole('checkbox'));

    await waitFor(() => {
      expect(api.updateKnowledge).toHaveBeenCalledWith('proj-1', 'kb-1', { enabled: false });
    });
  });
});
