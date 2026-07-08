import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../clientApi';
import { GeneratingLabel } from './GeneratingLabel';
import SetupCommitReview from './setup/SetupCommitReview';
import type {
  CharacterRole,
  ModelProviderInfo,
  SetupCommitPlan,
  SetupDraft,
  SetupDraftCandidate,
  SetupDraftCharacter,
  SetupDraftTextItem,
  SetupDraftUndecided,
  SetupLock,
  SetupSession,
  SetupSessionSummary,
  SetupSuggestedAction,
} from '@shared/types';

interface Props {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}

type StringDraftSection = 'relationshipSeeds' | 'world' | 'tone' | 'ng' | 'openingSeeds';

interface PendingDescriptor {
  id: string;
}

const SETUP_SESSION_STORAGE_KEY = 'yumeweaving:lastSetupSessionId';

const DEFAULT_PROJECT_SETTINGS = {
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: {
    genre: 'modern-drama',
    style: 'natural-dialogue',
    pov: 'third-person-close',
    pacing: 'standard',
    density: 'balanced',
    relationshipPacing: 'standard',
  },
};

const ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主人公',
  deuteragonist: '相手役',
  supporting: '脇役',
  other: 'その他',
};

export default function SetupWorkspace({ onCreated, onCancel, onOpenSettings }: Props) {
  const [session, setSession] = useState<SetupSession | null>(null);
  const [message, setMessage] = useState('');
  const [suggestedActions, setSuggestedActions] = useState<SetupSuggestedAction[]>([]);
  const [previewText, setPreviewText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [creatingNew, setCreatingNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [reviewPlan, setReviewPlan] = useState<SetupCommitPlan | null>(null);
  const [dirtyDraftEditKeys, setDirtyDraftEditKeys] = useState<Set<string>>(() => new Set());
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const sendAbortController = useRef<AbortController | null>(null);
  const pendingIdCounter = useRef(0);
  const [pendingConfirmed, setPendingConfirmed] = useState<PendingDescriptor[]>([]);
  const [pendingUndecided, setPendingUndecided] = useState<PendingDescriptor[]>([]);
  const [pendingCandidates, setPendingCandidates] = useState<PendingDescriptor[]>([]);
  const [pendingCharacters, setPendingCharacters] = useState<PendingDescriptor[]>([]);
  const [pendingStrings, setPendingStrings] = useState<Record<StringDraftSection, PendingDescriptor[]>>({
    world: [],
    relationshipSeeds: [],
    tone: [],
    ng: [],
    openingSeeds: [],
  });
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [historySessions, setHistorySessions] = useState<SetupSessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [modelNameDraft, setModelNameDraft] = useState('');

  const currentProviderMissingKey = useMemo(() => {
    if (!session) return false;
    const provider = providers.find((p) => p.name === session.model.provider);
    return provider ? provider.hasApiKey === false : false;
  }, [session, providers]);

  function generatePendingId(): string {
    pendingIdCounter.current += 1;
    return `pending-${pendingIdCounter.current}`;
  }

  function addPendingConfirmed() {
    setPendingConfirmed((current) => [...current, { id: generatePendingId() }]);
  }

  function removePendingConfirmed(id: string) {
    setPendingConfirmed((current) => current.filter((entry) => entry.id !== id));
  }

  function addPendingUndecided() {
    setPendingUndecided((current) => [...current, { id: generatePendingId() }]);
  }

  function removePendingUndecided(id: string) {
    setPendingUndecided((current) => current.filter((entry) => entry.id !== id));
  }

  function addPendingCandidate() {
    setPendingCandidates((current) => [...current, { id: generatePendingId() }]);
  }

  function removePendingCandidate(id: string) {
    setPendingCandidates((current) => current.filter((entry) => entry.id !== id));
  }

  function addPendingCharacter() {
    setPendingCharacters((current) => [...current, { id: generatePendingId() }]);
  }

  function removePendingCharacter(id: string) {
    setPendingCharacters((current) => current.filter((entry) => entry.id !== id));
  }

  function addPendingString(section: StringDraftSection) {
    setPendingStrings((current) => ({
      ...current,
      [section]: [...current[section], { id: generatePendingId() }],
    }));
  }

  function removePendingString(section: StringDraftSection, id: string) {
    setPendingStrings((current) => ({
      ...current,
      [section]: current[section].filter((entry) => entry.id !== id),
    }));
  }

  function toggleCandidateSelection(id: string) {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  async function sendMixedCandidates() {
    if (!draft) return;
    const selected = draft.candidates
      .filter((candidate) => candidate.status === 'active' && selectedCandidateIds.has(candidate.id))
      .map((candidate) => candidate.title)
      .filter(Boolean);
    if (selected.length < 2) return;
    const titleList = selected.join('」と「');
    await send(`候補「${titleList}」を混ぜた方向にしたい。`);
    setSelectedCandidateIds(new Set());
  }

  useEffect(() => {
    let ignore = false;

    async function loadSession() {
      try {
        setLoading(true);
        setError(null);
        const restored = await findRestorableSetupSession();
        if (ignore) return;

        if (restored) {
          setSession(restored);
          setDirtyDraftEditKeys(new Set());
          rememberSetupSession(restored.sessionId);
          setSuggestedActions([]);
          return;
        }

        const result = await createDefaultSetupSession();
        if (ignore) return;
        setSession(result.session);
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(result.sessionId);
        setSuggestedActions(result.suggestedActions);
      } catch (err) {
        if (!ignore) setError(err instanceof Error ? err.message : '相談セッションの作成に失敗しました');
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    loadSession();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    async function loadProviders() {
      try {
        setProvidersLoading(true);
        const result = await api.getModelProviders();
        if (ignore) return;
        setProviders(result);
      } catch {
        if (!ignore) setProviders([]);
      } finally {
        if (!ignore) setProvidersLoading(false);
      }
    }
    loadProviders();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    setModelNameDraft(session?.model.modelName ?? '');
  }, [session?.sessionId, session?.model.modelName]);

  const draft = session?.draft;
  const busy = sending || savingDraft || previewing || committing || creatingNew || Boolean(reviewPlan);
  const hasUnsavedDraftEdits = dirtyDraftEditKeys.size > 0;

  const markDraftDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyDraftEditKeys((current) => {
      if (current.has(key) === dirty) return current;
      const next = new Set(current);
      if (dirty) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  async function startNewSession() {
    if ((session?.messages.length || hasUnsavedDraftEdits) && !window.confirm('今の相談を閉じて、新しく始めますか？')) return;
    try {
      setCreatingNew(true);
      setError(null);
      setPreviewText('');
      if (session?.status === 'active') {
        await api.abandonSetupSession(session.sessionId).catch(() => undefined);
      }
      const result = await createDefaultSetupSession(providers);
      setSession(result.session);
      setDirtyDraftEditKeys(new Set());
      setPendingConfirmed([]);
      setPendingUndecided([]);
      setPendingCandidates([]);
      setPendingCharacters([]);
      setPendingStrings({
        world: [],
        relationshipSeeds: [],
        tone: [],
        ng: [],
        openingSeeds: [],
      });
      setSelectedCandidateIds(new Set());
      rememberSetupSession(result.sessionId);
      setSuggestedActions(result.suggestedActions);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '新しい相談を作れませんでした');
    } finally {
      setCreatingNew(false);
    }
  }

  async function loadHistory() {
    try {
      setHistoryLoading(true);
      const sessions = await api.listSetupSessions();
      setHistorySessions(sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : '相談履歴の読み込みに失敗しました');
    } finally {
      setHistoryLoading(false);
    }
  }

  function openHistory() {
    setShowHistory(true);
    void loadHistory();
  }

  async function resumeSession(sessionId: string) {
    try {
      setLoading(true);
      setError(null);
      const resumed = await api.getSetupSession(sessionId);
      if (resumed.status !== 'active') {
        setError('この相談は再開できません。');
        return;
      }
      setSession(resumed);
      setDirtyDraftEditKeys(new Set());
      rememberSetupSession(resumed.sessionId);
      setSuggestedActions([]);
      setPreviewText('');
      setShowHistory(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '相談の再開に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function deleteHistorySession(sessionId: string) {
    if (!window.confirm('この相談履歴を削除しますか？')) return;
    try {
      await api.deleteSetupSession(sessionId);
      setHistorySessions((current) => current.filter((s) => s.sessionId !== sessionId));
      if (session?.sessionId === sessionId) {
        forgetSetupSession(sessionId);
        const result = await createDefaultSetupSession(providers);
        setSession(result.session);
        setDirtyDraftEditKeys(new Set());
        setPendingConfirmed([]);
        setPendingUndecided([]);
        setPendingCandidates([]);
        setPendingCharacters([]);
        setPendingStrings({
          world: [],
          relationshipSeeds: [],
          tone: [],
          ng: [],
          openingSeeds: [],
        });
        setSelectedCandidateIds(new Set());
        rememberSetupSession(result.sessionId);
        setSuggestedActions(result.suggestedActions);
        setMessage('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '相談履歴の削除に失敗しました');
      await loadHistory();
    }
  }

  async function handleProviderChange(providerName: string) {
    if (!session || busy) return;
    const provider = providers.find((p) => p.name === providerName);
    if (!provider) return;
    try {
      setSavingDraft(true);
      setError(null);
      const result = await api.patchSetupSettings(session.sessionId, {
        model: { provider: providerName, modelName: provider.defaultModel },
        revision: session.revision,
      });
      setSession(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'モデル設定の更新に失敗しました');
      await reloadLatestSession(session.sessionId);
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleModelNameChange(modelName: string) {
    if (!session || busy) return;
    const trimmed = modelName.trim();
    if (!trimmed || trimmed === session.model.modelName) {
      setModelNameDraft(session.model.modelName);
      return;
    }
    try {
      setSavingDraft(true);
      setError(null);
      const result = await api.patchSetupSettings(session.sessionId, {
        model: { provider: session.model.provider, modelName: trimmed },
        revision: session.revision,
      });
      setSession(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'モデル設定の更新に失敗しました');
      await reloadLatestSession(session.sessionId);
    } finally {
      setSavingDraft(false);
    }
  }

  async function send(text: string) {
    if (!session || sending || committing) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから相談を続けてください。');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    setSending(true);
    setIsStreaming(false);
    setError(null);
    setPreviewText('');
    setStreamingMessage('');
    const abortController = new AbortController();
    sendAbortController.current = abortController;

    try {
      await api.sendSetupMessageStream(
        session.sessionId,
        { message: trimmed, revision: session.revision },
        {
          onDelta: (delta) => {
            setIsStreaming(true);
            setStreamingMessage((current) => current + delta);
          },
          onResult: (response) => {
            setSession(response.session);
            setDirtyDraftEditKeys(new Set());
            rememberSetupSession(response.session.sessionId);
            setSuggestedActions(response.suggestedActions);
            setMessage('');
            setStreamingMessage('');
            setShowRetry(false);
          },
          onError: (payload) => {
            throw new Error(payload.error || '相談処理に失敗しました');
          },
        },
        abortController.signal
      );
    } catch (err) {
      if (abortController.signal.aborted) {
        setShowRetry(true);
        setStreamingMessage('');
        sendAbortController.current = null;
        setIsStreaming(false);
        setSending(false);
        return;
      }

      try {
        let latest: SetupSession | null = null;
        try {
          latest = await api.getSetupSession(session.sessionId);
        } catch {
          // NOTE: 取得失敗時はlatest=nullのまま進み、下の分岐で通常送信フォールバックに落とす
        }
        const result =
          latest &&
          latest.revision > session.revision &&
          latest.messages[latest.messages.length - 1]?.role === 'user'
            ? await api.retrySetupMessage(session.sessionId, {})
            : await api.sendSetupMessage(session.sessionId, {
                message: trimmed,
                revision: session.revision,
              });
        setSession(result.session);
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(result.session.sessionId);
        setSuggestedActions(result.suggestedActions);
        setMessage('');
        setShowRetry(false);
        setStreamingMessage('');
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : '送信に失敗しました');
        const latest = await reloadLatestSession(session.sessionId);
        const lastMessage = latest?.messages[latest.messages.length - 1];
        setShowRetry(lastMessage?.role === 'user');
        setStreamingMessage('');
      }
    } finally {
      sendAbortController.current = null;
      setIsStreaming(false);
      setSending(false);
    }
  }

  function abortStreaming() {
    sendAbortController.current?.abort();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await send(message);
  }

  async function retry() {
    if (!session || sending || committing) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから再試行してください。');
      return;
    }
    try {
      setSending(true);
      setError(null);
      setPreviewText('');
      const result = await api.retrySetupMessage(session.sessionId, {});
      setSession(result.session);
      setDirtyDraftEditKeys(new Set());
      rememberSetupSession(result.session.sessionId);
      setSuggestedActions(result.suggestedActions);
      setShowRetry(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '再試行に失敗しました');
      const latest = await reloadLatestSession(session.sessionId);
      const lastMessage = latest?.messages[latest.messages.length - 1];
      setShowRetry(lastMessage?.role === 'user');
    } finally {
      setSending(false);
    }
  }

  async function handlePreview() {
    if (!session || previewing) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから試し書きしてください。');
      return;
    }
    try {
      setPreviewing(true);
      setError(null);
      const result = await api.previewSetup(session.sessionId);
      setSession(result.session);
      rememberSetupSession(result.session.sessionId);
      setPreviewText(result.previewText);
    } catch (err) {
      setError(err instanceof Error ? err.message : '試し書きに失敗しました');
    } finally {
      setPreviewing(false);
    }
  }

  async function regenerateStyleSample(instruction: string): Promise<string> {
    if (!session) throw new Error('相談セッションが見つかりません');
    const result = await api.previewSetup(session.sessionId, instruction);
    setSession(result.session);
    rememberSetupSession(result.session.sessionId);
    setPreviewText(result.previewText);
    return result.previewText;
  }

  async function handleCommit() {
    if (!session || committing) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから作品化してください。');
      return;
    }
    try {
      setCommitting(true);
      setError(null);
      const result = await api.createSetupCommitPlan(session.sessionId);
      setSession(result.session);
      rememberSetupSession(result.session.sessionId);
      setReviewPlan(result.plan);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作品化準備に失敗しました');
    } finally {
      setCommitting(false);
    }
  }

  async function commitFromReview(plan: SetupCommitPlan) {
    if (!session || committing) return;
    try {
      setCommitting(true);
      setError(null);
      const result = await api.commitSetup(session.sessionId, {
        plan,
        revision: session.revision,
      });
      setSession(result.session);
      forgetSetupSession(result.session.sessionId);
      onCreated(result.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作品化に失敗しました');
    } finally {
      setCommitting(false);
    }
  }

  function backToChat() {
    setReviewPlan(null);
  }

  async function reloadLatestSession(sessionId: string): Promise<SetupSession | null> {
    try {
      const latest = await api.getSetupSession(sessionId);
      if (latest.status === 'active') {
        setSession(latest);
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(latest.sessionId);
        return latest;
      } else {
        forgetSetupSession(sessionId);
        return null;
      }
    } catch {
      // 元の入力や表示状態は残す
      return null;
    }
  }

  async function saveDraft(
    mutate: (nextDraft: SetupDraft) => void,
    manualEditPaths: string[] = []
  ): Promise<boolean> {
    if (!session || savingDraft || sending || committing) return false;
    const nextDraft = cloneDraft(session.draft);
    mutate(nextDraft);

    try {
      setSavingDraft(true);
      setError(null);
      setPreviewText('');
      const result = await api.updateSetupDraft(session.sessionId, {
        draft: nextDraft,
        revision: session.revision,
        manualEditPaths,
      });
      setSession(result.session);
      rememberSetupSession(result.session.sessionId);
      setSuggestedActions([]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'メモの保存に失敗しました');
      await reloadLatestSession(session.sessionId);
      return false;
    } finally {
      setSavingDraft(false);
    }
  }

  async function toggleLock(path: string, nextLocked: boolean) {
    if (!session || savingDraft || sending || committing) return;

    try {
      setSavingDraft(true);
      setError(null);
      const result = await api.setSetupLockState(session.sessionId, {
        path,
        locked: nextLocked,
        revision: session.revision,
      });
      setSession(result.session);
      rememberSetupSession(result.session.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '固定状態の更新に失敗しました');
      await reloadLatestSession(session.sessionId);
    } finally {
      setSavingDraft(false);
    }
  }

  function pathLocked(path: string, itemLocked = false): boolean {
    return itemLocked || directLocks(session?.locks ?? [], path).length > 0;
  }

  if (loading) return <div className="loading">相談の準備中...</div>;

  return (
    <div className="setup-workspace">
      <header className="setup-header">
        <div>
          <h1>相談して作る</h1>
          <p>読みたい物語の種を、そのまま話してください。</p>
        </div>
        <div className="setup-header-actions">
          <button type="button" onClick={onCancel}>戻る</button>
          <button type="button" onClick={openHistory} disabled={busy}>
            相談履歴
          </button>
          <button type="button" onClick={startNewSession} disabled={busy}>
            {creatingNew ? '作成中...' : '新しく始める'}
          </button>
          <label className="setup-model-select">
            モデル:
            <select
              value={session?.model.provider ?? ''}
              onChange={(e) => handleProviderChange(e.target.value)}
              disabled={!session || busy || providersLoading}
            >
              {providers.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.label}{provider.hasApiKey === false ? '（キー未設定）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="setup-model-input">
            <input
              type="text"
              value={modelNameDraft}
              onChange={(e) => setModelNameDraft(e.target.value)}
              onBlur={(e) => handleModelNameChange(e.target.value)}
              disabled={!session || busy}
              placeholder="モデル名"
            />
          </label>
          <button type="button" onClick={handlePreview} disabled={!session || busy || hasUnsavedDraftEdits || currentProviderMissingKey}>
            {previewing ? <GeneratingLabel text="試し書き中..." /> : '試し書き'}
          </button>
          <button type="button" className="primary" onClick={handleCommit} disabled={!session || busy || hasUnsavedDraftEdits || currentProviderMissingKey}>
            {committing ? <GeneratingLabel text="作品化中..." /> : 'この内容で作品を作る'}
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="setup-history-modal" role="dialog" aria-label="相談履歴">
          <div className="setup-history-panel">
            <div className="setup-history-header">
              <h2>相談履歴</h2>
              <button type="button" onClick={() => setShowHistory(false)}>閉じる</button>
            </div>
            {historyLoading ? (
              <p>読み込み中...</p>
            ) : historySessions.length === 0 ? (
              <p>履歴はありません。</p>
            ) : (
              <ul className="setup-history-list">
                {historySessions.map((entry) => (
                  <li key={entry.sessionId} className="setup-history-row">
                    <div className="setup-history-info">
                      <div className="setup-history-excerpt">{entry.draftExcerpt || '（タイトルなし）'}</div>
                      <div className="setup-history-meta">
                        <span className={`setup-history-status ${entry.status}`}>{statusLabel(entry.status)}</span>
                        <span>更新: {formatDate(entry.updatedAt)}</span>
                        <span>メッセージ: {entry.messageCount}件</span>
                      </div>
                    </div>
                    <div className="setup-history-actions">
                      {entry.status === 'active' && (
                        <button
                          type="button"
                          onClick={() => resumeSession(entry.sessionId)}
                          disabled={busy}
                        >
                          再開
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => deleteHistorySession(entry.sessionId)}
                        disabled={busy}
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {error && <div className="error-toast setup-error">{error}</div>}
      {session?.lastError && !error && !reviewPlan && (
        <div className="error-toast setup-error">{session.lastError.message}</div>
      )}

      {reviewPlan && session ? (
        <SetupCommitReview
          plan={reviewPlan}
          disabled={committing}
          onCommit={commitFromReview}
          onBack={backToChat}
          onRecreate={handleCommit}
          onRegenerateStyleSample={regenerateStyleSample}
        />
      ) : (
        <main className="setup-main">
          <section className="setup-chat" aria-label="相談チャット">
          <div className="setup-messages">
            {session && session.messages.length > 0 ? (
              session.messages.map((entry) => (
                <article key={entry.messageId} className={`setup-message ${entry.role}`}>
                  <div className="setup-message-role">
                    {entry.role === 'user' ? 'あなた' : '相談相手'}
                  </div>
                  <p>{entry.content}</p>
                </article>
              ))
            ) : (
              <div className="setup-empty-chat">
                <p>例: 強気なヒロインと弱気な主人公。江戸時代風で、暗すぎない話が読みたい。</p>
              </div>
            )}
            {(isStreaming || streamingMessage) && (
              <article key="streaming" className="setup-message assistant">
                <div className="setup-message-role">相談相手</div>
                <p>{streamingMessage}</p>
              </article>
            )}
          </div>

          {suggestedActions.length > 0 && (
            <div className="setup-suggestions">
              {suggestedActions.map((action) => (
                <button
                  key={`${action.label}-${action.message}`}
                  type="button"
                  onClick={() => send(action.message)}
                  disabled={busy || hasUnsavedDraftEdits}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}

          {showRetry && (
            <div className="setup-retry-banner">
              <span>応答を再試行できます。</span>
              <button type="button" onClick={retry} disabled={busy || hasUnsavedDraftEdits}>
                応答を再試行
              </button>
            </div>
          )}

          {currentProviderMissingKey && (
            <div className="setup-api-key-warning">
              APIキーが未設定です。設定画面で入力してください。
              <button type="button" onClick={onOpenSettings}>
                設定を開く
              </button>
            </div>
          )}

          <form className="setup-input" onSubmit={handleSubmit}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="読みたい物語の雰囲気、好きな関係性、避けたい展開など"
              disabled={sending || committing || currentProviderMissingKey}
            />
            {isStreaming ? (
              <button type="button" className="danger" onClick={abortStreaming}>
                中断
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={sending || committing || hasUnsavedDraftEdits || !message.trim() || currentProviderMissingKey}
              >
                {sending ? <GeneratingLabel text="相談中..." /> : '送る'}
              </button>
            )}
          </form>
        </section>

        <aside className="setup-draft-panel" aria-label="作品の種メモ">
          <h2>作品の種メモ</h2>
          {hasUnsavedDraftEdits && (
            <div className="setup-draft-unsaved">
              メモに未保存の変更があります。保存してから相談・試し書き・作品化できます。
            </div>
          )}
          {draft ? (
            <>
              <CoreConceptEditor
                dirtyKey="draft.coreConcept"
                value={draft.coreConcept}
                disabled={busy}
                locked={pathLocked('draft.coreConcept')}
                onDirtyChange={markDraftDirty}
                onSave={(value) =>
                  saveDraft((nextDraft) => {
                    nextDraft.coreConcept = value.trim();
                  }, ['draft.coreConcept'])
                }
                onToggleLock={() => toggleLock('draft.coreConcept', !pathLocked('draft.coreConcept'))}

              />
              <DraftTextList
                title="決まってきたこと"
                items={draft.confirmed.filter((item) => item.status === 'active')}
                disabled={busy}
                onDirtyChange={markDraftDirty}
                isLocked={(item) => pathLocked(item.id, item.locked)}
                onSave={(item, value) =>
                  saveDraft((nextDraft) => {
                    const target = nextDraft.confirmed.find((entry) => entry.id === item.id);
                    if (!target) return;
                    target.text = value.trim();
                    target.source = 'manual';
                    target.updatedAt = new Date().toISOString();
                  }, [item.id])
                }
                onArchive={(item) =>
                  saveDraft((nextDraft) => archiveById(nextDraft.confirmed, item.id), [item.id])
                }
                onToggleLock={(item) => toggleLock(item.id, !pathLocked(item.id, item.locked))}
                onMove={(item) =>
                  saveDraft((nextDraft) => {
                    archiveById(nextDraft.confirmed, item.id);
                    nextDraft.undecided.push({
                      text: item.text,
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftUndecided);
                  })
                }
                moveLabel="未確定へ"
                onAdd={addPendingConfirmed}
                pendingRows={pendingConfirmed}
                onCancelPending={removePendingConfirmed}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.confirmed.push({
                      text: value.trim(),
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftTextItem);
                  });
                  if (ok) removePendingConfirmed(id);
                }}
              />
              <DraftCandidateList
                items={draft.candidates.filter((candidate) => candidate.status === 'active')}
                disabled={busy}
                hasUnsavedDraftEdits={hasUnsavedDraftEdits}
                onDirtyChange={markDraftDirty}
                isLocked={(candidate) => pathLocked(candidate.id, candidate.locked)}
                onSave={(candidate, values) =>
                  saveDraft((nextDraft) => {
                    const target = nextDraft.candidates.find((entry) => entry.id === candidate.id);
                    if (!target) return;
                    target.title = values.title.trim();
                    target.summary = values.summary.trim();
                    target.source = 'manual';
                    target.updatedAt = new Date().toISOString();
                  }, [candidate.id])
                }
                onArchive={(candidate) =>
                  saveDraft((nextDraft) => archiveById(nextDraft.candidates, candidate.id), [candidate.id])
                }
                onToggleLock={(candidate) => toggleLock(candidate.id, !pathLocked(candidate.id, candidate.locked))}
                onMoveToConfirmed={(candidate) =>
                  saveDraft((nextDraft) => {
                    archiveById(nextDraft.candidates, candidate.id);
                    const text = candidate.summary
                      ? `${candidate.title}: ${candidate.summary}`
                      : candidate.title;
                    nextDraft.confirmed.push({
                      text,
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftTextItem);
                  })
                }
                onSend={(message) => send(message)}
                onAdd={addPendingCandidate}
                pendingRows={pendingCandidates}
                onCancelPending={removePendingCandidate}
                onSavePending={async (id, values) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.candidates.push({
                      title: values.title.trim(),
                      summary: values.summary.trim(),
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftCandidate);
                  });
                  if (ok) removePendingCandidate(id);
                }}
                selectedIds={selectedCandidateIds}
                onToggleSelection={toggleCandidateSelection}
                onMixSelected={sendMixedCandidates}
              />
              <DraftTextList
                title="未確定"
                items={draft.undecided.filter((item) => item.status === 'active')}
                disabled={busy}
                onDirtyChange={markDraftDirty}
                isLocked={(item) => pathLocked(item.id, item.locked)}
                onSave={(item, value) =>
                  saveDraft((nextDraft) => {
                    const target = nextDraft.undecided.find((entry) => entry.id === item.id);
                    if (!target) return;
                    target.text = value.trim();
                    target.source = 'manual';
                    target.updatedAt = new Date().toISOString();
                  }, [item.id])
                }
                onArchive={(item) =>
                  saveDraft((nextDraft) => archiveById(nextDraft.undecided, item.id), [item.id])
                }
                onToggleLock={(item) => toggleLock(item.id, !pathLocked(item.id, item.locked))}
                onMove={(item) =>
                  saveDraft((nextDraft) => {
                    archiveById(nextDraft.undecided, item.id);
                    nextDraft.confirmed.push({
                      text: item.text,
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftTextItem);
                  })
                }
                moveLabel="確定へ"
                onAdd={addPendingUndecided}
                pendingRows={pendingUndecided}
                onCancelPending={removePendingUndecided}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.undecided.push({
                      text: value.trim(),
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftUndecided);
                  });
                  if (ok) removePendingUndecided(id);
                }}
              />
              <DraftCharacterList
                draft={draft}
                disabled={busy}
                onDirtyChange={markDraftDirty}
                isLocked={(character) => pathLocked(character.id, character.locked)}
                onSave={(character, values) =>
                  saveDraft((nextDraft) => {
                    const target = nextDraft.characters.find((entry) => entry.id === character.id);
                    if (!target) return;
                    target.role = values.role;
                    target.name = values.name.trim();
                    target.label = values.label.trim();
                    target.description = values.description.trim();
                    target.speechStyle = values.speechStyle.trim() || undefined;
                    target.relationshipNotes = values.relationshipNotes.trim() || undefined;
                    target.source = 'manual';
                    target.updatedAt = new Date().toISOString();
                  }, [character.id])
                }
                onArchive={(character) =>
                  saveDraft((nextDraft) => archiveById(nextDraft.characters, character.id), [character.id])
                }
                onToggleLock={(character) => toggleLock(character.id, !pathLocked(character.id, character.locked))}
                onAdd={addPendingCharacter}
                pendingRows={pendingCharacters}
                onCancelPending={removePendingCharacter}
                onSavePending={async (id, values) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.characters.push({
                      role: values.role,
                      name: values.name.trim(),
                      label: values.label.trim(),
                      description: values.description.trim(),
                      speechStyle: values.speechStyle.trim() || undefined,
                      relationshipNotes: values.relationshipNotes.trim() || undefined,
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftCharacter);
                  });
                  if (ok) removePendingCharacter(id);
                }}
              />
              <DraftStringList
                title="世界観"
                section="world"
                items={draft.world}
                disabled={busy}
                locked={pathLocked('draft.world')}
                onDirtyChange={markDraftDirty}
                onSave={(index, value) => saveStringItem('world', index, value)}
                onRemove={(index) => removeStringItem('world', index)}
                onToggleLock={() => toggleLock('draft.world', !pathLocked('draft.world'))}
                onAdd={() => addPendingString('world')}
                pendingRows={pendingStrings.world}
                onCancelPending={(id) => removePendingString('world', id)}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.world.push(value.trim());
                  });
                  if (ok) removePendingString('world', id);
                }}
              />
              <DraftStringList
                title="関係性"
                section="relationshipSeeds"
                items={draft.relationshipSeeds}
                disabled={busy}
                locked={pathLocked('draft.relationshipSeeds')}
                onDirtyChange={markDraftDirty}
                onSave={(index, value) => saveStringItem('relationshipSeeds', index, value)}
                onRemove={(index) => removeStringItem('relationshipSeeds', index)}
                onToggleLock={() => toggleLock('draft.relationshipSeeds', !pathLocked('draft.relationshipSeeds'))}
                onAdd={() => addPendingString('relationshipSeeds')}
                pendingRows={pendingStrings.relationshipSeeds}
                onCancelPending={(id) => removePendingString('relationshipSeeds', id)}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.relationshipSeeds.push(value.trim());
                  });
                  if (ok) removePendingString('relationshipSeeds', id);
                }}
              />
              <DraftStringList
                title="好み・文体"
                section="tone"
                items={draft.tone}
                disabled={busy}
                locked={pathLocked('draft.tone')}
                onDirtyChange={markDraftDirty}
                onSave={(index, value) => saveStringItem('tone', index, value)}
                onRemove={(index) => removeStringItem('tone', index)}
                onToggleLock={() => toggleLock('draft.tone', !pathLocked('draft.tone'))}
                onAdd={() => addPendingString('tone')}
                pendingRows={pendingStrings.tone}
                onCancelPending={(id) => removePendingString('tone', id)}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.tone.push(value.trim());
                  });
                  if (ok) removePendingString('tone', id);
                }}
              />
              <DraftStringList
                title="NG"
                section="ng"
                items={draft.ng}
                disabled={busy}
                locked={pathLocked('draft.ng')}
                onDirtyChange={markDraftDirty}
                onSave={(index, value) => saveStringItem('ng', index, value)}
                onRemove={(index) => removeStringItem('ng', index)}
                onToggleLock={() => toggleLock('draft.ng', !pathLocked('draft.ng'))}
                onAdd={() => addPendingString('ng')}
                pendingRows={pendingStrings.ng}
                onCancelPending={(id) => removePendingString('ng', id)}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.ng.push(value.trim());
                  });
                  if (ok) removePendingString('ng', id);
                }}
              />
              <DraftStringList
                title="冒頭候補"
                section="openingSeeds"
                items={draft.openingSeeds}
                disabled={busy}
                locked={pathLocked('draft.openingSeeds')}
                onDirtyChange={markDraftDirty}
                onSave={(index, value) => saveStringItem('openingSeeds', index, value)}
                onRemove={(index) => removeStringItem('openingSeeds', index)}
                onToggleLock={() => toggleLock('draft.openingSeeds', !pathLocked('draft.openingSeeds'))}
                onAdd={() => addPendingString('openingSeeds')}
                pendingRows={pendingStrings.openingSeeds}
                onCancelPending={(id) => removePendingString('openingSeeds', id)}
                onSavePending={async (id, value) => {
                  const ok = await saveDraft((nextDraft) => {
                    nextDraft.openingSeeds.push(value.trim());
                  });
                  if (ok) removePendingString('openingSeeds', id);
                }}
              />
            </>
          ) : (
            <p className="placeholder">まだメモはありません。</p>
          )}
          {previewText && (
            <section className="setup-preview">
              <h3>試し書き</h3>
              <p>{previewText}</p>
            </section>
          )}
        </aside>
      </main>
      )}
    </div>
  );

  function saveStringItem(section: StringDraftSection, index: number, value: string) {
    return saveDraft((nextDraft) => {
      nextDraft[section] = nextDraft[section].map((item, currentIndex) =>
        currentIndex === index ? value.trim() : item
      );
    }, [`draft.${section}`]);
  }

  function removeStringItem(section: StringDraftSection, index: number) {
    return saveDraft((nextDraft) => {
      nextDraft[section] = nextDraft[section].filter((_, currentIndex) => currentIndex !== index);
    }, [`draft.${section}`]);
  }
}

