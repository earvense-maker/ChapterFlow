import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useTheme } from '../hooks/useTheme';
import { useConfirm } from './ConfirmDialog';
import { GeneratingLabel } from './GeneratingLabel';
import { GENERATION_WISH_MAX_CHARS, KNOWLEDGE_WARN_CHARS } from '@shared/types';
import type {
  ContextUsageEstimate,
  GenerationRecord,
  KnowledgeListItem,
  Project,
  ReaderNavigationState,
  ReaderState,
  SceneNavigationDirection,
  SceneRecord,
  StoryStateRefreshStatus,
} from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenWorkSettings: () => void;
  onOpenTechSettings: () => void;
  onOpenMemories: () => void;
}

// NOTE: 文脈警告バッジを出す使用率のしきい値。0.7=70%。
const CONTEXT_WARNING_THRESHOLD = 0.7;
const WISH_TEXTAREA_MAX_HEIGHT = 240;
const STORY_STATE_PENDING_GRACE_MS = 60_000;

function isDelayedStoryStatePending(updatedAt: string | undefined): boolean {
  if (!updatedAt) return true;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return true;
  return Date.now() - timestamp >= STORY_STATE_PENDING_GRACE_MS;
}

export default function Reader({
  projectId,
  onBack,
  onOpenWorkSettings,
  onOpenTechSettings,
  onOpenMemories,
}: Props) {
  const confirmAction = useConfirm();
  const [project, setProject] = useState<Project | null>(null);
  const [text, setText] = useState('');
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [status, setStatus] = useState<GenerationRecord['status'] | null>(null);
  const [navigation, setNavigation] = useState<ReaderNavigationState>({
    currentSceneOrder: null,
    totalScenes: 0,
    hasPreviousScene: false,
    hasNextScene: false,
  });
  const [currentScene, setCurrentScene] = useState<SceneRecord | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageEstimate | null>(null);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeListItem[]>([]);
  const [storyStateRefresh, setStoryStateRefresh] = useState<StoryStateRefreshStatus | null>(null);
  const [storyStateBacklogCount, setStoryStateBacklogCount] = useState(0);
  const [wish, setWish] = useState('');
  const [rewriteWish, setRewriteWish] = useState('');
  const [rewriteSheetOpen, setRewriteSheetOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isGeneratingStream, setIsGeneratingStream] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(18);
  const [selectedText, setSelectedText] = useState('');
  const [selectionButtonPosition, setSelectionButtonPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const generationAbortRef = useRef<AbortController | null>(null);
  const generationRunRef = useRef<symbol | null>(null);
  const projectIdRef = useRef(projectId);
  const loadRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const storyStatePollInFlightRef = useRef(false);
  const initialWishPrefilledRef = useRef(false);
  // NOTE: 場面切替で戻ってきたときにスクロール位置を復元するため、
  //       sceneId → window.scrollY をセッション中だけ覚えておく。
  const sceneScrollPositionsRef = useRef<Map<string, number>>(new Map());
  // NOTE: 次のレイアウト後に復元したい対象。currentScene のコミット後に読む。
  const pendingScrollRestoreRef = useRef<string | null>(null);
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();
  projectIdRef.current = projectId;

  async function load(): Promise<boolean> {
    const expectedProjectId = projectId;
    const requestId = ++loadRequestIdRef.current;
    try {
      const state = await api.getReaderState(expectedProjectId);
      if (
        !mountedRef.current ||
        projectIdRef.current !== expectedProjectId ||
        loadRequestIdRef.current !== requestId
      ) {
        return false;
      }
      applyReaderState(state);
      return true;
    } catch (err) {
      if (
        mountedRef.current &&
        projectIdRef.current === expectedProjectId &&
        loadRequestIdRef.current === requestId
      ) {
        setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      }
      return false;
    }
  }

  function applyReaderState(state: ReaderState) {
    setProject(state.project);
    setFontSize(state.state.uiState.fontSize);
    if (state.currentGeneration) {
      setText(state.currentGeneration.responseText);
      setGenerationId(state.currentGeneration.generationId);
      setStatus(state.currentGeneration.status);
    } else {
      setText('');
      setGenerationId(null);
      setStatus(null);
    }
    setCurrentScene(state.currentScene);
    setNavigation(state.navigation);
    setContextUsage(state.contextUsage);
    setKnowledgeItems(state.knowledgeFiles);
    setStoryStateRefresh(state.state.storyStateRefresh ?? null);
    setStoryStateBacklogCount(state.storyStateBacklogCount ?? state.state.storyStateBacklogCount ?? 0);
    if (
      !initialWishPrefilledRef.current &&
      state.state.lastAcceptedGenerationId === null &&
      state.project.firstWishSuggestion?.trim()
    ) {
      initialWishPrefilledRef.current = true;
      setWish((current) => (current.trim() ? current : state.project.firstWishSuggestion!.trim()));
    }
  }

  // NOTE: wish textarea を内容量に合わせて縦に伸ばす。少ない行数では CSS の min-height を使う。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, WISH_TEXTAREA_MAX_HEIGHT)}px`;
  }, [wish]);

  useEffect(() => {
    initialWishPrefilledRef.current = false;
    void load();
  }, [projectId]);

  useEffect(() => {
    setLoading(false);
    setIsGeneratingStream(false);
    generationAbortRef.current = null;
    generationRunRef.current = null;
    return () => {
      loadRequestIdRef.current += 1;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
      generationRunRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
      generationAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (storyStateRefresh?.status !== 'pending') return;
    const timer = window.setInterval(() => {
      if (storyStatePollInFlightRef.current) return;
      storyStatePollInFlightRef.current = true;
      void load().finally(() => {
        storyStatePollInFlightRef.current = false;
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [projectId, storyStateRefresh?.status]);

  // NOTE: メニューの外側クリックで閉じる。Escでも閉じる。
  useEffect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [menuOpen]);

  async function handleGenerate(
    mode: 'continue' | 'regenerate' | 'variate',
    requestWish = wish
  ) {
    if (generationRunRef.current) return;
    const runId = Symbol('generation');
    generationRunRef.current = runId;
    const releaseRun = () => {
      if (generationRunRef.current === runId) {
        generationRunRef.current = null;
      }
    };

    if (blocksGeneration) {
      releaseRun();
      return;
    }

    if (needsStoryStateConfirmation) {
      const confirmed = await confirmAction(
        '物語の状態に未反映の場面があります。\nこのまま生成すると、直前の出来事や人物の知識状態が反映されないことがあります。\n先に画面上部の「再抽出」を実行することをおすすめします。',
        { confirmLabel: 'このまま生成', cancelLabel: '戻る' }
      );
      if (!confirmed) {
        releaseRun();
        return;
      }
    }

    // NOTE: 生成失敗時に元の画面へ戻すためのスナップショット。ストリーミングは
    // 途中経過で text を上書きするが、エラー時の部分テキストはサーバーに保存されて
    // いないため、表示に残すと「見えているのに採用できない本文」になる。
    const previous = { text, generationId, status };
    const generationProjectId = projectId;
    let abortController: AbortController | null = null;
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      scrollReaderToTop();
      const shouldStream = project?.streamingEnabled ?? false;
      if (shouldStream) {
        abortController = new AbortController();
        generationAbortRef.current = abortController;
        setIsGeneratingStream(true);
      }
      setGenerationId(null);
      setStatus(null);

      const record = shouldStream
        ? await api.generateStream(
            projectId,
            { wish: requestWish, mode },
            (() => {
              let streamedText = '';
              setText('');
              return (chunk: string) => {
                if (
                  !mountedRef.current ||
                  generationRunRef.current !== runId ||
                  projectIdRef.current !== generationProjectId
                ) {
                  return;
                }
                streamedText += chunk;
                setText(streamedText);
              };
            })(),
            abortController?.signal
          )
        : await api.generate(projectId, { wish: requestWish, mode });

      if (
        !mountedRef.current ||
        generationRunRef.current !== runId ||
        projectIdRef.current !== generationProjectId
      ) {
        return;
      }
      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
      setWish('');
      setRewriteWish('');
      setRewriteSheetOpen(false);
      if (!(await load())) {
        setNotice('生成は完了しましたが、場面情報の再読み込みに失敗しました');
      } else if (record.finishReason === 'length') {
        setNotice(
          'モデルの出力上限に達したため、本文が途中で終わった可能性があります。内容を確認して採用または再生成してください'
        );
      }
      inputRef.current?.focus();
    } catch (err) {
      if (
        !mountedRef.current ||
        generationRunRef.current !== runId ||
        projectIdRef.current !== generationProjectId
      ) {
        return;
      }
      // 未保存の部分テキストを消して生成前の表示へ戻し、指示を入力欄に復元して
      // そのまま再生成できるようにする。
      setText(previous.text);
      setGenerationId(previous.generationId);
      setStatus(previous.status);
      if (mode === 'continue') {
        setWish(requestWish);
      } else {
        setRewriteWish(requestWish);
      }
      if (abortController?.signal.aborted) {
        setNotice('生成を停止しました');
      } else {
        setError(err instanceof Error ? err.message : '生成に失敗しました');
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
      releaseRun();
      if (mountedRef.current && projectIdRef.current === generationProjectId) {
        setIsGeneratingStream(false);
        setLoading(false);
      }
    }
  }

  function handleStopGeneration() {
    generationAbortRef.current?.abort();
  }

  function scrollReaderToTop() {
    window.requestAnimationFrame(() => {
      const reduceMotion =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  }

  function openRewriteSheet() {
    setRewriteSheetOpen(true);
    setTimeout(() => rewriteInputRef.current?.focus(), 0);
  }

  async function handleAccept() {
    if (!generationId) return;
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      await api.acceptGeneration(projectId, generationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '採用に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleUnaccept() {
    if (
      !(await confirmAction('この場面の採用を取り消して下書きに戻しますか？', {
        confirmLabel: '採用を取り消す',
      }))
    ) return;
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      await api.unacceptCurrentScene(projectId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '採用取消に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleNavigateDraft(direction: SceneNavigationDirection) {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const record = await api.navigateDraft(projectId, direction);
      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : '案の移動に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleNavigateScene(direction: SceneNavigationDirection) {
    const outgoingSceneId = currentScene?.sceneId ?? null;
    if (outgoingSceneId) {
      sceneScrollPositionsRef.current.set(outgoingSceneId, window.scrollY);
    }
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const state = await api.navigateScene(projectId, direction);
      applyReaderState(state);
      const incomingSceneId = state.currentScene?.sceneId ?? null;
      // NOTE: React が新しい本文をコミット・ペイントし終えるまで待ってから
      //       復元しないと、旧DOMの高さで scrollTo がクランプされてしまう。
      pendingScrollRestoreRef.current = incomingSceneId;
    } catch (err) {
      setError(err instanceof Error ? err.message : '場面移動に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshStoryState() {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const state = await api.refreshStoryState(projectId);
      applyReaderState(state);
      const nextStatus = state.state.storyStateRefresh?.status;
      setNotice(
        nextStatus === 'fresh'
          ? '物語の状態を再抽出しました'
          : '物語の状態を再抽出できませんでした'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '物語の状態再抽出に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function adjustFontSize(delta: number) {
    const next = Math.max(12, Math.min(32, fontSize + delta));
    setFontSize(next);
    try {
      await api.updateState(projectId, { uiState: { readingPosition: 0, fontSize: next } });
    } catch {
      // 状態保存失敗は無視して、画面上のサイズは保持
    }
  }

  function handleTextSelected() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      setSelectionButtonPosition(null);
      return;
    }
    const text = selection.toString().trim();
    if (text.length < 1 || text.length > 30) {
      setSelectionButtonPosition(null);
      return;
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setSelectedText(text);
    setSelectionButtonPosition({
      top: rect.bottom + 4,
      left: rect.left,
    });
  }

  async function handleRegisterSelectedExpression() {
    if (!selectedText) return;
    try {
      setLoading(true);
      setError(null);
      await api.createGlobalExpression({ text: selectedText, source: 'selection' });
      setNotice(`「${selectedText}」を共通NG表現に登録しました`);
      setTimeout(() => setNotice(null), 2000);
      setSelectionButtonPosition(null);
      setSelectedText('');
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : '共通NG表現の登録に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  // NOTE: 新しい本文がコミットされ、DOM の高さが更新されてから
  //       保存済みスクロール位置を復元する。useLayoutEffect にすることで
  //       ペイント前に scrollTo が入り、ちらつきを防ぐ。
  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current;
    if (pending === null) return;
    pendingScrollRestoreRef.current = null;
    const target = sceneScrollPositionsRef.current.get(pending) ?? 0;
    window.scrollTo({ top: target, behavior: 'auto' });
  }, [currentScene?.sceneId, text]);

  // NOTE: wish textarea を内容量に合わせて縦に伸ばす。scrollHeight は
  //       min-height を尊重するため、行数が少ないうちは CSS の min-height が効く。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, WISH_TEXTAREA_MAX_HEIGHT)}px`;
  }, [wish]);

  useEffect(() => {
    function handleSelectionChange() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionButtonPosition(null);
        setSelectedText('');
      }
    }
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  async function handleShutdown() {
    try {
      await api.shutdown();
    } catch {
      // サーバーは即座に応答して自プロセスを落とすため、ネットワーク断で例外になっても正常系。
    }
    setTimeout(() => {
      window.close();
      setNotice('サーバーを停止しました。このウィンドウを閉じてください。');
    }, 300);
  }

  const isDraft = status === 'draft';
  const hasText = text.length > 0;
  const storyStateIsPending = storyStateRefresh?.status === 'pending';
  const isDelayedPending =
    storyStateIsPending && isDelayedStoryStatePending(storyStateRefresh?.updatedAt);
  const blocksGeneration = storyStateIsPending && !isDelayedPending;
  const needsStoryStateConfirmation =
    isDelayedPending ||
    (!storyStateIsPending &&
      (storyStateRefresh?.status === 'stale' || storyStateBacklogCount > 0));
  const canRetryExtraction = !storyStateIsPending || isDelayedPending;
  const storyStateIsStale =
    !blocksGeneration &&
    (isDelayedPending || storyStateRefresh?.status === 'stale' || storyStateBacklogCount > 0);
  const storyStateNeedsAttention = storyStateIsPending || storyStateIsStale;

  const draftIds = currentScene?.draftGenerationIds ?? [];
  const totalDrafts = draftIds.length;
  const currentDraftIndex = generationId ? draftIds.indexOf(generationId) : -1;
  const currentDraftLabel = currentDraftIndex >= 0 ? currentDraftIndex + 1 : null;
  const isCurrentAccepted = Boolean(
    currentScene?.acceptedGenerationId &&
      generationId &&
      currentScene.acceptedGenerationId === generationId
  );

  // NOTE: 案の移動は同じ場面の draft 配列内だけで行い、採用状態には触れない。
  const canNavigatePreviousDraft = totalDrafts > 1 && currentDraftIndex > 0;
  const canNavigateNextDraft =
    totalDrafts > 1 && currentDraftIndex >= 0 && currentDraftIndex < totalDrafts - 1;
  // NOTE: 文脈使用率が閾値超えのときのみ、ヘッダー付近に警告バッジを出す。
  const contextWarn =
    contextUsage && contextUsage.usageRatio >= CONTEXT_WARNING_THRESHOLD
      ? Math.round(contextUsage.usageRatio * 100)
      : null;
  const enabledKnowledge = knowledgeItems.filter(
    (item) => item.enabled && item.contentStatus === 'ok'
  );
  const enabledKnowledgeChars = enabledKnowledge.reduce((sum, item) => sum + item.charCount, 0);
  const brokenEnabledKnowledgeCount = knowledgeItems.filter(
    (item) => item.enabled && item.contentStatus !== 'ok'
  ).length;
  const knowledgeSummary =
    enabledKnowledge.length > 0
      ? `参考資料: ${enabledKnowledge
          .slice(0, 2)
          .map((item) => item.title)
          .join('・')}${enabledKnowledge.length > 2 ? ` 他${enabledKnowledge.length - 2}件` : ''}（計${enabledKnowledgeChars.toLocaleString()}字）`
      : '';

  return (
    <div className="reader">
      <header className="reader-header">
        <button className="reader-back" onClick={onBack}>
          ← 一覧
        </button>
        <h1>{project?.title || '読み込み中…'}</h1>
        <div className="scene-nav">
          {hasText && (
            <span
              className={`reader-status-badge ${isCurrentAccepted ? 'accepted' : isDraft ? 'draft' : 'other'}`}
            >
              {isCurrentAccepted ? '採' : isDraft ? '下' : '—'}
              {currentDraftLabel && totalDrafts > 0 && (
                <span className="reader-status-badge-count">
                  案 {currentDraftLabel}/{totalDrafts}
                </span>
              )}
            </span>
          )}
          {navigation.currentSceneOrder && navigation.totalScenes > 0 && (
            <span className="reader-scene-position">
              場面 {navigation.currentSceneOrder}/{navigation.totalScenes}
            </span>
          )}
          <button
            aria-label="前の場面"
            onClick={() => handleNavigateScene('previous')}
            disabled={loading || !navigation.hasPreviousScene}
          >
            ‹ 前
          </button>
          <button
            aria-label="次の場面"
            onClick={() => handleNavigateScene('next')}
            disabled={loading || !navigation.hasNextScene}
          >
            次 ›
          </button>
        </div>
        <div className="reader-menu-wrap" ref={menuRef}>
          <button
            className="reader-menu-toggle"
            aria-label={menuOpen ? 'オプションを閉じる' : 'オプションを開く'}
            aria-expanded={menuOpen}
            title="オプション"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <GearIcon />
          </button>
          {menuOpen && (
            <div className="reader-menu" role="menu">
              <div className="reader-menu-row reader-menu-row-fontsize">
                <span className="reader-menu-label">文字サイズ</span>
                <div className="reader-menu-fontsize-buttons">
                  <button onClick={() => adjustFontSize(-1)} aria-label="小さく">A-</button>
                  <button onClick={() => adjustFontSize(1)} aria-label="大きく">A+</button>
                </div>
              </div>
              <button
                className="reader-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenMemories();
                }}
              >
                記憶
              </button>
              <button
                className="reader-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenWorkSettings();
                }}
              >
                作品設定
              </button>
              <button
                className="reader-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenTechSettings();
                }}
              >
                生成設定
              </button>
              <div className="reader-menu-row">
                <span className="reader-menu-label">テーマ</span>
                <div className="theme-toggle" role="radiogroup" aria-label="テーマ">
                  <button
                    role="radio"
                    aria-checked={themeChoice === 'auto'}
                    className={themeChoice === 'auto' ? 'active' : ''}
                    onClick={() => setThemeChoice('auto')}
                  >
                    自動
                  </button>
                  <button
                    role="radio"
                    aria-checked={themeChoice === 'light'}
                    aria-label="ライト"
                    title="ライト"
                    className={themeChoice === 'light' ? 'active' : ''}
                    onClick={() => setThemeChoice('light')}
                  >
                    <SunIcon />
                  </button>
                  <button
                    role="radio"
                    aria-checked={themeChoice === 'dark'}
                    aria-label="ダーク"
                    title="ダーク"
                    className={themeChoice === 'dark' ? 'active' : ''}
                    onClick={() => setThemeChoice('dark')}
                  >
                    <MoonIcon />
                  </button>
                </div>
              </div>
              <button
                className="reader-menu-item reader-menu-shutdown danger"
                onClick={() => {
                  setMenuOpen(false);
                  handleShutdown();
                }}
              >
                サーバー終了
              </button>
            </div>
          )}
        </div>
      </header>

      {(contextWarn !== null || knowledgeSummary || brokenEnabledKnowledgeCount > 0) && (
        <div className="reader-subheader">
          {contextWarn !== null && (
            <span className="reader-context-badge" title="次回生成の文脈使用率">
              ⚠ 文脈 {contextWarn}%
            </span>
          )}
          {knowledgeSummary && (
            <span
              className={`reader-knowledge-badge ${enabledKnowledgeChars > KNOWLEDGE_WARN_CHARS ? 'warn' : ''}`}
              title={knowledgeSummary}
            >
              {knowledgeSummary}
            </span>
          )}
          {brokenEnabledKnowledgeCount > 0 && (
            <span className="reader-knowledge-badge warn">
              {brokenEnabledKnowledgeCount}件は本文がなく注入されません
            </span>
          )}
        </div>
      )}

      <main className="reader-body">
        {error && <div className="error-toast">{error}</div>}
        {notice && (
          <div className="status-toast" role="status" aria-live="polite">
            {notice}
          </div>
        )}
        {storyStateNeedsAttention && (
          <div className={`story-state-alert ${storyStateIsStale ? 'stale' : 'pending'}`}>
            <div>
              <strong>
                {blocksGeneration
                  ? '続きに反映する情報を整理しています'
                  : isDelayedPending
                    ? '物語の状態整理に時間がかかっています'
                  : storyStateBacklogCount > 0
                    ? `物語の状態: ${storyStateBacklogCount}場面未反映`
                    : '物語の状態を更新できませんでした'}
              </strong>
              <p>
                {blocksGeneration
                  ? '採用した場面から人物の状況や伏線を読み取り、次の場面に反映する準備をしています。'
                  : isDelayedPending
                    ? '処理が続いている可能性があります。再抽出するか、未反映であることを確認して生成できます。'
                  : storyStateBacklogCount > 0
                    ? '採用済み本文から、次回生成で使う人物状態や伏線を再抽出してください。'
                    : storyStateRefresh?.errorMessage ||
                      '採用済み本文から物語の状態を再抽出してください。'}
              </p>
            </div>
            {canRetryExtraction && (
              <button type="button" onClick={handleRefreshStoryState} disabled={loading}>
                再抽出
              </button>
            )}
          </div>
        )}

        {selectionButtonPosition && (
          <button
            className="ng-expression-float-button"
            style={{
              position: 'fixed',
              top: selectionButtonPosition.top,
              left: selectionButtonPosition.left,
            }}
            onClick={handleRegisterSelectedExpression}
            disabled={loading}
          >
            共通NGに登録
          </button>
        )}

        {hasText ? (
          <article
            ref={textRef}
            className="reader-text"
            style={{ fontSize: `${fontSize}px` }}
            onMouseUp={handleTextSelected}
          >
            {text}
          </article>
        ) : (
          <div className="reader-empty">
            <p>まだ本文がありません。下の欄に短い希望を入れて、続きを生成してください。</p>
          </div>
        )}
      </main>

      <footer className="reader-controls">
        {hasText && isDraft && (
          <div className="draft-actions">
            <button className="primary" onClick={handleAccept} disabled={loading}>
              この案を採用
            </button>
            <button onClick={openRewriteSheet} disabled={loading}>
              書き直す
            </button>
          </div>
        )}
        {hasText && currentDraftIndex >= 0 && totalDrafts > 1 && (
          <div className="draft-actions">
            <button
              onClick={() => void handleNavigateDraft('previous')}
              disabled={loading || !canNavigatePreviousDraft}
            >
              前の案
            </button>
            <button
              onClick={() => void handleNavigateDraft('next')}
              disabled={loading || !canNavigateNextDraft}
            >
              次の案
            </button>
          </div>
        )}
        {hasText && isCurrentAccepted && (
          <div className="accepted-actions">
            <button onClick={handleUnaccept} disabled={loading}>
              採用取消
            </button>
          </div>
        )}
        <form
          className="wish-input"
          onSubmit={(e) => {
            e.preventDefault();
            handleGenerate('continue');
          }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            maxLength={GENERATION_WISH_MAX_CHARS}
            onKeyDown={(e) => {
              // NOTE: Ctrl/Cmd+Enter=送信 / 素の Enter=改行。IME 変換中は無視。
              if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.metaKey) &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!loading) handleGenerate('continue');
              }
            }}
            placeholder="次のシーンへの指示（Ctrl+Enterで送信）"
            disabled={loading}
          />
          {isGeneratingStream ? (
            <button type="button" className="danger" onClick={handleStopGeneration}>
              生成を停止
            </button>
          ) : (
            <button type="submit" className="primary" disabled={loading || blocksGeneration}>
              {loading ? <GeneratingLabel /> : '生成'}
            </button>
          )}
        </form>
      </footer>

      {rewriteSheetOpen && (
        <div
          className="bottom-sheet-overlay"
          onMouseDown={() => setRewriteSheetOpen(false)}
        >
          <div
            className="bottom-sheet"
            role="dialog"
            aria-label="書き直し指示"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="bottom-sheet-handle" />
            <h3>書き直し指示</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleGenerate('regenerate', rewriteWish);
              }}
            >
              <textarea
                ref={rewriteInputRef}
                value={rewriteWish}
                onChange={(e) => setRewriteWish(e.target.value)}
                maxLength={GENERATION_WISH_MAX_CHARS}
                placeholder="展開はそのまま心理描写を増やす、会話を多めにする、もっと静かな文体にする…"
                disabled={loading}
              />
              <div className="bottom-sheet-actions">
                <button
                  type="button"
                  onClick={() => setRewriteSheetOpen(false)}
                  disabled={loading}
                >
                  閉じる
                </button>
                {isGeneratingStream ? (
                  <button type="button" className="danger" onClick={handleStopGeneration}>
                    生成を停止
                  </button>
                ) : (
                  <button type="submit" className="primary" disabled={loading || blocksGeneration}>
                    {loading ? <GeneratingLabel /> : 'この指示で書き直す'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg className="reader-menu-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.97 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.97 4.6 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15.03 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg className="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 15.3A8.5 8.5 0 0 1 8.7 3.5 8.5 8.5 0 1 0 20.5 15.3Z" />
    </svg>
  );
}
