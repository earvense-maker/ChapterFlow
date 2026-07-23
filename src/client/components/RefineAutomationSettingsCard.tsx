import { useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import type { Project, RefineAutomationMode, RefineAutomationScanPolicy } from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
}

const MODE_OPTIONS: { value: RefineAutomationMode; label: string }[] = [
  { value: 'off', label: 'オフ' },
  { value: 'suggest', label: '提案だけ作る' },
  { value: 'safe', label: '安全な提案を自動適用（おすすめ）' },
  { value: 'all', label: 'すべて自動適用' },
];

const SCAN_POLICY_OPTIONS: { value: RefineAutomationScanPolicy; label: string }[] = [
  { value: 'when-needed', label: '必要なとき（おすすめ）' },
  { value: 'always', label: '生成のたび（追加のモデル呼び出し）' },
];

export default function RefineAutomationSettingsCard({ projectId, project, onError, onFlashMessage }: Props) {
  const confirmAction = useConfirm();
  // NOTE: project.refineAutomation が未保存(undefined)の作品では、ガード側の実効既定
  // (off) とは別に、設定画面では safe/when-needed をプレビュー選択として提示する
  // （設計書 5.2 の移行方針）。保存するまでは project 側に書き込まれない。
  const [mode, setMode] = useState<RefineAutomationMode>(project.refineAutomation?.mode ?? 'safe');
  const [scanPolicy, setScanPolicy] = useState<RefineAutomationScanPolicy>(
    project.refineAutomation?.scanPolicy ?? 'when-needed'
  );
  const [saving, setSaving] = useState(false);

  async function save(nextMode: RefineAutomationMode, nextScanPolicy: RefineAutomationScanPolicy) {
    try {
      setSaving(true);
      onError(null);
      await api.updateRefineAutomationSettings(projectId, { mode: nextMode, scanPolicy: nextScanPolicy });
      setMode(nextMode);
      setScanPolicy(nextScanPolicy);
      onFlashMessage('生成後の設定レビュー設定を保存しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  async function handleModeSelect(next: RefineAutomationMode) {
    if (next === mode || saving) return;
    if (next === 'all') {
      const confirmed = await confirmAction(
        '世界設定や人物設定の上書き・追加・削除も自動で行われます。変更履歴から確認・最新更新の取り消しができます。',
        { title: 'すべて自動適用にしますか？', confirmLabel: '有効にする', danger: true }
      );
      if (!confirmed) return;
    }
    void save(next, scanPolicy);
  }

  function handleScanPolicySelect(next: RefineAutomationScanPolicy) {
    if (next === scanPolicy || saving) return;
    void save(mode, next);
  }

  return (
    <section className="summary-card">
      <header className="summary-card-header">
        <h2>生成後の設定レビュー</h2>
      </header>
      <div className="automation-mode-list" role="radiogroup" aria-label="生成後の設定レビュー">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={mode === option.value}
            className={`automation-mode-option${mode === option.value ? ' active' : ''}`}
            onClick={() => void handleModeSelect(option.value)}
            disabled={saving}
          >
            <span className="automation-mode-option-dot" aria-hidden="true" />
            {option.label}
          </button>
        ))}
      </div>
      <p className="settings-help">走査を行う回は追加のモデル呼び出しが発生します。</p>

      <h3 style={{ margin: '1rem 0 0.4rem', fontSize: '0.92rem' }}>走査頻度</h3>
      <div className="automation-mode-list" role="radiogroup" aria-label="走査頻度">
        {SCAN_POLICY_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={scanPolicy === option.value}
            className={`automation-mode-option${scanPolicy === option.value ? ' active' : ''}`}
            onClick={() => handleScanPolicySelect(option.value)}
            disabled={saving || mode === 'off'}
          >
            <span className="automation-mode-option-dot" aria-hidden="true" />
            {option.label}
          </button>
        ))}
      </div>
      <p className="settings-help">
        「提案だけ作る」は適用方法だけを変える設定で、走査の頻度自体は変わりません。
      </p>
    </section>
  );
}
