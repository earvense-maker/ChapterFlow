import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import type {
  ContextUsageEstimate,
  FrequencyReportItem,
  GenerationRecord,
  Project,
  ReaderNavigationState,
  ReaderState,
  SceneNavigationDirection,
  StoryStateRefreshStatus,
} from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenMemories: () => void;
}

export default function Reader({ projectId, onBack, onOpenSettings, onOpenMemories }: Props) {
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
  const [contextUsage, setContextUsage] = useState<ContextUsageEstimate | null>(null);
  const [contextSummaryExcerpt, setContextSummaryExcerpt] = useState('');
  const [storyStateRefresh, setStoryStateRefresh] = useState<StoryStateRefreshStatus | null>(null);
  const [wish, setWish] = useState('');
  const [rewriteWish, setRewriteWish] = useState('');
  const [showRewriteForm, setShowRewriteForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(18);
  const [showExpressionReport, setShowExpressionReport] = useState(false);
  const [expressionReport, setExpressionReport] = useState<FrequencyReportItem[]>([]);
  const [expressionReportLoading, setExpressionReportLoading] = useState(false);
  const [expressionReportError, setExpressionReportError] = useState<string | null>(null);
  const [selectedText, setSelectedText] = useState('');
  const [selectionButtonPosition, setSelectionButtonPosition] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const storyStatePollInFlightRef = useRef(false);

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
    setNavigation(state.navigation);
    setContextUsage(state.contextUsage);
    setContextSummaryExcerpt(state.contextSummaryExcerpt);
    setStoryStateRefresh(state.state.storyStateRefresh ?? null);
  }

  useEffect(() => {
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

  async function handleGenerate(
    mode: 'continue' | 'regenerate' | 'variate',
    requestWish = wish
  ) {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
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
      setShowRewriteForm(false);
      try {
        applyReaderState(await api.getReaderState(projectId));
      } catch {
        setNotice('生成は完了しましたが、場面情報の再読み込みに失敗しました');
      }
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function openRewriteForm() {
    setShowRewriteForm((open) => !open);
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

  async function handleReject() {
    if (!generationId) return;
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      await api.rejectGeneration(projectId, generationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '破棄に失敗しました');
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

  async function handleCompressContext() {
    try {
      setLoading(true);
      setError(null);
      setNotice(null);
      const result = await api.compressContext(projectId);
      setContextUsage(result.contextUsage);
      setContextSummaryExcerpt(result.summary.slice(0, 240));
      setNotice('過去本文を次回生成用に圧縮しました');
    } catch (err) {
      setError(err instanceof Error ? err.message : '過去本文の圧縮に失敗しました');
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

  async function handleToggleExpressionReport() {
    const next = !showExpressionReport;
    setShowExpressionReport(next);
    if (next) {
      await loadExpressionReport();
    }
  }

  async function loadExpressionReport() {
    try {
      setExpressionReportLoading(true);
      setExpressionReportError(null);
      const report = await api.getExpressionReport(projectId);
      setExpressionReport(report.phrases);
    } catch (err) {
      setExpressionReportError(err instanceof Error ? err.message : 'レポートの取得に失敗しました');
    } finally {
      setExpressionReportLoading(false);
    }
  }

  async function handleRegisterReportPhrase(text: string) {
    try {
      setLoading(true);
      setError(null);
      await api.createExpression(projectId, { text, source: 'report' });
      setNotice(`「${text}」をNG表現に登録しました`);
      setTimeout(() => setNotice(null), 2000);
      await loadExpressionReport();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setLoading(false);
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

  const isDraft = status === 'draft';
  const hasText = text.length > 0;
  const storyStateIsStale = storyStateRefresh?.status === 'stale';
  const storyStateIsPending = storyStateRefresh?.status === 'pending';
  const scenePosition =
    navigation.currentSceneOrder && navigation.totalScenes > 0
      ? `${navigation.currentSceneOrder} / ${navigation.totalScenes}`
      : '';

  return (
    <div className="reader">
      <header className="reader-header">
        <button onClick={onBack}>← 一覧</button>
        <h1>{project?.title || '読み込み中…'}</h1>
        <div className="reader-header-actions">
          <button
            onClick={() => handleNavigateScene('previous')}
            disabled={loading || !navigation.hasPreviousScene}
          >
            前の場面
          </button>
          <span className="scene-position">{scenePosition}</span>
          <button
            onClick={() => handleNavigateScene('next')}
            disabled={loading || !navigation.hasNextScene}
          >
            次の場面
          </button>
          <button onClick={() => adjustFontSize(-1)} title="文字を小さく">A-</button>
          <button onClick={() => adjustFontSize(1)} title="文字を大きく">A+</button>
          <button onClick={handleToggleExpressionReport}>
            {showExpressionReport ? 'レポートを閉じる' : '表現レポート'}
          </button>
          <button onClick={onOpenMemories}>記憶</button>
          <button onClick={onOpenSettings}>設定</button>
        </div>
      </header>

      <main className="reader-body">
        {error && <div className="error-toast">{error}</div>}
        {notice && <div className="status-toast">{notice}</div>}
        {(storyStateIsStale || storyStateIsPending) && (
          <div className={`story-state-alert ${storyStateIsStale ? 'stale' : 'pending'}`}>
            <div>
              <strong>
                {storyStateIsPending ? '物語の状態を更新中です' : '物語の状態を更新できませんでした'}
              </strong>
              <p>
                {storyStateIsPending
                  ? '採用済み本文から、次回生成で使う人物状態や伏線を整理しています。'
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

        {showExpressionReport && (
          <div className="expression-report-panel">
            <div className="expression-report-header">
              <h3>頻出表現レポート</h3>
              <button onClick={() => setShowExpressionReport(false)}>閉じる</button>
            </div>
            {expressionReportLoading && <p>読み込み中…</p>}
            {expressionReportError && <p className="error-toast">{expressionReportError}</p>}
            {!expressionReportLoading && expressionReport.length === 0 && (
              <p style={{ color: 'var(--text-muted)' }}>頻出表現は見つかりませんでした。</p>
            )}
            <ul className="expression-report-list">
              {expressionReport.map((item) => (
                <li key={item.text} className="expression-report-item">
                  <span className="expression-report-text">「{item.text}」</span>
                  <span className="expression-report-count">{item.count}回</span>
                  {item.isNg ? (
                    <span className="expression-report-badge">登録済み</span>
                  ) : (
                    <button
                      onClick={() => handleRegisterReportPhrase(item.text)}
                      disabled={loading}
                    >
                      NGに登録
                    </button>
                  )}
                </li>
              ))}
            </ul>
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
            {loading ? '生成中…' : hasText ? '続きを生成' : '最初の場面を生成'}
          </button>
        </form>

        {contextUsage && (
          <div className="context-panel">
            <div className="context-panel-main">
              <span>
                次回文脈: 推定 {formatTokenCount(contextUsage.estimatedPromptTokens + contextUsage.estimatedMaxOutputTokens)}
                {' / '}
                {formatTokenCount(contextUsage.contextWindowTokens)}
              </span>
              <span>残り {formatTokenCount(contextUsage.estimatedAvailableTokens)}</span>
              <span>
                上限 {tokenLimitSourceLabel(contextUsage.tokenLimitSource)} / 入力 {tokenCountSourceLabel(contextUsage.promptTokenSource)}
              </span>
              <span>
                要約 {contextUsage.summaryChars.toLocaleString()}字 / 直近 {contextUsage.recentContextChars.toLocaleString()}字
              </span>
            </div>
            <progress max={1} value={contextUsage.usageRatio} />
            <div className="context-panel-actions">
              <button type="button" onClick={handleCompressContext} disabled={loading || !hasText}>
                過去を圧縮
              </button>
              {contextSummaryExcerpt && <span>要約あり</span>}
            </div>
          </div>
        )}

        {hasText && showRewriteForm && (
          <form
            className="rewrite-input"
            onSubmit={(e) => {
              e.preventDefault();
              handleGenerate('regenerate', rewriteWish);
            }}
          >
            <label>
              書き直し指示
              <textarea
                ref={rewriteInputRef}
                value={rewriteWish}
                onChange={(e) => setRewriteWish(e.target.value)}
                placeholder="展開はそのまま心理描写を増やす、会話を多めにする、もっと静かな文体にする…"
                disabled={loading}
              />
            </label>
            <div className="rewrite-actions">
              <button type="submit" className="primary" disabled={loading}>
                この指示で書き直す
              </button>
              <button
                type="button"
                onClick={() => setShowRewriteForm(false)}
                disabled={loading}
              >
                閉じる
              </button>
            </div>
          </form>
        )}

        <div className="generation-actions">
          {hasText && (
            <>
              <button onClick={openRewriteForm} disabled={loading}>
                書き直す
              </button>
              <button onClick={() => handleGenerate('variate')} disabled={loading}>
                少し変える
              </button>
              <button onClick={handleRevert} disabled={loading}>
                前の案に戻す
              </button>
              {generationId && (
                <a
                  className="button-link"
                  href={api.generationMarkdownUrl(projectId, generationId)}
                  download
                >
                  MDを保存
                </a>
              )}
              {isDraft && (
                <>
                  <button className="primary" onClick={handleAccept} disabled={loading}>
                    この案を採用
                  </button>
                  <button className="danger" onClick={handleReject} disabled={loading}>
                    破棄
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="status-bar">
          {loading && (project?.streamingEnabled ?? false) && 'ストリーミング生成中です'}
          {status === 'draft' && 'この案は下書きです'}
          {status === 'accepted' && 'この場面は採用済みです'}
        </div>
      </footer>
    </div>
  );
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return value.toLocaleString();
}

function tokenLimitSourceLabel(source: ContextUsageEstimate['tokenLimitSource']): string {
  if (source === 'provider') return 'API取得';
  if (source === 'catalog') return '公式値';
  return '推定';
}

function tokenCountSourceLabel(source: ContextUsageEstimate['promptTokenSource']): string {
  return source === 'provider' ? 'API実測' : '推定';
}
