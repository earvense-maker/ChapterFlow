import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import { GeneratingLabel } from './GeneratingLabel';
import LightMarkdown from './LightMarkdown';
import PresetSelector, { type PresetCategory } from './PresetSelector';
import { useNotificationCenter } from './NotificationCenter';
import {
  collectDraftChanges,
  ROLE_LABELS,
  type DraftChanges,
  type DraftChangeSummary,
  type StringDraftSection,
} from './setupWorkspace/draftChanges';
import {
  forgetSetupSession,
  readStoredSetupSessionId,
  rememberSetupSession,
} from './setupWorkspace/sessionStorage';
import {
  CoreConceptEditor,
  DraftCandidateList,
  DraftCharacterList,
  DraftStringList,
  DraftTextList,
  type PendingDescriptor,
} from './setupWorkspace/draftEditors';
import { hasMeaningfulSetupContent } from '@shared/setupContent';
import { normalizeActivePresetIds } from '@shared/presetMigration';
import type {
  ActivePresets,
  CharacterRole,
  GenerationNotificationSettings,
  ModelProviderInfo,
  SetupCommitPlan,
  SetupDraft,
  SetupDraftCandidate,
  SetupDraftCharacter,
  SetupDraftTextItem,
  SetupDraftUndecided,
  SetupLock,
  SetupSession,
  SetupSuggestedAction,
} from '@shared/types';

export { collectDraftChanges } from './setupWorkspace/draftChanges';

interface Props {
  purpose?: 'novel' | 'roleplay';
  onCreated: (projectId: string) => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}

const DEFAULT_PROJECT_SETTINGS = {
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: {},
};

const COLD_START_ACTIONS: SetupSuggestedAction[] = [
  {
    label: '好きな作品の雰囲気から',
    message: '好きな作品の雰囲気から考えたいです。私に合いそうな雰囲気をいくつか提案してください。',
  },
  {
    label: '関係性から決めたい',
    message: '関係性から決めたいです。読みたくなる二人の関係性をいくつか提案してください。',
  },
  {
    label: 'おまかせで候補を出して',
    message: 'おまかせで候補を出して。読みたくなる物語の方向を3つくらい提案してください。',
  },
];

const PREVIEW_STYLE_HINTS = ['もっと軽く', 'しっとり', '会話多め'];

