import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AIConsultationTab from '../../src/client/components/AIConsultationTab';
import { ConfirmProvider } from '../../src/client/components/ConfirmDialog';
import { formatCharacterPatchValue } from '../../src/client/components/aiConsultation/consultationFormat';
import type {
  Project,
  RefineScanResult,
  RefineSession,
  RefineSuggestedAction,
} from '../../src/shared/types';

const apiMock = vi.hoisted(() => ({
  getCharacters: vi.fn(),
  getRefineSession: vi.fn(),
  getRefineAutomationRuns: vi.fn(),
  getRefineAutomationSettings: vi.fn(),
  sendRefineMessage: vi.fn(),
  updateRefineFindingDisposition: vi.fn(),
  scanRefine: vi.fn(),
  applyRefinePatch: vi.fn(),
  rejectRefinePatch: vi.fn(),
  resetRefineSession: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));
vi.mock('../../src/client/components/RefineAutomationSettingsCard', () => ({
  default: () => <div data-testid="automation-settings" />,
}));

const project: Project = {
  schemaVersion: 1,
  projectId: 'proj-ai',
  title: 'AI相談テスト',
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
  activeModelProvider: 'gemini',
  activeModelName: 'gemini-test',
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: { narration: 'third-close' },
};

function makeSession(overrides: Partial<RefineSession> = {}): RefineSession {
  return {
    schemaVersion: 3,
    sessionId: 'refsess-1',
    projectId: project.projectId,
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    messages: [],
    patches: [],
    revision: 0,
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    lastError: null,
    consultationState: { notes: [], findingDispositions: [] },
    ...overrides,
  };
}

function makeScan(overrides: Partial<RefineScanResult> = {}): RefineScanResult {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-28T00:00:00.000Z',
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    coreConcept: '',
    lastError: null,
    reviewedStaticInputHash: 'hash-1',
    findings: [
      {
        id: 'finding-1',
        kind: 'undefined',
        target: { kind: 'character', characterId: 'char-a', characterName: '美咲' },
        topic: 'motivation',
        fingerprint: 'fp-1',
        message: '美咲の動機が書かれていません。',
      },
    ],
    ...overrides,
  };
}

function renderTab(props: Partial<Parameters<typeof AIConsultationTab>[0]> = {}) {
  const defaults = {
    projectId: project.projectId,
    project,
    session: makeSession(),
    onSessionChanged: vi.fn(),
    refineScan: makeScan(),
    onRefineScanChanged: vi.fn(),
    reviewStatus: null,
    onReviewStatusRefresh: vi.fn(),
    pendingTarget: null,
    onPendingTargetConsumed: vi.fn(),
    onSettingsChanged: vi.fn(),
    onEditInWorkSettings: vi.fn(),
    onError: vi.fn(),
    onFlashMessage: vi.fn(),
  };
  const merged = { ...defaults, ...props };
  return {
    ...render(
      <ConfirmProvider>
        <AIConsultationTab {...merged} />
      </ConfirmProvider>
    ),
    props: merged,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom は scrollIntoView を実装していない。通知フォーカスの検証で必要なので補う。
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.getCharacters.mockResolvedValue([
    { characterId: 'char-a', name: '美咲', role: 'protagonist', description: '17歳' },
  ]);
  apiMock.getRefineSession.mockResolvedValue(makeSession());
  apiMock.getRefineAutomationRuns.mockResolvedValue([]);
  apiMock.getRefineAutomationSettings.mockResolvedValue({ settings: null, status: null });
});

describe('formatCharacterPatchValue', () => {
  it('formats trait arrays and indents continuation lines', () => {
    expect(
      formatCharacterPatchValue([
        { label: 'こだわり', text: '一行目\n二行目' },
        { label: '動機', text: '故郷へ帰る' },
      ])
    ).toBe('こだわり: 一行目\n  二行目\n動機: 故郷へ帰る');
  });

  it('shows an explicit empty marker for clearing traits', () => {
    expect(formatCharacterPatchValue([])).toBe('（なし）');
  });
});

