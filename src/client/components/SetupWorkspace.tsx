import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../clientApi';
import { GeneratingLabel } from './GeneratingLabel';
import LightMarkdown from './LightMarkdown';
import { DEFAULT_ACTIVE_PRESET_IDS } from '@shared/defaults';
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
  SetupSuggestedAction,
} from '@shared/types';

interface Props {
  purpose?: 'novel' | 'roleplay';
  onCreated: (projectId: string) => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}

type StringDraftSection =
  | 'relationshipSeeds'
  | 'world'
  | 'tone'
  | 'ng'
  | 'openingSeeds'
  | 'scenarioSeeds';
type DraftItemSection = 'confirmed' | 'candidates' | 'undecided' | 'characters';
type DraftChangeKind = 'added' | 'updated' | 'archived';
type DraftChanges = Record<string, DraftChangeKind>;

interface DraftChangeSummary {
  key: string;
  kind: DraftChangeKind;
  text: string;
}

interface PendingDescriptor {
  id: string;
}

const SETUP_SESSION_STORAGE_KEY_BASE = 'chapterflow:lastSetupSessionId';
const LEGACY_SETUP_SESSION_STORAGE_KEY_BASE = 'yumeweaving:lastSetupSessionId';
// NOTE: purpose 別に localStorage キーを分ける。roleplay 入口から novel の未commit
// セッションを誤復元しないための境界（設計書 1.5）。
function setupSessionStorageKey(purpose: 'novel' | 'roleplay'): string {
  return purpose === 'roleplay'
    ? `${SETUP_SESSION_STORAGE_KEY_BASE}:roleplay`
    : `${SETUP_SESSION_STORAGE_KEY_BASE}:novel`;
}

function legacySetupSessionStorageKey(purpose: 'novel' | 'roleplay'): string {
  return purpose === 'roleplay'
    ? `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:roleplay`
    : `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:novel`;
}

const DEFAULT_PROJECT_SETTINGS = {
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: { ...DEFAULT_ACTIVE_PRESET_IDS },
};

const ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主人公',
  deuteragonist: '相手役',
  supporting: '脇役',
  other: 'その他',
};

