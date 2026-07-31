import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import RefineAutomationSettingsCard from './RefineAutomationSettingsCard';
import RefineConversation, {
  type ConversationStarter,
} from './aiConsultation/RefineConversation';
import RefineFindingsInbox from './aiConsultation/RefineFindingsInbox';
import { formatFindingTarget } from './aiConsultation/consultationFormat';
import type {
  Character,
  Project,
  RefineAutomationRun,
  RefineConsultationTarget,
  RefineFinding,
  RefineFindingDispositionStatus,
  RefineFindingTarget,
  RefineMaintenancePhase,
  RefinePatch,
  RefineResponseMode,
  RefineReviewStatus,
  RefineScanResult,
  RefineSession,
  RefineSuggestedAction,
  SettingsFocusTarget,
} from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  session: RefineSession | null;
  onSessionChanged: (session: RefineSession) => void;
  refineScan: RefineScanResult | null;
  onRefineScanChanged: (scan: RefineScanResult) => void;
  reviewStatus: RefineReviewStatus | null;
  onReviewStatusRefresh: () => void;
  // NOTE: 作品設定タブの相談導線から運ばれてくる対象。移動しただけでは送信せず、
  // 入力欄の上にコンテキストチップとして出すだけ（API 料金を発生させない）。
  pendingTarget: RefineConsultationTarget | null;
  onPendingTargetConsumed: () => void;
  focusTarget?: SettingsFocusTarget | null;
  onFocusTargetConsumed?: () => void;
  onSettingsChanged: () => void;
  onEditInWorkSettings: (target: RefineFindingTarget) => void;
  onError: (message: string | null) => void;
  onFlashMessage: (message: string) => void;
}

const MAINTENANCE_BLOCKING_PHASES = new Set<RefineMaintenancePhase>([
  'scanning',
  'applying',
  'reverting',
]);

