import type { RefineAutomationRun } from '@shared/types';
import { formatDateTime, modeLabel } from './consultationFormat';

interface Props {
  run: RefineAutomationRun;
  isLatestRevertible: boolean;
  busy: boolean;
  disabled: boolean;
  isRetryable: boolean;
  retrying: boolean;
  onAcknowledge: () => void;
  onRevert: () => void;
  onRetry: () => void;
}

// NOTE: 自動レビューの監査カードは会話タイムラインの中に出るが、通常の相談を圧迫
// しないよう details で折りたためるようにする。要確認・取り消し可能な run だけは
// 既定で開く（見落とすと設定が勝手に変わったままになるため）。
export default function AutomationRunSummary({
  run,
  isLatestRevertible,
  busy,
  disabled,
  isRetryable,
  retrying,
  onAcknowledge,
  onRevert,
  onRetry,
}: Props) {
  const needsAttention =
    run.acknowledgement === 'pending' || isLatestRevertible || (isRetryable && run.status === 'failed');
  return (
    <details
      id={`automation-run-${run.runId}`}
      className="automation-run-summary"
      open={needsAttention}
    >
      <summary>
        <span className="settings-badge">自動レビュー: {modeLabel(run.mode)}</span>
        <span className="automation-run-time">{formatDateTime(run.createdAt)}</span>
        {run.acknowledgement === 'pending' && <span className="settings-badge warn">要確認</span>}
        {run.acknowledgement === 'reverted' && (
          <span className="settings-badge">取り消し済み</span>
        )}
      </summary>
      <div className="automation-run-actions">
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
    </details>
  );
}