const DRAFT_STRING_SECTION_LABELS = {
  relationshipSeeds: '関係性',
  world: '世界観',
  tone: '好み・文体',
  ng: 'NG',
  openingSeeds: '冒頭候補',
  scenarioSeeds: 'シナリオ（会話の舞台）',
} satisfies Record<StringDraftSection, string>;

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
      !window.confirm('今の相談を終了して、新しい相談を始めますか？')
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
            applySessionWithDraftChanges(session, response.session);
            setDirtyDraftEditKeys(new Set());
            rememberSetupSession(response.session.sessionId, purpose);
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
        applySessionWithDraftChanges(session, result.session);
        setDirtyDraftEditKeys(new Set());
        rememberSetupSession(result.session.sessionId, purpose);
        setSuggestedActions(result.suggestedActions);
        setMessage('');
        setShowRetry(false);
        setStreamingMessage('');
      } catch (fallbackErr) {
        setError(fallbackErr instanceof Error ? fallbackErr.message : '送信に失敗しました');
        const latest = await reloadLatestSession(session.sessionId, true);
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
      applySessionWithDraftChanges(session, result.session);
      setDirtyDraftEditKeys(new Set());
      rememberSetupSession(result.session.sessionId, purpose);
      setSuggestedActions(result.suggestedActions);
      setShowRetry(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '再試行に失敗しました');
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

function DraftChangeBadge({ kind }: { kind: DraftChangeKind }) {
  return <span className="setup-draft-update-badge">{draftChangeKindLabel(kind)}</span>;
}

function CoreConceptEditor({
  dirtyKey,
  value,
  disabled,
  locked,
  changeKind,
  onDirtyChange,
  onSave,
  onToggleLock,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  locked: boolean;
  changeKind?: DraftChangeKind;
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
    <section className={`setup-draft-section${changeKind ? ' is-recently-updated' : ''}`}>
      <div className="setup-draft-section-header">
        <h3>作品の核</h3>
        <div className="setup-draft-section-actions">
          {changeKind && <DraftChangeBadge kind={changeKind} />}
          <button type="button" onClick={onToggleLock} disabled={disabled}>
            {locked ? '固定解除' : '固定'}
          </button>
        </div>
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
  changes,
  changeSection,
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
  changes: DraftChanges;
  changeSection: 'confirmed' | 'undecided';
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
              changeKind={changes[draftItemChangeKey(changeSection, item.id)]}
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
  changeKind,
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
  changeKind?: DraftChangeKind;
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
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
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
  changes,
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
  changes: DraftChanges;
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
              changeKind={changes[draftItemChangeKey('candidates', candidate.id)]}
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
  changeKind,
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
  changeKind?: DraftChangeKind;
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
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
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

// NOTE: character 編集 UI で受け付ける値の共通形。greeting/dialogueExamples は
// roleplay 用途でだけ入力欄が出るが、型は常に optional で共通化する。呼び出し側は
// 値が undefined の場合は既存値をそのまま維持する（未編集扱い）判定を行う。
interface EditableCharacterValues {
  role: CharacterRole;
  name: string;
  label: string;
  description: string;
  speechStyle: string;
  relationshipNotes: string;
  greeting?: string;
  dialogueExamples?: string[];
}

function DraftCharacterList({
  draft,
  disabled,
  changes,
  purpose,
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
  changes: DraftChanges;
  purpose: 'novel' | 'roleplay';
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: SetupDraftCharacter) => boolean;
  onSave: (item: SetupDraftCharacter, values: EditableCharacterValues) => void;
  onArchive: (item: SetupDraftCharacter) => void;
  onToggleLock: (item: SetupDraftCharacter) => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, values: EditableCharacterValues) => void;
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
              changeKind={changes[draftItemChangeKey('characters', character.id)]}
              purpose={purpose}
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
              purpose={purpose}
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
  changeKind,
  purpose,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
}: {
  dirtyKey: string;
  character: SetupDraftCharacter;
  disabled: boolean;
  locked: boolean;
  changeKind?: DraftChangeKind;
  purpose: 'novel' | 'roleplay';
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
      greeting?: string;
      dialogueExamples?: string[];
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
  // NOTE: dialogueExamples は行区切りテキストとして編集 → 保存時に配列へ戻す。
  // greeting は roleplay 用途のみで意味を持つが state は常時保持し UI だけ切替。
  const [greeting, setGreeting] = useState(character.greeting ?? '');
  const [dialogueExamplesText, setDialogueExamplesText] = useState(
    (character.dialogueExamples ?? []).join('\n')
  );

  useEffect(() => {
    setRole(character.role);
    setName(character.name);
    setLabel(character.label);
    setDescription(character.description);
    setSpeechStyle(character.speechStyle ?? '');
    setRelationshipNotes(character.relationshipNotes ?? '');
    setGreeting(character.greeting ?? '');
    setDialogueExamplesText((character.dialogueExamples ?? []).join('\n'));
  }, [
    character.id,
    character.role,
    character.name,
    character.label,
    character.description,
    character.speechStyle,
    character.relationshipNotes,
    character.greeting,
    character.dialogueExamples,
  ]);

  const dialogueExamplesArray = useMemo(
    () =>
      dialogueExamplesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 5),
    [dialogueExamplesText]
  );
  const existingDialogueExamples = character.dialogueExamples ?? [];
  const dialogueExamplesChanged =
    dialogueExamplesArray.length !== existingDialogueExamples.length ||
    dialogueExamplesArray.some((item, i) => item !== existingDialogueExamples[i]);

  const changed =
    role !== character.role ||
    name.trim() !== character.name.trim() ||
    label.trim() !== character.label.trim() ||
    description.trim() !== character.description.trim() ||
    speechStyle.trim() !== (character.speechStyle ?? '').trim() ||
    relationshipNotes.trim() !== (character.relationshipNotes ?? '').trim() ||
    (purpose === 'roleplay' &&
      (greeting.trim() !== (character.greeting ?? '').trim() || dialogueExamplesChanged));

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
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
      {purpose === 'roleplay' && (
        <>
          <textarea
            className="setup-draft-textarea compact"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="会話開始時の挨拶（1〜3文、最大500字）"
            maxLength={500}
            disabled={disabled}
          />
          <textarea
            className="setup-draft-textarea compact"
            value={dialogueExamplesText}
            onChange={(e) => setDialogueExamplesText(e.target.value)}
            placeholder="口調のセリフ例（1行1件、最大5件、各200字）"
            rows={3}
            disabled={disabled}
          />
        </>
      )}
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() =>
            onSave(character, {
              role,
              name,
              label,
              description,
              speechStyle,
              relationshipNotes,
              ...(purpose === 'roleplay'
                ? { greeting, dialogueExamples: dialogueExamplesArray }
                : {}),
            })
          }
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
  purpose,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  purpose: 'novel' | 'roleplay';
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (values: EditableCharacterValues) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<CharacterRole>('supporting');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [speechStyle, setSpeechStyle] = useState('');
  const [relationshipNotes, setRelationshipNotes] = useState('');
  const [greeting, setGreeting] = useState('');
  const [dialogueExamplesText, setDialogueExamplesText] = useState('');

  const changed =
    role !== 'supporting' ||
    name.trim() !== '' ||
    label.trim() !== '' ||
    description.trim() !== '' ||
    speechStyle.trim() !== '' ||
    relationshipNotes.trim() !== '' ||
    (purpose === 'roleplay' &&
      (greeting.trim() !== '' || dialogueExamplesText.trim() !== ''));

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
      {purpose === 'roleplay' && (
        <>
          <textarea
            className="setup-draft-textarea compact"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="会話開始時の挨拶（1〜3文、最大500字）"
            maxLength={500}
            disabled={disabled}
          />
          <textarea
            className="setup-draft-textarea compact"
            value={dialogueExamplesText}
            onChange={(e) => setDialogueExamplesText(e.target.value)}
            placeholder="口調のセリフ例（1行1件、最大5件、各200字）"
            rows={3}
            disabled={disabled}
          />
        </>
      )}
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => {
            const dialogueExamplesArray = dialogueExamplesText
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .slice(0, 5);
            onSave({
              role,
              name,
              label,
              description,
              speechStyle,
              relationshipNotes,
              ...(purpose === 'roleplay'
                ? { greeting, dialogueExamples: dialogueExamplesArray }
                : {}),
            });
          }}
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
  section,
  items,
  disabled,
  changes,
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
  section: StringDraftSection;
  items: string[];
  disabled: boolean;
  changes: DraftChanges;
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
  const title = DRAFT_STRING_SECTION_LABELS[section];
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
              changeKind={changes[draftStringChangeKey(section, index)]}
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
  changeKind,
  onDirtyChange,
  onSave,
  onRemove,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  changeKind?: DraftChangeKind;
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
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
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