export default function AIConsultationTab({
  projectId,
  project,
  session,
  onSessionChanged,
  refineScan,
  onRefineScanChanged,
  reviewStatus,
  onReviewStatusRefresh,
  pendingTarget,
  onPendingTargetConsumed,
  focusTarget,
  onFocusTargetConsumed,
  onSettingsChanged,
  onEditInWorkSettings,
  onError,
  onFlashMessage,
}: Props) {
  const confirmAction = useConfirm();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [runs, setRuns] = useState<RefineAutomationRun[]>([]);
  const [input, setInput] = useState('');
  const [consultTarget, setConsultTarget] = useState<RefineConsultationTarget | null>(null);
  // NOTE: 「調整を相談」など、次の1回だけ consult で送りたい導線のための保留モード。
  // 自由入力欄からの通常送信は auto のままにしておかないと、直接編集依頼が通らなくなる。
  const [pendingResponseMode, setPendingResponseMode] = useState<RefineResponseMode | null>(null);
  const [sending, setSending] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [busyPatchId, setBusyPatchId] = useState<string | null>(null);
  const [busyFingerprint, setBusyFingerprint] = useState<string | null>(null);
  const [revertingRunId, setRevertingRunId] = useState<string | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [maintenancePhase, setMaintenancePhase] = useState<RefineMaintenancePhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatCardRef = useRef<HTMLElement>(null);

  const manualActionsBlocked =
    maintenancePhase !== null && MAINTENANCE_BLOCKING_PHASES.has(maintenancePhase);
  const busy = sending || busyPatchId !== null || busyFingerprint !== null;
  const actionsDisabled = busy || manualActionsBlocked;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [chars, runList] = await Promise.all([
          api.getCharacters(projectId),
          api.getRefineAutomationRuns(projectId).catch(() => [] as RefineAutomationRun[]),
        ]);
        if (cancelled) return;
        setCharacters(chars);
        setRuns(runList);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      }
      // NOTE: タブを離れている間に自動レビューが session を書き換えている場合があるので、
      // 再マウント時に取り直す。送信は必ずユーザー操作起点なので重複送信にはならない。
      try {
        const latest = await api.getRefineSession(projectId);
        if (!cancelled) onSessionChanged(latest);
      } catch {
        // NOTE: 取得できなくても親が持っている session で描画は続けられる。
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    async function poll() {
      try {
        const { status } = await api.getRefineAutomationSettings(projectId);
        setMaintenancePhase(status?.phase ?? null);
      } catch {
        // NOTE: 表示上の目安。サーバー側のガードが正本なので取得失敗は無視する。
      }
    }
    void poll();
    const timer = window.setInterval(poll, 1_500);
    return () => window.clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    if (!pendingTarget) return;
    setConsultTarget(pendingTarget);
    onPendingTargetConsumed();
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget]);

  // NOTE: 相談テーマは送信後も残るので、再走査で finding が入れ替わったときに
  // 実在しない対象を抱えたままにしない（そのまま送るとサーバーが 400 を返す）。
  useEffect(() => {
    setConsultTarget((current) => {
      if (current?.kind !== 'finding') return current;
      const stillExists = refineScan?.findings.some(
        (finding) =>
          finding.id === current.findingId && finding.fingerprint === current.fingerprint
      );
      return stillExists ? current : null;
    });
  }, [refineScan]);

  useEffect(() => {
    if (!focusTarget) return;
    const targetId = focusTarget.automationRunId
      ? `automation-run-${focusTarget.automationRunId}`
      : focusTarget.patchId
        ? `refine-patch-${focusTarget.patchId}`
        : focusTarget.findingId
          ? `refine-finding-${focusTarget.findingId}`
          : null;
    if (!targetId) {
      onFocusTargetConsumed?.();
      return;
    }
    // NOTE: 対象の run / patch / finding は session と runs の取得後に描画される。
    // 一度だけ見て諦めると、通信が遅いときに毎回スクロールもハイライトも起きない。
    // 現れるまで一定回数リトライし、見つかるか打ち切るまで focus target を消費しない。
    let cancelled = false;
    let timer = 0;
    let attempts = 0;
    const maxAttempts = 40; // 100ms × 40 = 最大4秒

    function tryFocus() {
      if (cancelled) return;
      const el = document.getElementById(targetId!);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('refine-focus-highlight');
        window.setTimeout(() => el.classList.remove('refine-focus-highlight'), 2000);
        onFocusTargetConsumed?.();
        return;
      }
      attempts += 1;
      if (attempts >= maxAttempts) {
        // NOTE: 上限で諦めるときも必ず消費する。残すとタブを開くたびに再試行が走る。
        onFocusTargetConsumed?.();
        return;
      }
      timer = window.setTimeout(tryFocus, 100);
    }

    timer = window.setTimeout(tryFocus, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  async function loadRuns() {
    try {
      setRuns(await api.getRefineAutomationRuns(projectId));
    } catch {
      // NOTE: run 履歴の取得失敗は相談自体の利用を妨げない。
    }
  }

  async function reloadSessionQuietly() {
    try {
      onSessionChanged(await api.getRefineSession(projectId));
    } catch {
      // NOTE: 元の操作エラーを UI に残すため、同期失敗はここでは握りつぶす。
    }
  }

  async function send(
    content: string,
    options: { responseMode: RefineResponseMode; target?: RefineConsultationTarget | null }
  ) {
    const trimmed = content.trim();
    if (!trimmed || busy || manualActionsBlocked) return;
    try {
      setSending(true);
      setError(null);
      const result = await api.sendRefineMessage(projectId, trimmed, {
        responseMode: options.responseMode,
        ...(options.target ? { target: options.target } : {}),
      });
      onSessionChanged(result.session);
      setInput('');
      // NOTE: 相談テーマ（consultTarget）は送信後も残す。ここで消すと、続けて押した
      // 「この方向で変更候補を作る」に人物・finding が乗らず、本文根拠の投入条件も
      // 外れて、対象を見失ったままパッチが作られる。外すのはユーザーの「外す」操作か、
      // 対象が実在しなくなったときだけにする。
      setPendingResponseMode(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました');
    } finally {
      setSending(false);
    }
  }

  function handleSubmit() {
    // NOTE: 自由入力欄は原則 auto。ただし「調整を相談」のように相談だけを明示的に
    // 開始した導線から来た1回は consult で送る（設計書 4.5 / 4.6）。
    void send(input, {
      responseMode: pendingResponseMode ?? 'auto',
      target: consultTarget,
    });
  }

  function handleStartTopic(starter: ConversationStarter) {
    void send(starter.message, { responseMode: 'consult', target: consultTarget });
  }

  function handleSelectSuggestedAction(action: RefineSuggestedAction) {
    void send(action.message, {
      responseMode: action.responseMode ?? 'consult',
      target: consultTarget,
    });
  }

  function handleConsultFinding(finding: RefineFinding) {
    if (!finding.fingerprint) return;
    setConsultTarget({
      kind: 'finding',
      findingId: finding.id,
      fingerprint: finding.fingerprint,
    });
    setPendingResponseMode('consult');
    inputRef.current?.focus();
  }

  // NOTE: 走査の提案をそのまま採用する導線。prepare-patch で変更候補まで作り、反映自体は
  // 既存のパッチカード（差分表示 →「反映する」）に任せる。ここで自動適用すると、
  // 差分を確認しないまま world / 人物設定が書き換わり、手動パッチには取り消しが無い。
  function handleApplyFindingSuggestion(finding: RefineFinding) {
    if (!finding.fingerprint || !finding.suggestedFix) return;
    const target: RefineConsultationTarget = {
      kind: 'finding',
      findingId: finding.id,
      fingerprint: finding.fingerprint,
    };
    setConsultTarget(target);
    // NOTE: 気づき一覧は別カラム（狭い画面では会話より下）にあるので、押しても結果が
    // 見えないままになる。変更候補は会話側に出るため、送信と同時にそこへ寄せる。
    chatCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    void send(
      `この気づきについて、走査時の提案どおりに設定を修正する変更候補を作ってください。\n提案: ${finding.suggestedFix}`,
      { responseMode: 'prepare-patch', target }
    );
  }

  function handleStartFindingConsultation(finding: RefineFinding) {
    if (!finding.fingerprint) return;
    void send(`この気づきについて相談したいです: ${finding.message}`, {
      responseMode: 'consult',
      target: { kind: 'finding', findingId: finding.id, fingerprint: finding.fingerprint },
    });
  }

  function handleDiscussAdjustment(patch: RefinePatch) {
    setConsultTarget({ kind: 'patch', patchId: patch.patchId });
    setPendingResponseMode('consult');
    setInput(`この変更候補を調整したいです（${patch.summary}）。`);
    inputRef.current?.focus();
  }

  async function handleScan() {
    if (scanning || manualActionsBlocked) return;
    try {
      setScanning(true);
      setScanError(null);
      const result = await api.scanRefine(projectId);
      onRefineScanChanged(result);
      onReviewStatusRefresh();
      if (result.lastError) setScanError(result.lastError);
      else onFlashMessage('作品設定を再走査しました');
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '走査に失敗しました');
    } finally {
      setScanning(false);
    }
  }

  async function handleSetDisposition(
    finding: RefineFinding,
    status: RefineFindingDispositionStatus
  ) {
    if (!finding.fingerprint || actionsDisabled) return;
    try {
      setBusyFingerprint(finding.fingerprint);
      setError(null);
      const result = await api.updateRefineFindingDisposition(
        projectId,
        finding.fingerprint,
        status
      );
      onSessionChanged(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : '判断を保存できませんでした');
      await reloadSessionQuietly();
    } finally {
      setBusyFingerprint(null);
    }
  }

  async function handleApplyPatch(patchId: string) {
    if (actionsDisabled) return;
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.applyRefinePatch(projectId, patchId);
      onSessionChanged(result.session);
      setCharacters(await api.getCharacters(projectId));
      onSettingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パッチ反映に失敗しました');
      await reloadSessionQuietly();
    } finally {
      setBusyPatchId(null);
    }
  }

  async function handleRejectPatch(patchId: string) {
    if (actionsDisabled) return;
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.rejectRefinePatch(projectId, patchId);
      onSessionChanged(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パッチ却下に失敗しました');
      await reloadSessionQuietly();
    } finally {
      setBusyPatchId(null);
    }
  }

  async function handleAcknowledgeRun(runId: string) {
    if (revertingRunId || busyPatchId) return;
    try {
      setRevertingRunId(runId);
      setError(null);
      await api.acknowledgeRefineAutomationRun(projectId, runId);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '確認できませんでした');
      await loadRuns();
    } finally {
      setRevertingRunId(null);
    }
  }

  async function handleRevertRun(runId: string) {
    if (revertingRunId || busyPatchId || manualActionsBlocked) return;
    if (
      !(await confirmAction(
        'この自動更新を取り消しますか？世界設定・人物設定が更新前の状態へ戻ります。',
        { confirmLabel: '取り消す', danger: true }
      ))
    )
      return;
    try {
      setRevertingRunId(runId);
      setError(null);
      await api.revertRefineAutomationRun(projectId, runId);
      await Promise.all([reloadSessionQuietly(), loadRuns()]);
      setCharacters(await api.getCharacters(projectId));
      onSettingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '取り消しに失敗しました');
      await loadRuns();
    } finally {
      setRevertingRunId(null);
    }
  }

  async function handleRetryRun(runId: string) {
    if (revertingRunId || retryingRunId || busyPatchId || manualActionsBlocked) return;
    try {
      setRetryingRunId(runId);
      setError(null);
      await api.retryRefineAutomation(projectId);
      await loadRuns();
    } catch (err) {
      setError(err instanceof Error ? err.message : '自動レビューを再試行できませんでした');
      await loadRuns();
    } finally {
      setRetryingRunId(null);
    }
  }

  async function handleReset() {
    if (actionsDisabled || !session?.messages.length) return;
    if (
      !(await confirmAction(
        '相談の履歴をリセットしますか？（適用済みの変更と、気づきへの判断はそのまま残ります）',
        { confirmLabel: 'リセット', danger: true }
      ))
    )
      return;
    try {
      setSending(true);
      setError(null);
      onSessionChanged(await api.resetRefineSession(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'リセットに失敗しました');
    } finally {
      setSending(false);
    }
  }

  const selectedFinding =
    consultTarget?.kind === 'finding'
      ? (refineScan?.findings.find((f) => f.id === consultTarget.findingId) ?? null)
      : null;

  return (
    <div className="ai-consultation-layout">
      {/* NOTE: DOM 上は会話 → 入力 → 補助情報の順にする。狭い画面で一列化したとき、
          読み上げ順と視覚順がずれないようにするため（設計書 9）。 */}
      <div className="ai-consultation-main">
        <section className="summary-card refine-chat-card" ref={chatCardRef}>
          <header className="summary-card-header">
            <h2>AIと相談して編集</h2>
            <div className="summary-card-badges">
              <span className="settings-meta">
                作品設定を踏まえて、方向を一緒に探せます
              </span>
              <button type="button" onClick={handleReset} disabled={actionsDisabled || !session?.messages.length}>
                履歴をリセット
              </button>
            </div>
          </header>

          {error && <div className="refine-scan-error">{error}</div>}
          {manualActionsBlocked && (
            <p className="refine-maintenance-note" role="status">
              自動レビューの処理中です（{maintenancePhase}）。終わるまで相談の送信と反映はできません。
            </p>
          )}

          <RefineConversation
            session={session}
            characters={characters}
            runs={runs}
            sending={sending}
            busyPatchId={busyPatchId}
            revertingRunId={revertingRunId}
            retryingRunId={retryingRunId}
            actionsDisabled={manualActionsBlocked || busyFingerprint !== null}
            onStartTopic={handleStartTopic}
            onSelectSuggestedAction={handleSelectSuggestedAction}
            onApplyPatch={handleApplyPatch}
            onRejectPatch={handleRejectPatch}
            onDiscussAdjustment={handleDiscussAdjustment}
            onAcknowledgeRun={handleAcknowledgeRun}
            onRevertRun={handleRevertRun}
            onRetryRun={handleRetryRun}
          />

          {consultTarget && (
            <div className="refine-consult-target" role="status">
              <span className="settings-badge">相談テーマ</span>
              <span className="refine-consult-target-label">
                {describeConsultTarget(consultTarget, characters, selectedFinding)}
              </span>
              {selectedFinding && (
                <button
                  type="button"
                  className="primary"
                  disabled={actionsDisabled}
                  onClick={() => handleStartFindingConsultation(selectedFinding)}
                >
                  この気づきの相談を始める
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setConsultTarget(null);
                  setPendingResponseMode(null);
                }}
              >
                外す
              </button>
            </div>
          )}

          <form
            className="refine-chat-input"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="曖昧なままで大丈夫です。「この人物が薄い気がする」「もっと冷たくしたい」など、感じていることを書いてください"
              rows={3}
              aria-label="相談を入力"
              disabled={actionsDisabled}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  handleSubmit();
                }
              }}
            />
            <button type="submit" className="primary" disabled={actionsDisabled || !input.trim()}>
              {sending ? '送信中…' : '送る'}
            </button>
          </form>
          <p className="refine-chat-hint">Ctrl/Cmd+Enter でも送信できます。</p>
        </section>
      </div>

      <div className="ai-consultation-side">
        <RefineFindingsInbox
          refineScan={refineScan}
          reviewStatus={reviewStatus}
          dispositions={session?.consultationState?.findingDispositions ?? []}
          scanning={scanning}
          scanError={scanError}
          actionsDisabled={actionsDisabled}
          busyFingerprint={busyFingerprint}
          selectedFindingId={selectedFinding?.id ?? null}
          onScan={handleScan}
          onConsult={handleConsultFinding}
          onApplySuggestion={handleApplyFindingSuggestion}
          onSetDisposition={handleSetDisposition}
          onEditInWorkSettings={(finding) => onEditInWorkSettings(finding.target)}
        />
        {/* NOTE: ロールプレイは StoryState を正本にしないため自動レビューの対象外。
            既存の作品設定タブと同じ条件で出し分ける。 */}
        {project.projectType !== 'roleplay' && (
          <RefineAutomationSettingsCard
            projectId={projectId}
            project={project}
            onError={onError}
            onFlashMessage={onFlashMessage}
          />
        )}
      </div>
    </div>
  );
}

function describeConsultTarget(
  target: RefineConsultationTarget,
  characters: Character[],
  finding: RefineFinding | null
): string {
  switch (target.kind) {
    case 'general':
      return '作品全体';
    case 'world':
      return target.section === 'foundation'
        ? '世界設定 / 世界の土台'
        : target.section === 'initialSituation'
          ? '世界設定 / 開始時点の状況'
          : '世界設定';
    case 'character': {
      const character = characters.find((c) => c.characterId === target.characterId);
      const name = character?.name || target.characterId;
      return target.field ? `人物: ${name} / ${target.field}` : `人物: ${name}`;
    }
    case 'finding':
      return finding
        ? `気づき（${formatFindingTarget(finding.target)}）: ${finding.message}`
        : '気づき（最新の走査結果にありません）';
    case 'patch':
      return '変更候補の調整';
  }
}