function CoreConceptEditor({
  dirtyKey,
  value,
  disabled,
  locked,
  onDirtyChange,
  onSave,
  onToggleLock,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  locked: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onToggleLock: () => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const changed = draftValue.trim() !== value.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>作品の核</h3>
        <button type="button" onClick={onToggleLock} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
      </div>
      <textarea
        className="setup-draft-textarea"
        value={draftValue}
        onChange={(e) => setDraftValue(e.target.value)}
        placeholder="まだ決まっていません"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(draftValue)} disabled={disabled || !changed}>
          保存
        </button>
      </div>
    </section>
  );
}

function DraftTextList<T extends SetupDraftTextItem | SetupDraftUndecided>({
  title,
  items,
  disabled,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onMove,
  moveLabel,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  title: string;
  items: T[];
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: T) => boolean;
  onSave: (item: T, value: string) => void;
  onArchive: (item: T) => void;
  onToggleLock: (item: T) => void;
  onMove?: (item: T) => void;
  moveLabel?: string;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, value: string) => void;
}) {
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>{title}</h3>
        <button type="button" onClick={onAdd} disabled={disabled}>
          +追加
        </button>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((item) => (
            <EditableTextRow
              key={item.id}
              dirtyKey={item.id}
              item={item}
              disabled={disabled}
              locked={isLocked(item)}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
              onMove={onMove}
              moveLabel={moveLabel}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingTextRow
              key={pending.id}
              dirtyKey={`pending-text-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSavePending(pending.id, value)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableTextRow<T extends SetupDraftTextItem | SetupDraftUndecided>({
  dirtyKey,
  item,
  disabled,
  locked,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
  onMove,
  moveLabel,
}: {
  dirtyKey: string;
  item: T;
  disabled: boolean;
  locked: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (item: T, value: string) => void;
  onArchive: (item: T) => void;
  onToggleLock: (item: T) => void;
  onMove?: (item: T) => void;
  moveLabel?: string;
}) {
  const [value, setValue] = useState(item.text);

  useEffect(() => {
    setValue(item.text);
  }, [item.id, item.text]);

  const changed = value.trim() !== item.text.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row">
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(item, value)} disabled={disabled || !changed || !value.trim()}>
          保存
        </button>
        {onMove && moveLabel && (
          <button type="button" onClick={() => onMove(item)} disabled={disabled}>
            {moveLabel}
          </button>
        )}
        <button type="button" onClick={() => onToggleLock(item)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(item)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingTextRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const changed = value.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新しい項目"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(value)} disabled={disabled || !value.trim()}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

function PendingStringRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const changed = value.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新しい項目"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(value)} disabled={disabled || !value.trim()}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

function DraftCandidateList({
  items,
  disabled,
  hasUnsavedDraftEdits,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onMoveToConfirmed,
  onSend,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
  selectedIds,
  onToggleSelection,
  onMixSelected,
}: {
  items: SetupDraftCandidate[];
  disabled: boolean;
  hasUnsavedDraftEdits: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: SetupDraftCandidate) => boolean;
  onSave: (item: SetupDraftCandidate, values: { title: string; summary: string }) => void;
  onArchive: (item: SetupDraftCandidate) => void;
  onToggleLock: (item: SetupDraftCandidate) => void;
  onMoveToConfirmed?: (item: SetupDraftCandidate) => void;
  onSend: (message: string) => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, values: { title: string; summary: string }) => void;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onMixSelected: () => void;
}) {
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  const canSend = !disabled && !hasUnsavedDraftEdits;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>候補</h3>
        <div className="setup-draft-section-actions">
          <button type="button" onClick={onAdd} disabled={disabled}>
            +追加
          </button>
          <button type="button" onClick={() => onSend('今の方向とは少し違う候補を、もう一度いくつか出して。')} disabled={!canSend}>
            別の候補をもう一度
          </button>
        </div>
      </div>
      {selectedIds.size >= 2 && (
        <div className="setup-draft-section-mix-actions">
          <button type="button" onClick={onMixSelected} disabled={!canSend}>
            選択した候補を混ぜる
          </button>
        </div>
      )}
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((candidate) => (
            <EditableCandidateRow
              key={candidate.id}
              dirtyKey={candidate.id}
              candidate={candidate}
              disabled={disabled}
              locked={isLocked(candidate)}
              selected={selectedIds.has(candidate.id)}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
              onMoveToConfirmed={onMoveToConfirmed}
              onSend={onSend}
              onToggleSelection={onToggleSelection}
              canSend={canSend}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingCandidateRow
              key={pending.id}
              dirtyKey={`pending-candidate-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(values) => onSavePending(pending.id, values)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableCandidateRow({
  dirtyKey,
  candidate,
  disabled,
  locked,
  selected,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
  onMoveToConfirmed,
  onSend,
  onToggleSelection,
  canSend,
}: {
  dirtyKey: string;
  candidate: SetupDraftCandidate;
  disabled: boolean;
  locked: boolean;
  selected: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (item: SetupDraftCandidate, values: { title: string; summary: string }) => void;
  onArchive: (item: SetupDraftCandidate) => void;
  onToggleLock: (item: SetupDraftCandidate) => void;
  onMoveToConfirmed?: (item: SetupDraftCandidate) => void;
  onSend: (message: string) => void;
  onToggleSelection: (id: string) => void;
  canSend: boolean;
}) {
  const [title, setTitle] = useState(candidate.title);
  const [summary, setSummary] = useState(candidate.summary);

  useEffect(() => {
    setTitle(candidate.title);
    setSummary(candidate.summary);
  }, [candidate.id, candidate.title, candidate.summary]);

  const changed = title.trim() !== candidate.title.trim() || summary.trim() !== candidate.summary.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row">
      <label className="setup-draft-candidate-select">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(candidate.id)}
          disabled={disabled}
        />
      </label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave(candidate, { title, summary })}
          disabled={disabled || !changed || (!title.trim() && !summary.trim())}
        >
          保存
        </button>
        {onMoveToConfirmed && (
          <button type="button" onClick={() => onMoveToConfirmed(candidate)} disabled={disabled}>
            確定へ
          </button>
        )}
        <button
          type="button"
          onClick={() => onSend(`候補「${candidate.title}」で進めたい。`)}
          disabled={!canSend}
        >
          これで進める
        </button>
        <button type="button" onClick={() => onToggleLock(candidate)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(candidate)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingCandidateRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (values: { title: string; summary: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const changed = title.trim() !== '' || summary.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="タイトル"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave({ title, summary })}
          disabled={disabled || (!title.trim() && !summary.trim())}
        >
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

function DraftCharacterList({
  draft,
  disabled,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  draft: SetupDraft;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: SetupDraftCharacter) => boolean;
  onSave: (
    item: SetupDraftCharacter,
    values: {
      role: CharacterRole;
      name: string;
      label: string;
      description: string;
      speechStyle: string;
      relationshipNotes: string;
    }
  ) => void;
  onArchive: (item: SetupDraftCharacter) => void;
  onToggleLock: (item: SetupDraftCharacter) => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (
    id: string,
    values: {
      role: CharacterRole;
      name: string;
      label: string;
      description: string;
      speechStyle: string;
      relationshipNotes: string;
    }
  ) => void;
}) {
  const characters = useMemo(
    () => draft.characters.filter((character) => character.status === 'active'),
    [draft.characters]
  );
  const isEmpty = characters.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>人物</h3>
        <button type="button" onClick={onAdd} disabled={disabled}>
          +追加
        </button>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {characters.map((character) => (
            <EditableCharacterRow
              key={character.id}
              dirtyKey={character.id}
              character={character}
              disabled={disabled}
              locked={isLocked(character)}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingCharacterRow
              key={pending.id}
              dirtyKey={`pending-character-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(values) => onSavePending(pending.id, values)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableCharacterRow({
  dirtyKey,
  character,
  disabled,
  locked,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
}: {
  dirtyKey: string;
  character: SetupDraftCharacter;
  disabled: boolean;
  locked: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (
    item: SetupDraftCharacter,
    values: {
      role: CharacterRole;
      name: string;
      label: string;
      description: string;
      speechStyle: string;
      relationshipNotes: string;
    }
  ) => void;
  onArchive: (item: SetupDraftCharacter) => void;
  onToggleLock: (item: SetupDraftCharacter) => void;
}) {
  const [role, setRole] = useState<CharacterRole>(character.role);
  const [name, setName] = useState(character.name);
  const [label, setLabel] = useState(character.label);
  const [description, setDescription] = useState(character.description);
  const [speechStyle, setSpeechStyle] = useState(character.speechStyle ?? '');
  const [relationshipNotes, setRelationshipNotes] = useState(character.relationshipNotes ?? '');

  useEffect(() => {
    setRole(character.role);
    setName(character.name);
    setLabel(character.label);
    setDescription(character.description);
    setSpeechStyle(character.speechStyle ?? '');
    setRelationshipNotes(character.relationshipNotes ?? '');
  }, [
    character.id,
    character.role,
    character.name,
    character.label,
    character.description,
    character.speechStyle,
    character.relationshipNotes,
  ]);

  const changed =
    role !== character.role ||
    name.trim() !== character.name.trim() ||
    label.trim() !== character.label.trim() ||
    description.trim() !== character.description.trim() ||
    speechStyle.trim() !== (character.speechStyle ?? '').trim() ||
    relationshipNotes.trim() !== (character.relationshipNotes ?? '').trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row">
      <div className="setup-draft-character-grid">
        <select value={role} onChange={(e) => setRole(e.target.value as CharacterRole)} disabled={disabled}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名"
          disabled={disabled}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名前"
          disabled={disabled}
        />
      </div>
      <textarea
        className="setup-draft-textarea compact"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={speechStyle}
        onChange={(e) => setSpeechStyle(e.target.value)}
        placeholder="口調"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={relationshipNotes}
        onChange={(e) => setRelationshipNotes(e.target.value)}
        placeholder="関係性"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave(character, { role, name, label, description, speechStyle, relationshipNotes })}
          disabled={disabled || !changed || (!label.trim() && !name.trim() && !description.trim())}
        >
          保存
        </button>
        <button type="button" onClick={() => onToggleLock(character)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(character)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingCharacterRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (values: {
    role: CharacterRole;
    name: string;
    label: string;
    description: string;
    speechStyle: string;
    relationshipNotes: string;
  }) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<CharacterRole>('supporting');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [speechStyle, setSpeechStyle] = useState('');
  const [relationshipNotes, setRelationshipNotes] = useState('');

  const changed =
    role !== 'supporting' ||
    name.trim() !== '' ||
    label.trim() !== '' ||
    description.trim() !== '' ||
    speechStyle.trim() !== '' ||
    relationshipNotes.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <div className="setup-draft-character-grid">
        <select value={role} onChange={(e) => setRole(e.target.value as CharacterRole)} disabled={disabled}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名"
          disabled={disabled}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名前"
          disabled={disabled}
        />
      </div>
      <textarea
        className="setup-draft-textarea compact"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={speechStyle}
        onChange={(e) => setSpeechStyle(e.target.value)}
        placeholder="口調"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={relationshipNotes}
        onChange={(e) => setRelationshipNotes(e.target.value)}
        placeholder="関係性"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave({ role, name, label, description, speechStyle, relationshipNotes })}
          disabled={disabled || (!label.trim() && !name.trim() && !description.trim())}
        >
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

function DraftStringList({
  title,
  section,
  items,
  disabled,
  locked,
  onDirtyChange,
  onSave,
  onRemove,
  onToggleLock,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  title: string;
  section: StringDraftSection;
  items: string[];
  disabled: boolean;
  locked: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onToggleLock: () => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, value: string) => void;
}) {
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>{title}</h3>
        <div className="setup-draft-section-actions">
          <button type="button" onClick={onAdd} disabled={disabled}>
            +追加
          </button>
          <button type="button" onClick={onToggleLock} disabled={disabled}>
            {locked ? '固定解除' : '固定'}
          </button>
        </div>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((item, index) => (
            <EditableStringRow
              key={`${index}-${item}`}
              dirtyKey={`${section}-${index}`}
              value={item}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSave(index, value)}
              onRemove={() => onRemove(index)}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingStringRow
              key={pending.id}
              dirtyKey={`pending-string-${section}-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSavePending(pending.id, value)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableStringRow({
  dirtyKey,
  value,
  disabled,
  onDirtyChange,
  onSave,
  onRemove,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onRemove: () => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const changed = draftValue.trim() !== value.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row">
      <textarea
        className="setup-draft-textarea compact"
        value={draftValue}
        onChange={(e) => setDraftValue(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(draftValue)} disabled={disabled || !changed || !draftValue.trim()}>
          保存
        </button>
        <button type="button" className="danger" onClick={onRemove} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

async function createDefaultSetupSession(knownProviders?: ModelProviderInfo[]) {
  const providers =
    knownProviders && knownProviders.length > 0
      ? knownProviders
      : await api.getModelProviders().catch(() => [] as ModelProviderInfo[]);
  const defaultProvider = providers.find((provider) => provider.name === 'gemini') ?? providers[0];
  return api.createSetupSession({
    projectSettings: DEFAULT_PROJECT_SETTINGS,
    model: defaultProvider
      ? { provider: defaultProvider.name, modelName: defaultProvider.defaultModel }
      : undefined,
  });
}

async function findRestorableSetupSession(): Promise<SetupSession | null> {
  const storedId = readStoredSetupSessionId();
  if (storedId) {
    const stored = await api.getSetupSession(storedId).catch(() => null);
    if (stored?.status === 'active') return stored;
    forgetSetupSession(storedId);
  }

  const summaries = await api.listSetupSessions().catch(() => []);
  const latestActive = summaries.find((summary) => summary.status === 'active');
  if (!latestActive) return null;

  const session = await api.getSetupSession(latestActive.sessionId).catch(() => null);
  return session?.status === 'active' ? session : null;
}

function cloneDraft(draft: SetupDraft): SetupDraft {
  return JSON.parse(JSON.stringify(draft)) as SetupDraft;
}

function archiveById<T extends { id: string; status: 'active' | 'archived'; updatedAt: string }>(
  items: T[],
  id: string
): void {
  const target = items.find((item) => item.id === id);
  if (!target) return;
  target.status = 'archived';
  target.updatedAt = new Date().toISOString();
}

function directLocks(locks: SetupLock[], path: string): SetupLock[] {
  return locks.filter((lock) => lock.path === path);
}

function statusLabel(status: SetupSessionSummary['status']): string {
  switch (status) {
    case 'active':
      return '相談中';
    case 'committed':
      return '作品化済み';
    case 'abandoned':
      return '中断';
    default:
      return status;
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP');
  } catch {
    return iso;
  }
}

function readStoredSetupSessionId(): string | null {
  try {
    return window.localStorage.getItem(SETUP_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function rememberSetupSession(sessionId: string): void {
  try {
    window.localStorage.setItem(SETUP_SESSION_STORAGE_KEY, sessionId);
  } catch {
    // localStorageが使えない環境では、サーバ側の一覧復帰に任せる
  }
}

function forgetSetupSession(sessionId?: string): void {
  try {
    const current = window.localStorage.getItem(SETUP_SESSION_STORAGE_KEY);
    if (!sessionId || current === sessionId) {
      window.localStorage.removeItem(SETUP_SESSION_STORAGE_KEY);
    }
  } catch {
    // localStorageが使えない環境では何もしない
  }
}