export default function SetupWorkspace({ purpose = 'novel', onCreated, onCancel, onOpenSettings }: Props) {
  const confirmAction = useConfirm();
  const notificationCenter = useNotificationCenter();
  const [notificationSettings, setNotificationSettings] = useState<GenerationNotificationSettings | null>(
    null
  );
  const [session, setSession] = useState<SetupSession | null>(null);
  const [message, setMessage] = useState('');
  const [suggestedActions, setSuggestedActions] = useState<SetupSuggestedAction[]>([]);
  const [previewText, setPreviewText] = useState('');
  const [previewStyleHint, setPreviewStyleHint] = useState('');
  const [draftChangeSummary, setDraftChangeSummary] = useState<DraftChangeSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitStage, setCommitStage] = useState<'planning' | 'saving' | null>(null);
  const [commitPlan, setCommitPlan] = useState<SetupCommitPlan | null>(null);
  const [commitRevision, setCommitRevision] = useState<number | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [dirtyDraftEditKeys, setDirtyDraftEditKeys] = useState<Set<string>>(() => new Set());
  const [streamingMessage, setStreamingMessage] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const sendAbortController = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const createProjectButtonRef = useRef<HTMLButtonElement | null>(null);
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
    scenarioSeeds: [],
  });
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [presetCategories, setPresetCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [sessionModelProvider, setSessionModelProvider] = useState('');
  const [sessionModelName, setSessionModelName] = useState('');

  const currentProviderMissingKey = useMemo(() => {
    if (!session) return false;
    const provider = providers.find((p) => p.name === session.model.provider);
    return provider ? provider.hasApiKey === false : false;
  }, [session, providers]);

  const currentProvider = useMemo(
    () => providers.find((provider) => provider.name === session?.model.provider),
    [providers, session?.model.provider]
  );

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
        const restored = await findRestorableSetupSession(purpose);
        if (ignore) return;

        if (restored) {
          const synced = await syncFreshSessionModel(restored);
          if (ignore) return;
          setSession(synced.session);
          setDirtyDraftEditKeys(new Set());
          clearDraftChanges();
          rememberSetupSession(synced.session.sessionId, purpose);
          setSuggestedActions([]);
          if (synced.error) setError(synced.error);
          return;
        }

        const result = await createDefaultSetupSession(undefined, purpose);
        if (ignore) return;
        setSession(result.session);
        setDirtyDraftEditKeys(new Set());
        clearDraftChanges();
        rememberSetupSession(result.sessionId, purpose);
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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendAbortController.current?.abort();
      sendAbortController.current = null;
    };
  }, []);

  // NOTE: 通知設定はアプリ全体設定なので一度だけ取得する。
  useEffect(() => {
    let cancelled = false;
    void api
      .getNotificationSettings()
      .then((settings) => {
        if (!cancelled) setNotificationSettings(settings);
      })
      .catch(() => {
        // 取得失敗時は通知を出さないだけに留める。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (purpose !== 'novel') return;
    let ignore = false;
    api.getPresets()
      .then((result) => {
        if (ignore) return;
        setPresetCategories(
          (result as { categories?: Record<string, PresetCategory> }).categories ?? {}
        );
      })
      .catch(() => {
        if (!ignore) setPresetCategories({});
      });
    return () => {
      ignore = true;
    };
  }, [purpose]);

  useEffect(() => {
    let ignore = false;
    async function loadProviders() {
      try {
        const result = await api.getModelProviders();
        if (ignore) return;
        setProviders(result);
      } catch {
        if (!ignore) setProviders([]);
      } finally {
        if (!ignore) setProvidersLoaded(true);
      }
    }
    loadProviders();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    setSessionModelProvider(session.model.provider);
    setSessionModelName(session.model.modelName);
  }, [session?.sessionId, session?.model.provider, session?.model.modelName]);

  useEffect(() => {
    if (!commitPlan) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !committing) closeCommitReview();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commitPlan, committing]);

  const draft = session?.draft;
  const hasMeaningfulContent = useMemo(
    () => (session ? hasMeaningfulSetupContent(session) : false),
    [session]
  );
  const modelAvailabilityPending = Boolean(session) && !providersLoaded;
  const currentProviderUnavailable = Boolean(session) && providersLoaded && !currentProvider;
  const modelUnavailable = modelAvailabilityPending || currentProviderUnavailable || currentProviderMissingKey;
  const busy = sending || savingDraft || previewing || committing || creatingNew || Boolean(commitPlan);
  const hasUnsavedDraftEdits = dirtyDraftEditKeys.size > 0;
  const isColdStart = Boolean(session && session.messages.length === 0 && !hasMeaningfulContent);
  const visibleSuggestedActions = isColdStart ? COLD_START_ACTIONS : suggestedActions;
  const draftChanges = useMemo<DraftChanges>(
    () => Object.fromEntries(draftChangeSummary.map(({ key, kind }) => [key, kind])),
    [draftChangeSummary]
  );
  const hasDraftChanges = draftChangeSummary.length > 0;

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

  function clearDraftChanges() {
    setDraftChangeSummary([]);
  }

  function applySessionWithDraftChanges(
    previousSession: SetupSession,
    nextSession: SetupSession,
    options: { preserveSummaryOnRevisionOnly?: boolean } = {}
  ) {
    setSession(nextSession);
    const changes = collectDraftChanges(previousSession.draft, nextSession.draft);
    const revisionChanged = nextSession.revision !== previousSession.revision;
    if (changes.length > 0 || (revisionChanged && !options.preserveSummaryOnRevisionOnly)) {
      setDraftChangeSummary(changes);
    }
  }

  async function startNewSession() {
    if (
      (session?.messages.length || hasUnsavedDraftEdits) &&
      !(await confirmAction('今の相談を終了して、新しい相談を始めますか？', {
        confirmLabel: '新しい相談を始める',
      }))
    ) return;
    try {
      setCreatingNew(true);
      setError(null);
      setPreviewText('');
      setPreviewStyleHint('');
      setCommitPlan(null);
      setCommitRevision(null);
      if (session?.status === 'active') {
        await api.abandonSetupSession(session.sessionId).catch(() => undefined);
      }
      const result = await createDefaultSetupSession(providers, purpose);
      setSession(result.session);
      setDirtyDraftEditKeys(new Set());
      clearDraftChanges();
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
        scenarioSeeds: [],
      });
      setSelectedCandidateIds(new Set());
      rememberSetupSession(result.sessionId, purpose);
      setSuggestedActions(result.suggestedActions);
      setMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '新しい相談を作れませんでした');
    } finally {
      setCreatingNew(false);
    }
  }

  async function send(text: string) {
    if (!session || sending || committing || sendAbortController.current) return;
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
    const clientRequestId = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let firstChunkFired = false;
    const notifyClickTarget = { kind: 'setup' as const };
    const notifyCompleted = (dedupeKey: string) => {
      if (!notificationSettings) return;
      notificationCenter.notify(notificationSettings, {
        eventType: 'completed',
        dedupeKey,
        title: '相談の返答が完了しました',
        body: '',
        clickTarget: notifyClickTarget,
      });
    };

    try {
      await api.sendSetupMessageStream(
        session.sessionId,
        { message: trimmed, revision: session.revision },
        {
          onDelta: (delta) => {
            if (!mountedRef.current) return;
            if (!firstChunkFired && delta.trim() && notificationSettings) {
              firstChunkFired = true;
              notificationCenter.notify(notificationSettings, {
                eventType: 'firstOutput',
                dedupeKey: `firstOutput:${clientRequestId}`,
                title: '相談の返答が始まりました',
                body: '',
                clickTarget: notifyClickTarget,
              });
            }
            setIsStreaming(true);
            setStreamingMessage((current) => current + delta);
          },
          onResult: (response) => {
            if (!mountedRef.current) return;
            notifyCompleted(`completed:${response.session.sessionId}:${response.session.revision}`);
            applySessionWithDraftChanges(session, response.session);
            setDirtyDraftEditKeys(new Set());
            rememberSetupSession(response.session.sessionId, purpose);
            setSuggestedActions(response.suggestedActions);
            setMessage('');
            setStreamingMessage('');
            setShowRetry(false);
          },
          onError: (payload) => {
            if (!mountedRef.current) return;
            throw new Error(payload.error || '相談処理に失敗しました');
          },
        },
        abortController.signal
      );
    } catch (err) {
      if (!mountedRef.current) return;
      if (abortController.signal.aborted) {
        setShowRetry(true);
        setStreamingMessage('');
        if (sendAbortController.current === abortController) {
          sendAbortController.current = null;
        }
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
        // NOTE: streamが切れて非streamにfallbackした場合も、利用者から見た結果は
        // 成功なので completed 扱いにする（failed にはしない）。
        notifyCompleted(`completed:${result.session.sessionId}:${result.session.revision}`);
        applySessionWithDraftChanges(session, result.session);
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(result.session.sessionId, purpose);
        setSuggestedActions(result.suggestedActions);
        setMessage('');
        setShowRetry(false);
        setStreamingMessage('');
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : '送信に失敗しました');
        if (notificationSettings) {
          notificationCenter.notify(notificationSettings, {
            eventType: 'failed',
            dedupeKey: `failed:${clientRequestId}`,
            title: '相談の送信に失敗しました',
            body: fallbackErr instanceof Error ? fallbackErr.message : '',
            clickTarget: notifyClickTarget,
          });
        }
        const latest = await reloadLatestSession(session.sessionId, true);
        const lastMessage = latest?.messages[latest.messages.length - 1];
        setShowRetry(lastMessage?.role === 'user');
        setStreamingMessage('');
      }
    } finally {
      if (sendAbortController.current === abortController) {
        sendAbortController.current = null;
      }
      if (mountedRef.current) {
        setIsStreaming(false);
        setSending(false);
      }
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
      if (notificationSettings) {
        notificationCenter.notify(notificationSettings, {
          eventType: 'completed',
          dedupeKey: `completed:${result.session.sessionId}:${result.session.revision}`,
          title: '相談の返答が完了しました',
          body: '',
          clickTarget: { kind: 'setup' },
        });
      }
      applySessionWithDraftChanges(session, result.session);
      setDirtyDraftEditKeys(new Set());
      rememberSetupSession(result.session.sessionId, purpose);
      setSuggestedActions(result.suggestedActions);
      setShowRetry(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '再試行に失敗しました');
      if (notificationSettings) {
        notificationCenter.notify(notificationSettings, {
          eventType: 'failed',
          dedupeKey: `failed:retry-${session.sessionId}-${Date.now()}`,
          title: '相談の再試行に失敗しました',
          body: err instanceof Error ? err.message : '',
          clickTarget: { kind: 'setup' },
        });
      }
      const latest = await reloadLatestSession(session.sessionId, true);
      const lastMessage = latest?.messages[latest.messages.length - 1];
      setShowRetry(lastMessage?.role === 'user');
    } finally {
      setSending(false);
    }
  }

  async function handlePreview(styleHint = '') {
    if (!session || previewing || modelUnavailable) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから試し書きしてください。');
      return;
    }
    try {
      setPreviewing(true);
      setError(null);
      const result = await api.previewSetup(session.sessionId, styleHint.trim() || undefined);
      applySessionWithDraftChanges(session, result.session, { preserveSummaryOnRevisionOnly: true });
      rememberSetupSession(result.session.sessionId, purpose);
      setPreviewText(result.previewText);
    } catch (err) {
      setError(err instanceof Error ? err.message : '試し書きに失敗しました');
    } finally {
      setPreviewing(false);
    }
  }

  async function handleCommit() {
    if (!session || committing) return;
    if (hasUnsavedDraftEdits) {
      setError('メモに未保存の変更があります。保存してから作品化してください。');
      return;
    }
    if (!hasMeaningfulContent) {
      setError('作品の種がまだありません。相談するか、作品の種メモを入力してください。');
      return;
    }
    try {
      setCommitting(true);
      setCommitStage('planning');
      setError(null);
      setCommitError(null);
      const planResult = await api.createSetupCommitPlan(session.sessionId);
      setSession(planResult.session);
      setCommitPlan(planResult.plan);
      setCommitRevision(planResult.revision);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作品化に失敗しました');
    } finally {
      setCommitting(false);
      setCommitStage(null);
    }
  }

  async function runSuggestedAction(action: SetupSuggestedAction) {
    if (action.intent === 'preview') {
      await handlePreview();
      return;
    }
    if (action.intent === 'commit') {
      await handleCommit();
      return;
    }
    await send(action.message);
  }

  function suggestedActionDisabled(action: SetupSuggestedAction): boolean {
    return (
      busy ||
      hasUnsavedDraftEdits ||
      modelUnavailable ||
      (action.intent === 'commit' && !hasMeaningfulContent)
    );
  }

  async function confirmCommit() {
    if (!session || !commitPlan || commitRevision === null || committing) return;
    const title = commitPlan.project.title.trim();
    if (!title) {
      setCommitError('作品タイトルを入力してください。');
      return;
    }
    try {
      setCommitting(true);
      setCommitStage('saving');
      setError(null);
      setCommitError(null);
      const commitResult = await api.commitSetup(session.sessionId, {
        plan: { ...commitPlan, project: { ...commitPlan.project, title } },
        revision: commitRevision,
      });
      setSession(commitResult.session);
      forgetSetupSession(commitResult.session.sessionId, purpose);
      onCreated(commitResult.projectId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : '作品化に失敗しました';
      if (detail.includes('コード: revision_conflict')) {
        await reloadLatestSession(session.sessionId);
        setCommitPlan(null);
        setCommitRevision(null);
        setCommitError(null);
        setError('相談内容が更新されたため、作品にする内容をもう一度確認してください。');
        window.setTimeout(() => createProjectButtonRef.current?.focus(), 0);
      } else {
        setCommitError(detail);
      }
    } finally {
      setCommitting(false);
      setCommitStage(null);
    }
  }

  function closeCommitReview() {
    setCommitPlan(null);
    setCommitRevision(null);
    setCommitError(null);
    window.setTimeout(() => createProjectButtonRef.current?.focus(), 0);
  }

  async function saveSessionModel() {
    if (!session || busy || !sessionModelProvider || !sessionModelName.trim()) return;
    try {
      setSavingDraft(true);
      setError(null);
      const result = await api.patchSetupSettings(session.sessionId, {
        model: { provider: sessionModelProvider, modelName: sessionModelName.trim() },
        revision: session.revision,
      });
      setSession(result.session);
      clearDraftChanges();
      rememberSetupSession(result.session.sessionId, purpose);
    } catch (err) {
      setError(err instanceof Error ? err.message : '相談モデルを変更できませんでした');
      await reloadLatestSession(session.sessionId, true);
    } finally {
      setSavingDraft(false);
    }
  }

  async function saveStyleSettings(activePresetIds: ActivePresets) {
    if (!session || busy) return;
    try {
      setSavingDraft(true);
      setError(null);
      const result = await api.patchSetupSettings(session.sessionId, {
        activePresetIds,
        revision: session.revision,
      });
      setSession(result.session);
      clearDraftChanges();
      rememberSetupSession(result.session.sessionId, purpose);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作風設定を変更できませんでした');
      await reloadLatestSession(session.sessionId, true);
    } finally {
      setSavingDraft(false);
    }
  }

  async function reloadLatestSession(
    sessionId: string,
    preserveDraftChangesIfUnchanged = false
  ): Promise<SetupSession | null> {
    try {
      const latest = await api.getSetupSession(sessionId);
      if (latest.status === 'active') {
        if (preserveDraftChangesIfUnchanged && session?.sessionId === latest.sessionId) {
          applySessionWithDraftChanges(session, latest, { preserveSummaryOnRevisionOnly: true });
        } else {
          setSession(latest);
          clearDraftChanges();
        }
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(latest.sessionId, purpose);
        return latest;
      } else {
        forgetSetupSession(sessionId, purpose);
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
      clearDraftChanges();
      rememberSetupSession(result.session.sessionId, purpose);
      setSuggestedActions([]);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'メモの保存に失敗しました');
      await reloadLatestSession(session.sessionId, true);
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
      clearDraftChanges();
      rememberSetupSession(result.session.sessionId, purpose);
    } catch (err) {
      setError(err instanceof Error ? err.message : '固定状態の更新に失敗しました');
      await reloadLatestSession(session.sessionId, true);
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
      <header className="setup-header" inert={Boolean(commitPlan)} aria-hidden={Boolean(commitPlan)}>
        <div>
          <h1>
            {purpose === 'roleplay' ? 'キャラと話す作品を作る' : '相談して作る'}
            {purpose === 'roleplay' && (
              <span
                style={{
                  marginLeft: '0.6rem',
                  padding: '0.15rem 0.6rem',
                  fontSize: '0.7rem',
                  borderRadius: '999px',
                  background: 'var(--accent)',
                  color: 'var(--surface)',
                  verticalAlign: 'middle',
                  fontWeight: 500,
                }}
              >
                ロールプレイ
              </span>
            )}
          </h1>
          <p>
            {purpose === 'roleplay'
              ? '会話したいキャラクターの姿を話してください。3〜5往復で会話を始められる状態を目指します。'
              : '読みたい物語の種を、そのまま話してください。'}
          </p>
        </div>
        <div className="setup-header-actions">
          <button type="button" onClick={onCancel} disabled={busy}>戻る</button>
          <button type="button" onClick={startNewSession} disabled={busy}>
            {creatingNew ? '準備中...' : '新しい相談'}
          </button>
          <button type="button" onClick={onOpenSettings} disabled={busy}>
            アプリ設定
          </button>
          <button type="button" onClick={() => void handlePreview()} disabled={!session || busy || hasUnsavedDraftEdits || modelUnavailable}>
            {previewing ? <GeneratingLabel text="試し書き中..." /> : '試し書き'}
          </button>
          <button
            type="button"
            ref={createProjectButtonRef}
            className="primary"
            onClick={handleCommit}
            disabled={!session || busy || hasUnsavedDraftEdits || modelUnavailable || !hasMeaningfulContent}
            title={!hasMeaningfulContent ? '相談するか、作品の種メモを入力してください' : undefined}
          >
            {committing ? (
              <GeneratingLabel text={commitStage === 'saving' ? '作品を保存中...' : '設定を整理中...'} />
            ) : 'この内容で作品を作る'}
          </button>
        </div>
      </header>

      {error && <div className="error-toast setup-error">{error}</div>}
      {session?.lastError && !error && (
        <div className="error-toast setup-error">{session.lastError.message}</div>
      )}

      {session && (
        <section
          className="setup-model-bar"
          aria-label="この相談のモデル"
          inert={Boolean(commitPlan)}
          aria-hidden={Boolean(commitPlan)}
        >
          <div>
            <strong>この相談のモデル:</strong>{' '}
            {currentProvider?.label ?? session.model.provider} / {session.model.modelName}
          </div>
          <details>
            <summary>変更</summary>
            <div className="setup-model-controls">
              <label>
                プロバイダー
                <select
                  value={sessionModelProvider}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSessionModelProvider(next);
                    setSessionModelName(
                      providers.find((provider) => provider.name === next)?.defaultModel ?? ''
                    );
                  }}
                  disabled={busy}
                >
                  {providers.map((provider) => (
                    <option key={provider.name} value={provider.name}>
                      {provider.label}{provider.hasApiKey === false ? '（キー未設定）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                モデル名
                <input
                  value={sessionModelName}
                  onChange={(event) => setSessionModelName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <button
                type="button"
                onClick={saveSessionModel}
                disabled={busy || !sessionModelProvider || !sessionModelName.trim()}
              >
                この相談のモデルを変更
              </button>
              <span>会話履歴は残り、次の返答から新しいモデルを使います。</span>
            </div>
          </details>
        </section>
      )}

      {purpose === 'novel' && session && (
        <section
          className="setup-model-bar setup-style-settings-bar"
          aria-label="この作品の作風設定"
          inert={Boolean(commitPlan)}
          aria-hidden={Boolean(commitPlan)}
        >
          <details>
            <summary>
              <strong>作風設定</strong>
              <span> — 視点・境界・読み味など</span>
            </summary>
            {presetCategories ? (
              <PresetSelector
                categories={presetCategories}
                value={normalizeActivePresetIds(session.projectSettings.activePresetIds)}
                onChange={(value) => void saveStyleSettings(value)}
                disabled={busy}
                namePrefix="setup-style"
              />
            ) : (
              <p className="settings-help">作風設定を読み込み中…</p>
            )}
          </details>
        </section>
      )}

      <main className="setup-main" inert={Boolean(commitPlan)} aria-hidden={Boolean(commitPlan)}>
          <section className="setup-chat" aria-label="相談チャット">
          <div className="setup-messages">
            {isColdStart ? (
              <article className="setup-message assistant setup-welcome-message">
                <div className="setup-message-role">相談相手</div>
                <p>どんな物語を読みたいですか？ 好きな雰囲気や関係性だけでも大丈夫です。一緒に見つけましょう。</p>
              </article>
            ) : session && session.messages.length > 0 ? (
              session.messages.map((entry) => (
                <article key={entry.messageId} className={`setup-message ${entry.role}`}>
                  <div className="setup-message-role">
                    {entry.role === 'user' ? 'あなた' : '相談相手'}
                  </div>
                  <LightMarkdown text={entry.content} />
                </article>
              ))
            ) : (
              <div className="setup-empty-chat">
                <p>メモをもとに、読みたい物語の続きを相談できます。</p>
              </div>
            )}
            {(isStreaming || streamingMessage) && (
              <article key="streaming" className="setup-message assistant">
                <div className="setup-message-role">相談相手</div>
                <LightMarkdown text={streamingMessage} />
              </article>
            )}
          </div>

          {visibleSuggestedActions.length > 0 && (
            <div
              className={`setup-suggestions${isColdStart ? ' setup-suggestions--starter' : ''}`}
              aria-label={isColdStart ? '相談の始め方' : '次にできること'}
            >
              {visibleSuggestedActions.map((action) => (
                <button
                  key={`${action.intent ?? 'message'}-${action.label}-${action.message}`}
                  type="button"
                  onClick={() => void runSuggestedAction(action)}
                  disabled={suggestedActionDisabled(action)}
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
              {currentProvider?.label ?? session?.model.provider} のAPIキーが未設定です。アプリ設定で入力してください。
              <button type="button" onClick={onOpenSettings} disabled={busy}>
                アプリ設定を開く
              </button>
            </div>
          )}
          {modelAvailabilityPending && (
            <div className="setup-api-key-warning">モデル設定を確認中です...</div>
          )}
          {currentProviderUnavailable && (
            <div className="setup-api-key-warning">
              現在のモデル情報を確認できません。アプリ設定を確認してください。
              <button type="button" onClick={onOpenSettings} disabled={busy}>
                アプリ設定を開く
              </button>
            </div>
          )}

          <form className="setup-input" onSubmit={handleSubmit}>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="読みたい物語の雰囲気、好きな関係性、避けたい展開など"
              disabled={busy || modelUnavailable}
            />
            {isStreaming ? (
              <button type="button" className="danger" onClick={abortStreaming}>
                中断
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={busy || hasUnsavedDraftEdits || !message.trim() || modelUnavailable}
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
          {hasDraftChanges && (
            <div className="setup-draft-updates" role="status">
              <strong>このターンのメモ更新</strong>
              <ul>
                {draftChangeSummary.slice(0, 6).map((change) => (
                  <li key={change.key}>{change.text}</li>
                ))}
              </ul>
              {draftChangeSummary.length > 6 && <p>ほか{draftChangeSummary.length - 6}件</p>}
              <p>追加・更新された項目はメモ内でも強調表示しています。</p>
            </div>
          )}
          {draft ? (
            <>
              <CoreConceptEditor
                dirtyKey="draft.coreConcept"
                value={draft.coreConcept}
                disabled={busy}
                locked={pathLocked('draft.coreConcept')}
                changeKind={draftChanges.coreConcept}
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
                changes={draftChanges}
                changeSection="confirmed"
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
                changes={draftChanges}
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
                changes={draftChanges}
                changeSection="undecided"
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
                changes={draftChanges}
                purpose={purpose}
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
                    target.traits = values.traits.length > 0 ? values.traits : undefined;
                    target.secrets = values.secrets.trim() || undefined;
                    // NOTE: roleplay 用途のみ更新。novel では onSave の values に
                    // greeting/dialogueExamples が含まれない（undefined）ため
                    // 既存値をそのまま保持する。
                    if (values.greeting !== undefined) {
                      target.greeting = values.greeting.trim() || undefined;
                    }
                    if (values.dialogueExamples !== undefined) {
                      target.dialogueExamples =
                        values.dialogueExamples.length > 0 ? values.dialogueExamples : undefined;
                    }
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
                      traits: values.traits.length > 0 ? values.traits : undefined,
                      secrets: values.secrets.trim() || undefined,
                      greeting:
                        values.greeting !== undefined && values.greeting.trim()
                          ? values.greeting.trim()
                          : undefined,
                      dialogueExamples:
                        values.dialogueExamples && values.dialogueExamples.length > 0
                          ? values.dialogueExamples
                          : undefined,
                      source: 'manual',
                      status: 'active',
                    } as SetupDraftCharacter);
                  });
                  if (ok) removePendingCharacter(id);
                }}
              />
              <DraftStringList
                section="world"
                items={draft.world}
                disabled={busy}
                changes={draftChanges}
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
                section="relationshipSeeds"
                items={draft.relationshipSeeds}
                disabled={busy}
                changes={draftChanges}
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
                section="tone"
                items={draft.tone}
                disabled={busy}
                changes={draftChanges}
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
                section="ng"
                items={draft.ng}
                disabled={busy}
                changes={draftChanges}
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
              {/* NOTE: openingSeeds は novel 用途の「第1話冒頭候補」。roleplay では
                    使わないため非表示にする（設計 1.5 の用途別UI）。 */}
              {purpose === 'novel' && (
                <DraftStringList
                  section="openingSeeds"
                  items={draft.openingSeeds}
                  disabled={busy}
                  changes={draftChanges}
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
              )}
              {/* NOTE: roleplay 用途では会話舞台候補（scenarioSeeds）を編集できる。
                    novel では常に空配列なので非表示。 */}
              {purpose === 'roleplay' && (
                <DraftStringList
                  section="scenarioSeeds"
                  items={draft.scenarioSeeds ?? []}
                  disabled={busy}
                  changes={draftChanges}
                  locked={pathLocked('draft.scenarioSeeds')}
                  onDirtyChange={markDraftDirty}
                  onSave={(index, value) => saveStringItem('scenarioSeeds', index, value)}
                  onRemove={(index) => removeStringItem('scenarioSeeds', index)}
                  onToggleLock={() =>
                    toggleLock('draft.scenarioSeeds', !pathLocked('draft.scenarioSeeds'))
                  }
                  onAdd={() => addPendingString('scenarioSeeds')}
                  pendingRows={pendingStrings.scenarioSeeds}
                  onCancelPending={(id) => removePendingString('scenarioSeeds', id)}
                  onSavePending={async (id, value) => {
                    const ok = await saveDraft((nextDraft) => {
                      if (!nextDraft.scenarioSeeds) nextDraft.scenarioSeeds = [];
                      nextDraft.scenarioSeeds.push(value.trim());
                    });
                    if (ok) removePendingString('scenarioSeeds', id);
                  }}
                />
              )}
            </>
          ) : (
            <p className="placeholder">まだメモはありません。</p>
          )}
          {previewText && (
            <section className="setup-preview">
              <h3>試し書き</h3>
              <LightMarkdown text={previewText} />
              <div className="setup-preview-adjustments">
                <p>もう少し好みに寄せる</p>
                <div className="setup-preview-adjustment-chips">
                  {PREVIEW_STYLE_HINTS.map((styleHint) => (
                    <button
                      key={styleHint}
                      type="button"
                      onClick={() => void handlePreview(styleHint)}
                      disabled={busy || hasUnsavedDraftEdits || modelUnavailable}
                    >
                      {styleHint}
                    </button>
                  ))}
                </div>
                <form
                  className="setup-preview-adjustment-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handlePreview(previewStyleHint);
                  }}
                >
                  <label>
                    自由に指定
                    <input
                      aria-label="試し書きの調整"
                      value={previewStyleHint}
                      onChange={(event) => setPreviewStyleHint(event.target.value)}
                      placeholder="例: 地の文を短めに"
                      disabled={busy || modelUnavailable}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy || hasUnsavedDraftEdits || modelUnavailable || !previewStyleHint.trim()}
                  >
                    この希望で再生成
                  </button>
                </form>
                <p className="setup-preview-adjustment-note">調整内容は好み・文体にも反映されます。</p>
              </div>
            </section>
          )}
        </aside>
      </main>
      {commitPlan && (
        <div className="setup-modal-backdrop">
          <section
            className="setup-commit-review"
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-commit-title"
          >
            <header>
              <h2 id="setup-commit-title">作品にする内容を確認</h2>
              <p>タイトル、作品の核、人物、第1話の入り方を確認してください。作成後も作品設定から変更できます。</p>
            </header>
            {commitError && <div className="error-toast" role="alert">{commitError}</div>}
            <label>
              作品タイトル
              <input
                autoFocus
                value={commitPlan.project.title}
                onChange={(event) =>
                  setCommitPlan((current) => current ? {
                    ...current,
                    project: { ...current.project, title: event.target.value },
                  } : current)
                }
                maxLength={100}
              />
            </label>
            <label>
              作品の核
              <textarea
                value={commitPlan.coreConcept ?? ''}
                onChange={(event) =>
                  setCommitPlan((current) => current ? { ...current, coreConcept: event.target.value } : current)
                }
                rows={3}
              />
            </label>
            <label>
              世界の土台
              <textarea
                value={commitPlan.world.foundation}
                onChange={(event) =>
                  setCommitPlan((current) => current
                    ? {
                        ...current,
                        world: { ...current.world, foundation: event.target.value },
                      }
                    : current)
                }
                rows={4}
                placeholder="物語進行で変わらない法則・地理・文化など"
              />
            </label>
            <label>
              開始時点の状況
              <textarea
                value={commitPlan.world.initialSituation}
                onChange={(event) =>
                  setCommitPlan((current) => current
                    ? {
                        ...current,
                        world: { ...current.world, initialSituation: event.target.value },
                      }
                    : current)
                }
                rows={4}
                placeholder="勢力関係・季節・直近の出来事など、進行で変わりうる状況"
              />
            </label>
            <label>
              第1話冒頭への希望
              <textarea
                value={commitPlan.firstWishSuggestion ?? ''}
                onChange={(event) =>
                  setCommitPlan((current) => current
                    ? { ...current, firstWishSuggestion: event.target.value }
                    : current)
                }
                rows={3}
                maxLength={300}
              />
              <span className="settings-help">作品化後、Readerの第1話への希望として入ります。</span>
            </label>
            <div>
              <h3>人物</h3>
              {commitPlan.characters.length === 0 ? (
                <p className="setup-draft-placeholder">人物はまだ設定されていません。</p>
              ) : (
                <ul className="setup-commit-edit-list">
                  {commitPlan.characters.map((character, index) => (
                    <li className="setup-commit-edit-row" key={character.characterId}>
                      <input
                        aria-label={`人物${index + 1}の名前`}
                        value={character.name}
                        placeholder={`人物${index + 1}の名前`}
                        onChange={(event) =>
                          setCommitPlan((current) => current ? {
                            ...current,
                            characters: current.characters.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, name: event.target.value } : item
                            ),
                          } : current)
                        }
                      />
                      <select
                        aria-label={`人物${index + 1}の役割`}
                        value={character.role}
                        onChange={(event) =>
                          setCommitPlan((current) => current ? {
                            ...current,
                            characters: current.characters.map((item, itemIndex) =>
                              itemIndex === index
                                ? { ...item, role: event.target.value as CharacterRole }
                                : item
                            ),
                          } : current)
                        }
                      >
                        {Object.entries(ROLE_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="setup-commit-row-actions">
              <button
                type="button"
                onClick={closeCommitReview}
                disabled={committing}
              >
                相談に戻る
              </button>
              <button
                type="button"
                className="primary"
                onClick={confirmCommit}
                disabled={committing || !commitPlan.project.title.trim()}
              >
                {committing ? <GeneratingLabel text="作品を保存中..." /> : 'この内容で作品を作る'}
              </button>
            </div>
          </section>
        </div>
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

async function createDefaultSetupSession(
  knownProviders?: ModelProviderInfo[],
  purpose: 'novel' | 'roleplay' = 'novel'
) {
  const providers =
    knownProviders && knownProviders.length > 0
      ? knownProviders
      : await api.getModelProviders().catch(() => [] as ModelProviderInfo[]);
  const savedModel = await api.getDefaultModelSettings().catch(() => null);
  const savedProvider = savedModel
    ? providers.find((provider) => provider.name === savedModel.provider)
    : undefined;
  const defaultProvider = savedProvider ?? providers.find((provider) => provider.name === 'gemini') ?? providers[0];
  const modelName = savedProvider && savedModel?.modelName.trim()
    ? savedModel.modelName.trim()
    : defaultProvider?.defaultModel;
  return api.createSetupSession({
    projectSettings: DEFAULT_PROJECT_SETTINGS,
    model: defaultProvider
      ? { provider: defaultProvider.name, modelName: modelName ?? defaultProvider.defaultModel }
      : undefined,
    purpose,
  });
}

async function syncFreshSessionModel(session: SetupSession): Promise<{ session: SetupSession; error?: string }> {
  if (session.messages.length > 0) return { session };
  const defaultModel = await api.getDefaultModelSettings().catch(() => null);
  const modelName = defaultModel?.modelName.trim();
  if (!defaultModel || !modelName) return { session };
  if (session.model.provider === defaultModel.provider && session.model.modelName === modelName) {
    return { session };
  }
  try {
    const result = await api.patchSetupSettings(session.sessionId, {
      model: { provider: defaultModel.provider, modelName },
      revision: session.revision,
    });
    return { session: result.session };
  } catch (err) {
    console.warn('[setup] Failed to sync default model into fresh session', err);
    const detail = err instanceof Error ? err.message : '不明なエラー';
    return {
      session,
      error: `アプリ設定のモデルをこの相談に反映できませんでした: ${detail}`,
    };
  }
}

async function findRestorableSetupSession(
  purpose: 'novel' | 'roleplay' = 'novel'
): Promise<SetupSession | null> {
  const storedId = readStoredSetupSessionId(purpose);
  if (storedId) {
    const stored = await api.getSetupSession(storedId).catch(() => null);
    if (
      stored?.status === 'active' &&
      (stored.purpose ?? 'novel') === purpose
    ) {
      return stored;
    }
    forgetSetupSession(storedId, purpose);
  }

  const summaries = await api.listSetupSessions().catch(() => []);
  // NOTE: サマリーの purpose は必ずサーバーで正規化されている。同じ purpose の
  // active セッションだけを復元候補にする（設計書 1.5）。
  const latestActive = summaries.find(
    (summary) => summary.status === 'active' && summary.purpose === purpose
  );
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
