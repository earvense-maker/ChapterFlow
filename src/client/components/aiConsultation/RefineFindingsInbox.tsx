import {
  canMarkIntentionalGap,
  canMarkResolved,
  findActiveDisposition,
} from '@shared/refineFinding';
import type {
  RefineFinding,
  RefineFindingDisposition,
  RefineFindingDispositionStatus,
  RefineReviewStatus,
  RefineScanResult,
} from '@shared/types';
import { buildRefineNudgeMessage } from '../workSettings/workSettingsHelpers';
import { formatDateTime, formatFindingTarget, kindLabel } from './consultationFormat';

interface Props {
  refineScan: RefineScanResult | null;
  reviewStatus: RefineReviewStatus | null;
  dispositions: RefineFindingDisposition[];
  scanning: boolean;
  scanError: string | null;
  actionsDisabled: boolean;
  busyFingerprint: string | null;
  selectedFindingId: string | null;
  onScan: () => void;
  onConsult: (finding: RefineFinding) => void;
  onSetDisposition: (finding: RefineFinding, status: RefineFindingDispositionStatus) => void;
  onEditInWorkSettings: (finding: RefineFinding) => void;
}

const DISPOSITION_LABEL: Record<RefineFindingDispositionStatus, string> = {
  deferred: '保留中',
  'intentional-gap': '意図的な空白',
  resolved: '解決済み',
};

export default function RefineFindingsInbox({
  refineScan,
  reviewStatus,
  dispositions,
  scanning,
  scanError,
  actionsDisabled,
  busyFingerprint,
  selectedFindingId,
  onScan,
  onConsult,
  onSetDisposition,
  onEditInWorkSettings,
}: Props) {
  const nudge = reviewStatus?.needsReview ? buildRefineNudgeMessage(reviewStatus) : null;

  return (
    <section className="summary-card refine-findings-card">
      <header className="summary-card-header">
        <h2>AIからの気づき</h2>
        <div className="summary-card-badges">
          {refineScan && (
            <span className="settings-meta">走査: {formatDateTime(refineScan.generatedAt)}</span>
          )}
          <button type="button" onClick={onScan} disabled={scanning || actionsDisabled}>
            {scanning ? '走査中…' : refineScan ? '再走査 🔄' : '気づきを走査 🔄'}
          </button>
        </div>
      </header>

      {nudge && (
        <div className="refine-review-nudge" role="status">
          {nudge}
        </div>
      )}
      {scanError && <div className="refine-scan-error">{scanError}</div>}
      {refineScan?.coreConcept && (
        <p className="refine-core-concept">作品の芯: {refineScan.coreConcept}</p>
      )}

      <FindingsBody
        refineScan={refineScan}
        dispositions={dispositions}
        scanning={scanning}
        actionsDisabled={actionsDisabled}
        busyFingerprint={busyFingerprint}
        selectedFindingId={selectedFindingId}
        onConsult={onConsult}
        onSetDisposition={onSetDisposition}
        onEditInWorkSettings={onEditInWorkSettings}
      />
    </section>
  );
}

function FindingsBody({
  refineScan,
  dispositions,
  scanning,
  actionsDisabled,
  busyFingerprint,
  selectedFindingId,
  onConsult,
  onSetDisposition,
  onEditInWorkSettings,
}: Pick<
  Props,
  | 'refineScan'
  | 'dispositions'
  | 'scanning'
  | 'actionsDisabled'
  | 'busyFingerprint'
  | 'selectedFindingId'
  | 'onConsult'
  | 'onSetDisposition'
  | 'onEditInWorkSettings'
>) {
  if (scanning && !refineScan) {
    return <p className="summary-empty">走査しています…</p>;
  }
  if (!refineScan) {
    return (
      <p className="summary-empty">
        まだ走査していません。「気づきを走査」を押すと、AI が
        世界設定・人物・システムプロンプト・ストーリー状態を横断して 矛盾や未定義項目を指摘します。
      </p>
    );
  }
  if (refineScan.findings.length === 0) {
    return (
      <p className="summary-empty">
        気になる点は見つかりませんでした（走査時点）。設定を編集したら
        再走査すると新しい気づきが出るかもしれません。
      </p>
    );
  }

  return (
    <ul className="refine-findings-list">
      {refineScan.findings.map((finding) => {
        const disposition = findActiveDisposition(finding, dispositions, refineScan);
        const busy = Boolean(finding.fingerprint && busyFingerprint === finding.fingerprint);
        const disabled = actionsDisabled || busy;
        return (
          <li
            key={finding.id}
            id={`refine-finding-${finding.id}`}
            className={[
              'refine-finding',
              `kind-${finding.kind}`,
              disposition ? 'handled' : '',
              selectedFindingId === finding.id ? 'selected' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="refine-finding-header">
              <span className={`refine-finding-badge kind-${finding.kind}`}>
                {kindLabel(finding.kind)}
              </span>
              <span className="refine-finding-target">{formatFindingTarget(finding.target)}</span>
              {disposition && (
                <span className="settings-badge">{DISPOSITION_LABEL[disposition.status]}</span>
              )}
            </div>
            <p className="refine-finding-message">{finding.message}</p>
            {finding.detail && (
              <details className="refine-finding-detail">
                <summary>詳しく</summary>
                <p>{finding.detail}</p>
              </details>
            )}
            {(finding.evidence?.length ?? 0) > 0 && (
              <div className="refine-finding-evidence">
                <strong>根拠（採用本文）</strong>
                {finding.evidence?.map((evidence) => (
                  <p key={`${evidence.generationId}-${evidence.sceneId}-${evidence.quote}`}>
                    場面 {evidence.sceneId}: 「{evidence.quote}」
                  </p>
                ))}
              </div>
            )}
            {finding.suggestedFix && (
              <p className="refine-finding-suggestion">
                <strong>提案:</strong> {finding.suggestedFix}
              </p>
            )}
            <div className="refine-finding-actions">
              <button type="button" className="primary" onClick={() => onConsult(finding)} disabled={disabled}>
                相談する
              </button>
              <button
                type="button"
                onClick={() => onSetDisposition(finding, 'deferred')}
                disabled={disabled || !finding.fingerprint}
              >
                今は保留
              </button>
              {/* NOTE: target が 'other' の気づきは fingerprint が走査をまたいで安定
                  しないため、永続的な判断を保存させない（保存できても次回は消える）。 */}
              {canMarkIntentionalGap(finding) && (
                <button
                  type="button"
                  onClick={() => onSetDisposition(finding, 'intentional-gap')}
                  disabled={disabled || !finding.fingerprint}
                >
                  意図的な空白として残す
                </button>
              )}
              {canMarkResolved(finding) && (
                <button
                  type="button"
                  onClick={() => onSetDisposition(finding, 'resolved')}
                  disabled={disabled || !finding.fingerprint}
                >
                  解決済みにする
                </button>
              )}
              <button type="button" onClick={() => onEditInWorkSettings(finding)} disabled={busy}>
                作品設定で直接編集
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
