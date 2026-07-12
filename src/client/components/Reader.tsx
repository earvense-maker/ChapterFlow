import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useTheme } from '../hooks/useTheme';
import { GeneratingLabel } from './GeneratingLabel';
import { KNOWLEDGE_WARN_CHARS } from '@shared/types';
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

export default function Reader({
  projectId,
  onBack,
  onOpenWorkSettings,
  onOpenTechSettings,
  onOpenMemories,
}: Props) {
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(18);
  const [selectedText, setSelectedText] = useState('');
  const [selectionButtonPosition, setSelectionButtonPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const storyStatePollInFlightRef = useRef(false);
  const initialWishPrefilledRef = useRef(false);
  const { choice: themeChoice, setChoice: setThemeChoice } = useTheme();

  async function load() {
    try {
      const state = await api.getReaderState(projectId);
      applyReaderState(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
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

  useEffect(() => {
    initialWishPrefilledRef.current = false;
    load();
  }, [projectId]);

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
    // NOTE: 生成失敗時に元の画面へ戻すためのスナップショット。ストリーミングは
    // 途中経過で text を上書きするが、エラー時の部分テキストはサーバーに保存されて
    // いないため、表示に残すと「見えているのに採用できない本文」になる。
    const previous = { text, generationId, status };
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      scrollReaderToTop();
      const shouldStream = project?.streamingEnabled ?? false;
      setGenerationId(null);
      setStatus(null);

      const record = shouldStream
        ? await api.generateStream(projectId, { wish: requestWish, mode }, (() => {
            let streamedText = '';
            setText('');
            return (chunk: string) => {
              streamedText += chunk;
              setText(streamedText);
            };
          })())
        : await api.generate(projectId, { wish: requestWish, mode });

      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
      setWish('');
      setRewriteWish('');
      setRewriteSheetOpen(false);
      try {
        await load();
      } catch {
        setNotice('生成は完了しましたが、場面情報の再読み込みに失敗しました');
      }
      inputRef.current?.focus();
    } catch (err) {
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
      setError(err instanceof Error ? err.message : '生成に失敗しました');
    } finally {
      setLoading(false);
    }
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
    if (!window.confirm('この場面の採用を取り消して下書きに戻しますか？')) return;
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

  async function handleRevert() {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const record = await api.revertGeneration(projectId);
      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : '復帰に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleNavigateScene(direction: SceneNavigationDirection) {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const state = await api.navigateScene(projectId, direction);
      applyReaderState(state);
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
      await api.createExpression(projectId, { text: selectedText, source: 'selection' });
      setNotice(`「${selectedText}」をNG表現に登録しました`);
      setTimeout(() => setNotice(null), 2000);
      setSelectionButtonPosition(null);
      setSelectedText('');
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  }

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
    if (!window.confirm('Yumeweaving を終了しますか？サーバーとターミナルも一緒に閉じます。')) return;
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
  const storyStateIsStale = storyStateRefresh?.status === 'stale' || storyStateBacklogCount > 0;
  const storyStateIsPending = storyStateRefresh?.status === 'pending';

  const draftIds = currentScene?.draftGenerationIds ?? [];
  const totalDrafts = draftIds.length;
  const currentDraftIndex = generationId ? draftIds.indexOf(generationId) : -1;
  const currentDraftLabel = currentDraftIndex >= 0 ? currentDraftIndex + 1 : null;
  const isCurrentAccepted = Boolean(
    currentScene?.acceptedGenerationId &&
      generationId &&
      currentScene.acceptedGenerationId === generationId
  );

  // NOTE: 前の案に戻す — 現在の draft が1件目より前 かつ 採用済みが存在しない場合は無効。
  const canRevert = totalDrafts > 1 && currentDraftIndex > 0;
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
            aria-label="メニュー"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
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
                🧠 記憶
              </button>
              <button
                className="reader-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenWorkSettings();
                }}
              >
                📖 作品設定
              </button>
              <button
                className="reader-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenTechSettings();
                }}
              >
                ⚙ 生成設定
              </button>
              <div className="reader-menu-row">
                <span className="reader-menu-label">表示テーマ</span>
                <div className="theme-toggle" role="radiogroup" aria-label="表示テーマ">
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
                    className={themeChoice === 'light' ? 'active' : ''}
                    onClick={() => setThemeChoice('light')}
                  >
                    ライト
                  </button>
                  <button
                    role="radio"
                    aria-checked={themeChoice === 'dark'}
                    className={themeChoice === 'dark' ? 'active' : ''}
                    onClick={() => setThemeChoice('dark')}
                  >
                    ダーク
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

      <div className="reader-subheader">
        {hasText && (
          <span
            className={`reader-status-badge ${isCurrentAccepted ? 'accepted' : isDraft ? 'draft' : 'other'}`}
          >
            {isCurrentAccepted ? '採' : isDraft ? '下' : '—'}
            {currentDraftLabel && totalDrafts > 0 && (
              <span className="reader-status-badge-count">
                {' '}案 {currentDraftLabel}/{totalDrafts}
              </span>
            )}
          </span>
        )}
        {navigation.currentSceneOrder && navigation.totalScenes > 0 && (
          <span className="reader-scene-position">
            場面 {navigation.currentSceneOrder}/{navigation.totalScenes}
          </span>
        )}
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

      <main className="reader-body">
        {error && <div className="error-toast">{error}</div>}
        {notice && <div className="status-toast">{notice}</div>}
        {(storyStateIsStale || storyStateIsPending) && (
          <div className={`story-state-alert ${storyStateIsStale ? 'stale' : 'pending'}`}>
            <div>
              <strong>
                {storyStateIsPending
                  ? '物語の状態を更新中です'
                  : storyStateBacklogCount > 0
                    ? `物語の状態: ${storyStateBacklogCount}場面未反映`
                    : '物語の状態を更新できませんでした'}
              </strong>
              <p>
                {storyStateIsPending
                  ? '採用済み本文から、次回生成で使う人物状態や伏線を整理しています。'
                  : storyStateBacklogCount > 0
                    ? '採用済み本文から、次回生成で使う人物状態や伏線を再抽出してください。'
                  : storyStateRefresh?.errorMessage ||
                    '採用済み本文から物語の状態を再抽出してください。'}
              </p>
            </div>
            {storyStateIsStale && (
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
            この表現をNGに登録
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
            <button onClick={handleRevert} disabled={loading || !canRevert}>
              前の案
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
          <input
            ref={inputRef}
            type="text"
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            placeholder="もっと不穏に、会話多めで、まだ告白しない…"
            disabled={loading}
          />
          <button type="submit" className="primary" disabled={loading}>
            {loading ? <GeneratingLabel /> : '生成'}
          </button>
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
                <button type="submit" className="primary" disabled={loading}>
                  {loading ? <GeneratingLabel /> : 'この指示で書き直す'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