export function collectDraftChanges(previous: SetupDraft, next: SetupDraft): DraftChangeSummary[] {
  const summary: DraftChangeSummary[] = [];

  if (previous.coreConcept.trim() !== next.coreConcept.trim()) {
    recordDraftChange(summary, 'coreConcept', previous.coreConcept.trim() ? 'updated' : 'added', '作品の核');
  }

  collectItemChanges(
    summary,
    'confirmed',
    previous.confirmed,
    next.confirmed,
    (item) => JSON.stringify([item.text, item.reason ?? '', item.status]),
    (item) => `決まってきたこと「${shortenDraftChangeText(item.text)}」`
  );
  collectItemChanges(
    summary,
    'candidates',
    previous.candidates,
    next.candidates,
    (item) => JSON.stringify([item.title, item.summary, item.status]),
    (item) => `候補「${shortenDraftChangeText(item.title || item.summary)}」`
  );
  collectItemChanges(
    summary,
    'undecided',
    previous.undecided,
    next.undecided,
    (item) => JSON.stringify([item.text, item.reason ?? '', item.status]),
    (item) => `未確定「${shortenDraftChangeText(item.text)}」`
  );
  collectItemChanges(
    summary,
    'characters',
    previous.characters,
    next.characters,
    (item) =>
      JSON.stringify([
        item.role,
        item.name,
        item.label,
        item.description,
        item.speechStyle ?? '',
        item.relationshipNotes ?? '',
        item.want ?? '',
        item.fear ?? '',
        item.secret ?? '',
        item.status,
      ]),
    (item) => `人物「${shortenDraftChangeText(item.label || item.name || ROLE_LABELS[item.role])}」`
  );

  for (const section of Object.keys(DRAFT_STRING_SECTION_LABELS) as StringDraftSection[]) {
    // NOTE: 古いテスト・保存データが scenarioSeeds を持たない場合の後方互換。
    // previous/next のいずれかが undefined でも空配列として扱う。
    collectStringChanges(summary, section, previous[section] ?? [], next[section] ?? []);
  }

  return summary;
}

