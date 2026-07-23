import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import type {
  Character,
  RefineAutomationMode,
  RefineAutomationRun,
  RefineEvidenceScope,
  RefineFinding,
  RefineFindingKind,
  RefineFindingTarget,
  RefineMaintenancePhase,
  RefineMessage,
  RefinePatch,
  RefinePatchOperation,
  RefinePatchStatus,
  RefineScanResult,
  RefineSession,
  SettingsFocusTarget,
} from '@shared/types';

interface Props {
  projectId: string;
  characters: Character[];
  refineScan: RefineScanResult | null;
  scanning: boolean;
  scanError: string | null;
  onScanRefine: () => void | Promise<void>;
  onSettingsChanged: () => void;
  focusTarget?: SettingsFocusTarget | null;
  onFocusTargetConsumed?: () => void;
}

type RefineTab = 'findings' | 'history';

const MAINTENANCE_BLOCKING_PHASES = new Set<RefineMaintenancePhase>([
  'scanning',
  'applying',
  'reverting',
]);

export default function RefineChatPanel({
  projectId,
  characters,
  refineScan,
  scanning,
  scanError,
  onScanRefine,
  onSettingsChanged,
  focusTarget,
  onFocusTargetConsumed,
}: Props) {
  const confirmAction = useConfirm();
  const [session, setSession] = useState<RefineSession | null>(null);
  const [runs, setRuns] = useState<RefineAutomationRun[]>([]);
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<RefineTab>('findings');
  const [sending, setSending] = useState(false);
  const [busyPatchId, setBusyPatchId] = useState<string | null>(null);
  const [revertingRunId, setRevertingRunId] = useState<string | null>(null);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);
  const [maintenancePhase, setMaintenancePhase] = useState<RefineMaintenancePhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadRuns() {
    try {
      const list = await api.getRefineAutomationRuns(projectId);
      setRuns(list);
    } catch {
      // NOTE: run 履歴の取得失敗は相談欄自体の利用を妨げないよう、静かに諦める。
    }
  }

  async function loadMaintenanceStatus() {
    try {
      const { status } = await api.getRefineAutomationSettings(projectId);
      setMaintenancePhase(status?.phase ?? null);
    } catch {
      // Maintenance state is advisory for the UI. The server remains the
      // authoritative guard when this status request cannot be completed.
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const s = await api.getRefineSession(projectId);
        if (!cancelled) setSession(s);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'セッション取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    void loadRuns();
    void loadMaintenanceStatus();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadMaintenanceStatus();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [projectId]);

  useEffect(() => {
    if (!focusTarget) return;
    setActiveTab('history');
    const targetId = focusTarget.automationRunId
      ? `automation-run-${focusTarget.automationRunId}`
      : focusTarget.patchId
        ? `refine-patch-${focusTarget.patchId}`
        : null;
    const timer = window.setTimeout(() => {
      if (targetId) {
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('refine-focus-highlight');
          window.setTimeout(() => el.classList.remove('refine-focus-highlight'), 2000);
        }
      }
      onFocusTargetConsumed?.();
    }, 80);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTarget]);

  useEffect(() => {
    // NOTE: メッセージが増えたら末尾へ自動スクロール。
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.messages.length, session?.patches.length]);

  async function handleSend() {
    const content = input.trim();
    if (!content || sending || busyPatchId || manualActionsBlocked) return;
    try {
      setSending(true);
      setError(null);
      const result = await api.sendRefineMessage(projectId, content);
      setSession(result.session);
      setInput('');
      setActiveTab('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました');
    } finally {
      setSending(false);
    }
  }

  async function reloadSessionQuietly() {
    try {
      const s = await api.getRefineSession(projectId);
      setSession(s);
    } catch {
      // NOTE: 元の操作エラーを UI に残すため、同期失敗はここでは握りつぶす。
    }
  }

  async function handleApply(patchId: string) {
    if (manualActionsBlocked) return;
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.applyRefinePatch(projectId, patchId);
      setSession(result.session);
      onSettingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パッチ反映に失敗しました');
      await reloadSessionQuietly();
    } finally {
      setBusyPatchId(null);
    }
  }

  async function handleReject(patchId: string) {
    if (manualActionsBlocked) return;
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.rejectRefinePatch(projectId, patchId);
      setSession(result.session);
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
      await Promise.all([loadRuns(), loadMaintenanceStatus()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : '自動レビューを再試行できませんでした');
      await Promise.all([loadRuns(), loadMaintenanceStatus()]);
    } finally {
      setRetryingRunId(null);
    }
  }

  async function handleReset() {
    if (busyPatchId || manualActionsBlocked) return;
    if (
      !(await confirmAction(
        '相談の履歴をリセットしますか？（適用済みの変更はそのまま残ります）',
        { confirmLabel: 'リセット', danger: true }
      ))
    )
      return;
    try {
      setSending(true);
      setError(null);
      const s = await api.resetRefineSession(projectId);
      setSession(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'リセットに失敗しました');
    } finally {
      setSending(false);
    }
  }

  async function handleScanClick() {
    if (manualActionsBlocked) return;
    setActiveTab('findings');
    await onScanRefine();
  }

  function handleConsultFinding(finding: RefineFinding) {
    const nextInput = [
      'この気づきについて相談したいです。',
      '',
      `対象: ${formatFindingTarget(finding.target)}`,
      `気づき: ${finding.message}`,
      finding.detail ? `詳しく: ${finding.detail}` : '',
      ...(finding.evidence?.length
        ? [
            '根拠（採用本文）:',
            ...finding.evidence.map(
              (evidence) => `場面 ${evidence.sceneId}: 「${evidence.quote}」`
            ),
          ]
        : []),
      finding.suggestedFix ? `提案: ${finding.suggestedFix}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    setInput(nextInput);
  }

  const patchesByMessageId = new Map<string, RefinePatch[]>();
  const patchesByAutomationRunId = new Map<string, RefinePatch[]>();
  if (session) {
    for (const patch of session.patches) {
      const list = patchesByMessageId.get(patch.sourceMessageId) ?? [];
      list.push(patch);
      patchesByMessageId.set(patch.sourceMessageId, list);
      if (patch.automationRunId) {
        const runList = patchesByAutomationRunId.get(patch.automationRunId) ?? [];
        runList.push(patch);
        patchesByAutomationRunId.set(patch.automationRunId, runList);
      }
    }
  }
  const runsByRunId = new Map<string, RefineAutomationRun>(runs.map((run) => [run.runId, run]));

  // NOTE: run はsession.messagesの24件上限で消えても refineAutomation.json には残る。
  // messageと結び付けて描画する既存経路 + それに含まれない run を単独描画する経路の
  // 2本立てにする。単独描画 run は最新→古い順で相談履歴の先頭にまとめる。
  const messageAutomationRunIds = new Set(
    (session?.messages ?? [])
      .map((m) => m.automationRunId)
      .filter((id): id is string => typeof id === 'string')
  );
  const orphanRuns = runs.filter((r) => !messageAutomationRunIds.has(r.runId));
  // NOTE: revert 可否は「実適用パッチを持ち、resultStaticHash が現在と一致する最新run」。
  // クライアントでは resultStaticHash と currentHash を比較できないため、サーバー側の
  // 判定に委ねる意味で「appliedPatchIds を持ち、その後で他の実適用runが無い」= 最新の
  // 実適用run を候補として表示するに留める。実際の判定はサーバーが 409 で拒否する。
  const latestAppliedRun = runs.find(
    (r) =>
      r.appliedPatchIds.length > 0 &&
      r.status !== 'failed' &&
      r.acknowledgement !== 'reverted' &&
      r.beforeSnapshot !== undefined
  );

  function computeIsRevertible(run: RefineAutomationRun | undefined): boolean {
    if (!run) return false;
    return latestAppliedRun?.runId === run.runId;
  }

  if (loading) return <div className="loading">相談セッションを読み込んでいます…</div>;

  const manualActionsBlocked =
    maintenancePhase !== null && MAINTENANCE_BLOCKING_PHASES.has(maintenancePhase);
  const patchActionDisabled = sending || busyPatchId !== null || manualActionsBlocked;
  const findingCount = refineScan?.findings.length ?? 0;
  const messageCount = session?.messages.length ?? 0;

  return (
    <section className="summary-card refine-chat-card">
      <header className="summary-card-header">
        <h2>AI と相談して編集</h2>
        <div className="summary-card-badges">
          <span className="settings-meta">
            世界設定・人物設定について対話で修正できます
          </span>
          <button
            onClick={handleScanClick}
            disabled={scanning || manualActionsBlocked}
            className="refine-scan-button"
          >
            {scanning ? '走査中…' : refineScan ? '再走査 🔄' : '気づきを走査 🔄'}
          </button>
          <button
            onClick={handleReset}
            disabled={sending || busyPatchId !== null || manualActionsBlocked || !session?.messages.length}
          >
            履歴をリセット
          </button>
        </div>
      </header>

      {error && <div className="refine-scan-error">{error}</div>}
      {scanError && <div className="refine-scan-error">{scanError}</div>}

      <div className="refine-chat-tabs" role="tablist" aria-label="相談欄">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'findings'}
          className={activeTab === 'findings' ? 'active' : ''}
          onClick={() => setActiveTab('findings')}
        >
          AIからの気づき
          <span>{findingCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
          className={activeTab === 'history' ? 'active' : ''}
          onClick={() => setActiveTab('history')}
        >
          相談履歴
          <span>{messageCount}</span>
        </button>
      </div>

      {activeTab === 'findings' && (
        <div className="refine-chat-scroll refine-findings-scroll" role="tabpanel">
          <RefineFindingsView
            refineScan={refineScan}
            scanning={scanning}
            onConsultFinding={handleConsultFinding}
          />
        </div>
      )}

      {activeTab === 'history' && (
        <div className="refine-chat-scroll refine-chat-messages" ref={scrollRef} role="tabpanel">
          {runs.length === 0 && (
            <p className="refine-automation-empty">自動レビューの実行履歴はまだありません。</p>
          )}
          {orphanRuns.length > 0 && (
            <div className="refine-automation-orphan-runs">
              <p className="refine-automation-orphan-heading">
                過去の自動レビュー履歴（相談チャットの上限を超えたため単独表示）
              </p>
              {orphanRuns.map((run) => {
                const runPatches = patchesByAutomationRunId.get(run.runId) ?? [];
                return (
                  <div key={run.runId}>
                    <AutomationRunSummary
                      run={run}
                      isLatestRevertible={computeIsRevertible(run)}
                      busy={revertingRunId === run.runId}
                      disabled={manualActionsBlocked}
                      isRetryable={runs[0]?.runId === run.runId && run.status === 'failed'}
                      retrying={retryingRunId === run.runId}
                      onAcknowledge={() => handleAcknowledgeRun(run.runId)}
                      onRevert={() => handleRevertRun(run.runId)}
                      onRetry={() => handleRetryRun(run.runId)}
                    />
                    {runPatches.map((patch) => (
                      <PatchCard
                        key={patch.patchId}
                        patch={patch}
                        characters={characters}
                        busy={busyPatchId === patch.patchId}
                        disabled={patchActionDisabled}
                        onApply={() => handleApply(patch.patchId)}
                        onReject={() => handleReject(patch.patchId)}
                        automationRun={run}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
          {(!session || session.messages.length === 0) && (
            <p className="summary-empty">
              例：「望月の年齢を28歳に設定して」「世界設定に長崎の描写を追加したい」など、
              変えたい・足したい点を話しかけてください。
            </p>
          )}
          {session?.messages.map((msg) => {
            const run = msg.automationRunId ? runsByRunId.get(msg.automationRunId) : undefined;
            return (
              <div key={msg.messageId}>
                <ChatBubble message={msg} />
                {run && (
                  <AutomationRunSummary
                    run={run}
                    isLatestRevertible={computeIsRevertible(run)}
                    busy={revertingRunId === run.runId}
                    disabled={manualActionsBlocked}
                    isRetryable={runs[0]?.runId === run.runId && run.status === 'failed'}
                    retrying={retryingRunId === run.runId}
                    onAcknowledge={() => handleAcknowledgeRun(run.runId)}
                    onRevert={() => handleRevertRun(run.runId)}
                    onRetry={() => handleRetryRun(run.runId)}
                  />
                )}
                {(patchesByMessageId.get(msg.messageId) ?? []).map((patch) => (
                  <PatchCard
                    key={patch.patchId}
                    patch={patch}
                    characters={characters}
                    busy={busyPatchId === patch.patchId}
                    disabled={patchActionDisabled}
                    onApply={() => handleApply(patch.patchId)}
                    onReject={() => handleReject(patch.patchId)}
                    automationRun={run}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      <form
        className="refine-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="世界設定や人物設定について、変えたい点や足したい点を書いてください"
          rows={3}
          disabled={sending || busyPatchId !== null || manualActionsBlocked}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={sending || busyPatchId !== null || manualActionsBlocked || !input.trim()}
        >
          {sending ? '送信中…' : '送る'}
        </button>
      </form>
      <p className="refine-chat-hint">Ctrl/Cmd+Enter でも送信できます。</p>
    </section>
  );
}

function RefineFindingsView({
  refineScan,
  scanning,
  onConsultFinding,
}: {
  refineScan: RefineScanResult | null;
  scanning: boolean;
  onConsultFinding: (finding: RefineFinding) => void;
}) {
  if (!refineScan && !scanning) {
    return (
      <p className="summary-empty">
        まだ走査していません。「気づきを走査」を押すと、AI が
        世界設定・人物・システムプロンプト・ストーリー状態を横断して
        矛盾や未定義項目を指摘します。
      </p>
    );
  }

  if (refineScan && refineScan.findings.length === 0 && !refineScan.lastError) {
    return (
      <p className="summary-empty">
        気になる点は見つかりませんでした（走査時点）。設定を編集したら
        再走査すると新しい気づきが出るかもしれません。
      </p>
    );
  }

  if (!refineScan || refineScan.findings.length === 0) return null;

  return (
    <ul className="refine-findings-list">
      {refineScan.findings.map((f) => (
        <li key={f.id} className={`refine-finding kind-${f.kind}`}>
          <div className="refine-finding-header">
            <span className={`refine-finding-badge kind-${f.kind}`}>
              {kindLabel(f.kind)}
            </span>
            <span className="refine-finding-target">
              {formatFindingTarget(f.target)}
            </span>
          </div>
          <p className="refine-finding-message">{f.message}</p>
          {f.detail && (
            <details className="refine-finding-detail">
              <summary>詳しく</summary>
              <p>{f.detail}</p>
            </details>
          )}
          {(f.evidence?.length ?? 0) > 0 && (
            <div className="refine-finding-evidence">
              <strong>根拠（採用本文）</strong>
              {f.evidence.map((evidence) => (
                <p key={`${evidence.generationId}-${evidence.sceneId}-${evidence.quote}`}>
                  場面 {evidence.sceneId}: 「{evidence.quote}」
                </p>
              ))}
            </div>
          )}
          {f.suggestedFix && (
            <p className="refine-finding-suggestion">
              <strong>提案:</strong> {f.suggestedFix}
            </p>
          )}
          <div className="refine-finding-actions">
            <button type="button" onClick={() => onConsultFinding(f)}>
              この気づきを相談
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ChatBubble({ message }: { message: RefineMessage }) {
  return (
    <article className={`refine-chat-bubble role-${message.role}`}>
      <div className="refine-chat-role">
        {message.role === 'user' ? 'あなた' : 'アシスタント'}
      </div>
      <p className="refine-chat-content">{message.content}</p>
    </article>
  );
}

function AutomationRunSummary({
  run,
  isLatestRevertible,
  busy,
  disabled,
  isRetryable,
  retrying,
  onAcknowledge,
  onRevert,
  onRetry,
}: {
  run: RefineAutomationRun;
  isLatestRevertible: boolean;
  busy: boolean;
  disabled: boolean;
  isRetryable: boolean;
  retrying: boolean;
  onAcknowledge: () => void;
  onRevert: () => void;
  onRetry: () => void;
}) {
  return (
    <div id={`automation-run-${run.runId}`} className="automation-run-summary">
      <span className="settings-badge">自動レビュー: {modeLabel(run.mode)}</span>
      <span className="automation-run-time">{formatDateTime(run.createdAt)}</span>
      {run.acknowledgement === 'pending' && (
        <span className="settings-badge warn">要確認</span>
      )}
      {run.acknowledgement === 'reverted' && <span className="settings-badge">取り消し済み</span>}
      {run.acknowledgement === 'pending' && (
        <button type="button" onClick={onAcknowledge} disabled={busy || disabled}>
          {busy ? '処理中…' : '確認した'}
        </button>
      )}
      {isLatestRevertible && (
        <button type="button" className="danger" onClick={onRevert} disabled={busy || disabled}>
          {busy ? '取り消し中…' : 'この更新を取り消す'}
        </button>
      )}
      {isRetryable && (
        <button type="button" onClick={onRetry} disabled={disabled || retrying}>
          {retrying ? '再試行中…' : '再試行'}
        </button>
      )}
    </div>
  );
}

function PatchCard({
  patch,
  characters,
  busy,
  disabled,
  onApply,
  onReject,
  automationRun,
}: {
  patch: RefinePatch;
  characters: Character[];
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onReject: () => void;
  automationRun?: RefineAutomationRun;
}) {
  const effectiveStatus: RefinePatchStatus =
    automationRun?.status === 'stale' && patch.status === 'pending' ? 'stale' : patch.status;
  const isActionable = effectiveStatus === 'pending';
  const riskLevel = patch.riskLevel;
  return (
    <div id={`refine-patch-${patch.patchId}`} className={`refine-patch-card status-${effectiveStatus}`}>
      <div className="refine-patch-header">
        <span className={`refine-patch-status status-${effectiveStatus}`}>
          {statusLabel(effectiveStatus)}
        </span>
        {riskLevel === 'review' && <span className="settings-badge warn">要確認</span>}
        <span className="refine-patch-summary">{patch.summary}</span>
      </div>
      {automationRun && (
        <div className="refine-patch-meta">
          <span>根拠: {evidenceScopeLabel(patch.evidenceScope)}</span>
          {patch.riskReasons && patch.riskReasons.length > 0 && (
            <span>{patch.riskReasons.join(' / ')}</span>
          )}
        </div>
      )}
      <ul className="refine-patch-ops">
        {patch.operations.map((op, idx) => (
          <li key={idx}>
            <PatchOpView op={op} characters={characters} />
          </li>
        ))}
      </ul>
      {patch.applyError && (
        <div className="refine-patch-error">反映失敗: {patch.applyError}</div>
      )}
      {isActionable && (
        <div className="refine-patch-actions">
          <button onClick={onReject} disabled={disabled}>
            却下
          </button>
          <button className="primary" onClick={onApply} disabled={disabled}>
            {busy ? '反映中…' : '反映する'}
          </button>
        </div>
      )}
    </div>
  );
}

function PatchOpView({
  op,
  characters,
}: {
  op: RefinePatchOperation;
  characters: Character[];
}) {
  switch (op.kind) {
    case 'world-replace':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 置換</div>
          <div className="refine-patch-old">- {op.op.anchor}</div>
          <div className="refine-patch-new">+ {op.op.replacement}</div>
        </div>
      );
    case 'world-append':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 追記</div>
          <div className="refine-patch-new">+ {op.op.text}</div>
        </div>
      );
    case 'character-update': {
      const character = characters.find((c) => c.characterId === op.characterId);
      const fields = Object.entries(op.fields);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">
            人物: 更新（{character?.name ?? op.characterId}）
          </div>
          {fields.map(([key, value]) => (
            <div key={key} className="refine-patch-field">
              <span className="refine-patch-field-key">{key}</span>
              <div className="refine-patch-old">
                - {formatCharacterFieldValue(character, key)}
              </div>
              <div className="refine-patch-new">+ {formatCharacterPatchValue(value)}</div>
            </div>
          ))}
        </div>
      );
    }
    case 'character-add':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 追加</div>
          <div className="refine-patch-new">
            + {op.character.name}（{op.character.role}）
          </div>
          {op.character.description && (
            <div className="refine-patch-new"> {op.character.description}</div>
          )}
          {(op.character.traits?.length ?? 0) > 0 && (
            <div className="refine-patch-new">
              + {formatCharacterPatchValue(op.character.traits)}
            </div>
          )}
          {op.character.secrets && (
            <div className="refine-patch-new">+ 見せない面: {op.character.secrets}</div>
          )}
        </div>
      );
    case 'character-remove': {
      const character = characters.find((c) => c.characterId === op.characterId);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 削除</div>
          <div className="refine-patch-old">
            - {character?.name ?? op.characterId}
          </div>
        </div>
      );
    }
  }
}

function statusLabel(status: RefinePatchStatus): string {
  switch (status) {
    case 'pending':
      return '要判断';
    case 'applied':
      return '反映済み';
    case 'rejected':
      return '却下';
    case 'stale':
      return '古い提案';
  }
}

function modeLabel(mode: RefineAutomationMode): string {
  switch (mode) {
    case 'off':
      return 'オフ';
    case 'suggest':
      return '提案だけ作る';
    case 'safe':
      return '安全な提案を自動適用';
    case 'all':
      return 'すべて自動適用';
  }
}

function evidenceScopeLabel(scope: RefineEvidenceScope | undefined): string {
  switch (scope) {
    case 'static':
      return '既存設定';
    case 'accepted':
      return '採用済み本文';
    case 'draft':
      return '下書き（未採用）';
    case 'mixed':
      return '複合';
    default:
      return '不明';
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function kindLabel(kind: RefineFindingKind): string {
  switch (kind) {
    case 'contradiction':
      return '⚠ 矛盾';
    case 'undefined':
      return '✎ 未定義';
    case 'suggestion':
      return '＋ 提案';
  }
}

function formatFindingTarget(target: RefineFindingTarget): string {
  switch (target.kind) {
    case 'world':
      return '世界設定';
    case 'systemPrompt':
      return 'システムプロンプト';
    case 'storyState':
      return 'ストーリー状態';
    case 'character':
      return `人物: ${target.characterName}`;
    case 'other':
      return target.label;
  }
}

function formatCharacterFieldValue(
  character: Character | undefined,
  key: string
): string {
  if (!character) return '（該当なし）';
  const value = (character as unknown as Record<string, unknown>)[key];
  if (key === 'traits') return value === undefined ? '（未記入）' : formatCharacterPatchValue(value);
  if (typeof value === 'string') return value.trim() || '（未記入）';
  return '（未記入）';
}

export function formatCharacterPatchValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '（なし）';
    const lines = value.flatMap((item) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        Array.isArray(item) ||
        !('label' in item) ||
        !('text' in item) ||
        typeof item.label !== 'string' ||
        typeof item.text !== 'string'
      ) {
        return [];
      }
      const text = item.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ');
      return [`${item.label}: ${text}`];
    });
    return lines.length > 0 ? lines.join('\n') : '（なし）';
  }
  if (typeof value === 'string') return value.trim() || '（未記入）';
  return value == null ? '（未記入）' : String(value);
}