describe('AIConsultationTab', () => {
  it('does not call the model just by opening the tab', async () => {
    renderTab();
    await waitFor(() => expect(apiMock.getCharacters).toHaveBeenCalled());
    expect(apiMock.sendRefineMessage).not.toHaveBeenCalled();
    expect(apiMock.scanRefine).not.toHaveBeenCalled();
  });

  it('sends conversation starters as consult so no patch is produced', async () => {
    apiMock.sendRefineMessage.mockResolvedValue({
      session: makeSession(),
      assistantMessage: { messageId: 'm', role: 'assistant', content: 'ok', createdAt: '' },
      newPatches: [],
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: '人物の背景を深掘り' }));

    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendRefineMessage.mock.calls[0][2]).toMatchObject({ responseMode: 'consult' });
  });

  it('sends free input as auto so direct edits still produce patches', async () => {
    apiMock.sendRefineMessage.mockResolvedValue({
      session: makeSession(),
      assistantMessage: { messageId: 'm', role: 'assistant', content: 'ok', createdAt: '' },
      newPatches: [],
    });
    renderTab();

    fireEvent.change(await screen.findByLabelText('相談を入力'), {
      target: { value: '美咲の年齢を28歳にして' },
    });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));

    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendRefineMessage.mock.calls[0][2]).toMatchObject({ responseMode: 'auto' });
  });

  it('shows a selected finding as a consultation theme without sending anything', async () => {
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: '相談する' }));

    expect(await screen.findByText('相談テーマ')).toBeVisible();
    expect(apiMock.sendRefineMessage).not.toHaveBeenCalled();
  });

  it('sends the selected finding as target once the user starts the consultation', async () => {
    apiMock.sendRefineMessage.mockResolvedValue({
      session: makeSession(),
      assistantMessage: { messageId: 'm', role: 'assistant', content: 'ok', createdAt: '' },
      newPatches: [],
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: '相談する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この気づきの相談を始める' }));

    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendRefineMessage.mock.calls[0][2]).toMatchObject({
      responseMode: 'consult',
      target: { kind: 'finding', findingId: 'finding-1', fingerprint: 'fp-1' },
    });
  });

  it('sends "変更候補を作る" with prepare-patch and keeps earlier actions non-interactive', async () => {
    const actions: RefineSuggestedAction[] = [
      { label: 'この方向で変更候補を作る', message: 'この方向でお願いします。', responseMode: 'prepare-patch' },
    ];
    const session = makeSession({
      messages: [
        {
          messageId: 'm-old',
          role: 'assistant',
          content: '古い返答',
          createdAt: '2026-07-28T00:00:00.000Z',
          suggestedActions: [{ label: '古い候補', message: '古い', responseMode: 'consult' }],
        },
        {
          messageId: 'm-user',
          role: 'user',
          content: 'そうですね',
          createdAt: '2026-07-28T00:01:00.000Z',
        },
        {
          messageId: 'm-new',
          role: 'assistant',
          content: '新しい返答',
          createdAt: '2026-07-28T00:02:00.000Z',
          suggestedActions: actions,
        },
      ],
    });
    apiMock.getRefineSession.mockResolvedValue(session);
    apiMock.sendRefineMessage.mockResolvedValue({
      session,
      assistantMessage: { messageId: 'm2', role: 'assistant', content: 'ok', createdAt: '' },
      newPatches: [],
    });
    renderTab({ session });

    // 末尾以外の候補はボタンではなく履歴表示になる。
    expect(screen.queryByRole('button', { name: '古い候補' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'この方向で変更候補を作る' }));
    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(1));
    expect(apiMock.sendRefineMessage.mock.calls[0][2]).toMatchObject({
      responseMode: 'prepare-patch',
    });
  });

  it('keeps the consultation target after a send so the next action inherits it', async () => {
    const session = makeSession();
    apiMock.sendRefineMessage.mockResolvedValue({
      session,
      assistantMessage: { messageId: 'm', role: 'assistant', content: 'ok', createdAt: '' },
      newPatches: [],
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: '相談する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この気づきの相談を始める' }));
    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(1));

    // 相談テーマは残り、続けて送る発話にも同じ target が乗る。
    expect(screen.getByText('相談テーマ')).toBeVisible();
    fireEvent.change(screen.getByLabelText('相談を入力'), { target: { value: 'では B 案で' } });
    fireEvent.click(screen.getByRole('button', { name: '送る' }));

    await waitFor(() => expect(apiMock.sendRefineMessage).toHaveBeenCalledTimes(2));
    expect(apiMock.sendRefineMessage.mock.calls[1][2]).toMatchObject({
      target: { kind: 'finding', findingId: 'finding-1', fingerprint: 'fp-1' },
    });
  });

  it('drops a consultation target whose finding disappeared after a rescan', async () => {
    const { rerender, props } = renderTab();

    fireEvent.click(await screen.findByRole('button', { name: '相談する' }));
    expect(await screen.findByText('相談テーマ')).toBeVisible();

    const rescanned = makeScan({
      generatedAt: '2026-07-28T09:00:00.000Z',
      findings: [
        {
          id: 'finding-9',
          kind: 'suggestion',
          target: { kind: 'world' },
          topic: 'world-rule',
          fingerprint: 'fp-9',
          message: '別の気づき。',
        },
      ],
    });
    rerender(
      <ConfirmProvider>
        <AIConsultationTab {...props} refineScan={rescanned} />
      </ConfirmProvider>
    );

    await waitFor(() => expect(screen.queryByText('相談テーマ')).toBeNull());
  });

  it('retries the notification focus until the target element is rendered', async () => {
    vi.useFakeTimers();
    try {
      const onFocusTargetConsumed = vi.fn();
      const { rerender, props } = renderTab({
        focusTarget: { section: 'ai-consultation', patchId: 'patch-late' },
        onFocusTargetConsumed,
      });

      // 対象がまだ描画されていない間は消費しない。
      await vi.advanceTimersByTimeAsync(400);
      expect(onFocusTargetConsumed).not.toHaveBeenCalled();

      const withPatch = makeSession({
        messages: [
          {
            messageId: 'm-late',
            role: 'assistant',
            content: '候補',
            createdAt: '2026-07-28T00:00:00.000Z',
            patchIds: ['patch-late'],
          },
        ],
        patches: [
          {
            patchId: 'patch-late',
            createdAt: '2026-07-28T00:00:00.000Z',
            sourceMessageId: 'm-late',
            summary: '遅れて届いた候補',
            operations: [{ kind: 'world-append', op: { text: '追記' } }],
            status: 'pending',
          },
        ],
      });
      rerender(
        <ConfirmProvider>
          <AIConsultationTab {...props} session={withPatch} />
        </ConfirmProvider>
      );

      await vi.advanceTimersByTimeAsync(300);
      expect(onFocusTargetConsumed).toHaveBeenCalledTimes(1);
      expect(document.getElementById('refine-patch-patch-late')).toHaveClass(
        'refine-focus-highlight'
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up and consumes the focus target when it never appears', async () => {
    vi.useFakeTimers();
    try {
      const onFocusTargetConsumed = vi.fn();
      renderTab({
        focusTarget: { section: 'ai-consultation', patchId: 'patch-never' },
        onFocusTargetConsumed,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(onFocusTargetConsumed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves a finding disposition and reflects the returned session', async () => {
    const updated = makeSession({
      consultationState: {
        notes: [],
        findingDispositions: [
          {
            fingerprint: 'fp-1',
            status: 'intentional-gap',
            updatedAt: '2026-07-28T00:05:00.000Z',
          },
        ],
      },
    });
    apiMock.updateRefineFindingDisposition.mockResolvedValue({
      session: updated,
      disposition: updated.consultationState!.findingDispositions[0],
    });
    const onSessionChanged = vi.fn();
    renderTab({ onSessionChanged });

    fireEvent.click(await screen.findByRole('button', { name: '意図的な空白として残す' }));

    await waitFor(() =>
      expect(apiMock.updateRefineFindingDisposition).toHaveBeenCalledWith(
        project.projectId,
        'fp-1',
        'intentional-gap'
      )
    );
    expect(onSessionChanged).toHaveBeenCalledWith(updated);
  });

  it('hides persistent dispositions for findings whose target has no stable identity', async () => {
    const scan = makeScan({
      findings: [
        {
          id: 'finding-other',
          kind: 'suggestion',
          target: { kind: 'other', label: '雰囲気' },
          topic: 'motivation',
          fingerprint: 'fp-other',
          message: 'もう少し余韻がほしいです。',
        },
      ],
    });
    renderTab({ refineScan: scan });

    expect(await screen.findByRole('button', { name: '今は保留' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '意図的な空白として残す' })).toBeNull();
    expect(screen.queryByRole('button', { name: '解決済みにする' })).toBeNull();
  });

  it('runs the settings scan from the findings inbox', async () => {
    const scanned = makeScan({ generatedAt: '2026-07-28T01:00:00.000Z' });
    apiMock.scanRefine.mockResolvedValue(scanned);
    const onRefineScanChanged = vi.fn();
    renderTab({ onRefineScanChanged });

    fireEvent.click(await screen.findByRole('button', { name: '再走査 🔄' }));

    await waitFor(() => expect(apiMock.scanRefine).toHaveBeenCalledWith(project.projectId));
    expect(onRefineScanChanged).toHaveBeenCalledWith(scanned);
  });

  it('shows finding evidence in the inbox', async () => {
    const scan = makeScan({
      findings: [
        {
          id: 'finding-evidence',
          kind: 'contradiction',
          target: { kind: 'storyState' },
          topic: 'state',
          fingerprint: 'fp-evidence',
          message: '人物の知識状態が食い違います。',
          evidence: [
            {
              generationId: 'gen-evidence',
              sceneId: 'scene-evidence',
              quote: '主人公は真実を知った。',
            },
          ],
        },
      ],
    });
    renderTab({ refineScan: scan });

    expect(await screen.findByText('根拠（採用本文）')).toBeVisible();
    expect(
      screen.getByText('場面 scene-evidence: 「主人公は真実を知った。」')
    ).toBeVisible();
  });

  it('does not render a zero when evidence is an empty array', async () => {
    const scan = makeScan();
    scan.findings[0].evidence = [];
    const { container } = renderTab({ refineScan: scan });

    await waitFor(() => expect(container.querySelector('.refine-finding')).not.toBeNull());
    expect(container.querySelector('.refine-finding')).not.toHaveTextContent('0');
    expect(container.querySelector('.refine-finding-evidence')).toBeNull();
  });

  it('blocks sending and patch actions while maintenance is running', async () => {
    apiMock.getRefineAutomationSettings.mockResolvedValue({
      settings: null,
      status: { phase: 'scanning' },
    });
    renderTab();

    await waitFor(() =>
      expect(screen.getByLabelText('相談を入力')).toBeDisabled()
    );
    expect(screen.getByRole('button', { name: /自動レビューの処理中|送る/ })).toBeDisabled();
  });

  it('offers 反映 / 調整を相談 / 見送る on a pending patch', async () => {
    const session = makeSession({
      messages: [
        {
          messageId: 'm-1',
          role: 'assistant',
          content: '変更候補を作りました',
          createdAt: '2026-07-28T00:00:00.000Z',
          patchIds: ['patch-1'],
        },
      ],
      patches: [
        {
          patchId: 'patch-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          sourceMessageId: 'm-1',
          summary: '美咲の動機を追加',
          operations: [
            { kind: 'character-update', characterId: 'char-a', fields: { description: '18歳' } },
          ],
          status: 'pending',
        },
      ],
    });
    apiMock.getRefineSession.mockResolvedValue(session);
    apiMock.applyRefinePatch.mockResolvedValue({ session, patch: session.patches[0] });
    renderTab({ session });

    expect(await screen.findByRole('button', { name: '調整を相談' })).toBeVisible();
    expect(screen.getByRole('button', { name: '見送る' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '反映する' }));
    await waitFor(() =>
      expect(apiMock.applyRefinePatch).toHaveBeenCalledWith(project.projectId, 'patch-1')
    );
  });

  it('labels diffs with 変更前 / 変更後 rather than color alone', async () => {
    const session = makeSession({
      messages: [
        {
          messageId: 'm-1',
          role: 'assistant',
          content: '候補',
          createdAt: '2026-07-28T00:00:00.000Z',
          patchIds: ['patch-1'],
        },
      ],
      patches: [
        {
          patchId: 'patch-1',
          createdAt: '2026-07-28T00:00:00.000Z',
          sourceMessageId: 'm-1',
          summary: '世界を更新',
          operations: [
            { kind: 'world-replace', op: { anchor: '停戦中', replacement: '交戦中' } },
          ],
          status: 'pending',
        },
      ],
    });
    renderTab({ session });

    expect(await screen.findByText('変更前')).toBeVisible();
    expect(screen.getByText('変更後')).toBeVisible();
  });
});