function collectItemChanges<T extends { id: string; status: string }>(
  summary: DraftChangeSummary[],
  section: DraftItemSection,
  previous: T[],
  next: T[],
  signature: (item: T) => string,
  label: (item: T) => string
) {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));

  for (const item of previous) {
    const nextItem = nextById.get(item.id);
    if (item.status === 'active' && (!nextItem || nextItem.status !== 'active')) {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'archived', label(item));
    }
  }

  for (const item of next) {
    const previousItem = previousById.get(item.id);
    if (!previousItem && item.status === 'active') {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'added', label(item));
    } else if (previousItem?.status === 'active' && item.status !== 'active') {
      continue;
    } else if (previousItem && item.status === 'active' && signature(previousItem) !== signature(item)) {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'updated', label(item));
    }
  }
}

function collectStringChanges(
  summary: DraftChangeSummary[],
  section: StringDraftSection,
  previousValues: string[],
  nextValues: string[]
) {
  const matchingPairs = findLongestCommonStringPairs(previousValues, nextValues);
  const movedPairs = collectMovedStringPairs(previousValues, nextValues, matchingPairs);
  const movedPreviousIndexes = new Set(movedPairs.map(([previousIndex]) => previousIndex));
  const movedNextIndexes = new Set(movedPairs.map(([, nextIndex]) => nextIndex));
  const sectionLabel = DRAFT_STRING_SECTION_LABELS[section];

  for (const [, nextIndex] of movedPairs.sort((a, b) => a[1] - b[1])) {
    const nextValue = nextValues[nextIndex];
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'updated',
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」`,
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」の順番を変更`
    );
  }

  let previousStart = 0;
  let nextStart = 0;

  for (let pairIndex = 0; pairIndex <= matchingPairs.length; pairIndex += 1) {
    const [previousEnd, nextEnd] =
      matchingPairs[pairIndex] ?? [previousValues.length, nextValues.length];
    collectStringChangeSegment(
      summary,
      section,
      previousValues,
      nextValues,
      previousStart,
      previousEnd,
      nextStart,
      nextEnd,
      movedPreviousIndexes,
      movedNextIndexes
    );
    previousStart = previousEnd + 1;
    nextStart = nextEnd + 1;
  }
}

function collectStringChangeSegment(
  summary: DraftChangeSummary[],
  section: StringDraftSection,
  previousValues: string[],
  nextValues: string[],
  previousStart: number,
  previousEnd: number,
  nextStart: number,
  nextEnd: number,
  movedPreviousIndexes: ReadonlySet<number>,
  movedNextIndexes: ReadonlySet<number>
) {
  const sectionLabel = DRAFT_STRING_SECTION_LABELS[section];
  const previousSegmentIndexes = rangeIndexes(previousStart, previousEnd).filter(
    (index) => !movedPreviousIndexes.has(index)
  );
  const nextSegmentIndexes = rangeIndexes(nextStart, nextEnd).filter((index) => !movedNextIndexes.has(index));
  const replacementCount = Math.min(previousSegmentIndexes.length, nextSegmentIndexes.length);

  for (let offset = 0; offset < replacementCount; offset += 1) {
    const previousIndex = previousSegmentIndexes[offset];
    const nextIndex = nextSegmentIndexes[offset];
    const previousValue = previousValues[previousIndex];
    const nextValue = nextValues[nextIndex];
    if (normalizeDraftString(previousValue) === normalizeDraftString(nextValue)) continue;
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'updated',
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」`,
      `${sectionLabel}「${shortenDraftChangeText(previousValue)}」を「${shortenDraftChangeText(nextValue)}」に更新`
    );
  }

  for (let offset = replacementCount; offset < nextSegmentIndexes.length; offset += 1) {
    const nextIndex = nextSegmentIndexes[offset];
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'added',
      `${sectionLabel}「${shortenDraftChangeText(nextValues[nextIndex])}」`
    );
  }

  for (let offset = replacementCount; offset < previousSegmentIndexes.length; offset += 1) {
    const previousIndex = previousSegmentIndexes[offset];
    recordDraftChange(
      summary,
      draftStringRemovedChangeKey(section, previousIndex),
      'archived',
      `${sectionLabel}「${shortenDraftChangeText(previousValues[previousIndex])}」`
    );
  }
}

function collectMovedStringPairs(
  previousValues: string[],
  nextValues: string[],
  matchingPairs: Array<[number, number]>
): Array<[number, number]> {
  const matchedPreviousIndexes = new Set(matchingPairs.map(([previousIndex]) => previousIndex));
  const matchedNextIndexes = new Set(matchingPairs.map(([, nextIndex]) => nextIndex));
  const unmatchedNextByText = new Map<string, number[]>();

  for (let nextIndex = 0; nextIndex < nextValues.length; nextIndex += 1) {
    if (matchedNextIndexes.has(nextIndex)) continue;
    const normalized = normalizeDraftString(nextValues[nextIndex]);
    if (!normalized) continue;
    const indexes = unmatchedNextByText.get(normalized) ?? [];
    indexes.push(nextIndex);
    unmatchedNextByText.set(normalized, indexes);
  }

  const movedPairs: Array<[number, number]> = [];
  for (let previousIndex = 0; previousIndex < previousValues.length; previousIndex += 1) {
    if (matchedPreviousIndexes.has(previousIndex)) continue;
    const normalized = normalizeDraftString(previousValues[previousIndex]);
    if (!normalized) continue;
    const nextIndexes = unmatchedNextByText.get(normalized);
    const nextIndex = nextIndexes?.shift();
    if (nextIndex === undefined || nextIndex === previousIndex) continue;
    movedPairs.push([previousIndex, nextIndex]);
  }
  return movedPairs;
}

function findLongestCommonStringPairs(previousValues: string[], nextValues: string[]): Array<[number, number]> {
  const lengths = Array.from(
    { length: previousValues.length + 1 },
    () => Array<number>(nextValues.length + 1).fill(0)
  );

  for (let previousIndex = previousValues.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let nextIndex = nextValues.length - 1; nextIndex >= 0; nextIndex -= 1) {
      lengths[previousIndex][nextIndex] =
        normalizeDraftString(previousValues[previousIndex]) === normalizeDraftString(nextValues[nextIndex])
          ? lengths[previousIndex + 1][nextIndex + 1] + 1
          : Math.max(lengths[previousIndex + 1][nextIndex], lengths[previousIndex][nextIndex + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let previousIndex = 0;
  let nextIndex = 0;
  while (previousIndex < previousValues.length && nextIndex < nextValues.length) {
    if (normalizeDraftString(previousValues[previousIndex]) === normalizeDraftString(nextValues[nextIndex])) {
      pairs.push([previousIndex, nextIndex]);
      previousIndex += 1;
      nextIndex += 1;
    } else if (lengths[previousIndex + 1][nextIndex] >= lengths[previousIndex][nextIndex + 1]) {
      previousIndex += 1;
    } else {
      nextIndex += 1;
    }
  }
  return pairs;
}

function rangeIndexes(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function recordDraftChange(
  summary: DraftChangeSummary[],
  key: string,
  kind: DraftChangeKind,
  label: string,
  text = `${label}を${draftChangeKindLabel(kind)}`
) {
  summary.push({ key, kind, text });
}

function draftChangeKindLabel(kind: DraftChangeKind): string {
  if (kind === 'added') return '追加';
  if (kind === 'archived') return '削除';
  return '更新';
}

function draftItemChangeKey(section: DraftItemSection, id: string): string {
  return `${section}:${id}`;
}

function draftStringChangeKey(section: StringDraftSection, index: number): string {
  return `${section}:${index}`;
}

function draftStringRemovedChangeKey(section: StringDraftSection, index: number): string {
  return `${section}:removed:${index}`;
}

function normalizeDraftString(value: string): string {
  return value.trim().toLowerCase();
}

function shortenDraftChangeText(value: string, maxLength = 36): string {
  const trimmed = value.trim() || '内容なし';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
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

function hasMeaningfulSetupContent(session: SetupSession): boolean {
  const draft = session.draft;
  return Boolean(
    session.messages.some((entry) => entry.role === 'user' && entry.content.trim()) ||
      draft.coreConcept.trim() ||
      draft.confirmed.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.candidates.some(
        (item) => item.status === 'active' && (item.title.trim() || item.summary.trim())
      ) ||
      draft.undecided.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.characters.some(
        (item) =>
          item.status === 'active' &&
          (item.name.trim() || item.label.trim() || item.description.trim())
      ) ||
      draft.relationshipSeeds.some((item) => item.trim()) ||
      draft.world.some((item) => item.trim()) ||
      draft.tone.some((item) => item.trim()) ||
      draft.ng.some((item) => item.trim()) ||
      draft.openingSeeds.some((item) => item.trim()) ||
      (draft.scenarioSeeds ?? []).some((item) => item.trim())
  );
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

function readStoredSetupSessionId(purpose: 'novel' | 'roleplay' = 'novel'): string | null {
  try {
    const key = setupSessionStorageKey(purpose);
    const current = window.localStorage.getItem(key);
    if (current) return current;
    const legacyKey = legacySetupSessionStorageKey(purpose);
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy) {
      window.localStorage.setItem(key, legacy);
      window.localStorage.removeItem(legacyKey);
    }
    return legacy;
  } catch {
    return null;
  }
}

function rememberSetupSession(sessionId: string, purpose: 'novel' | 'roleplay' = 'novel'): void {
  try {
    window.localStorage.setItem(setupSessionStorageKey(purpose), sessionId);
  } catch {
    // localStorageが使えない環境では、サーバ側の一覧復帰に任せる
  }
}

function forgetSetupSession(sessionId?: string, purpose: 'novel' | 'roleplay' = 'novel'): void {
  try {
    for (const key of [setupSessionStorageKey(purpose), legacySetupSessionStorageKey(purpose)]) {
      const current = window.localStorage.getItem(key);
      if (!sessionId || current === sessionId) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorageが使えない環境では何もしない
  }
}
