// 妄想増幅器プロジェクトの作品設定（設計書 14.2）
//
// - 作品内観察ノート（project / current メモ）
// - 作品内境界
// - この作品からグローバルへ学習するか（既定オン）
// - current メモの表示とリセット（上級者向け折りたたみ）

import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type {
  AmplifierProjectNotebook,
  PreferenceAppliesTo,
  PreferenceMemo,
} from '@shared/types';

interface Props {
  projectId: string;
  isRoleplay: boolean;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
}

const APPLIES_TO_LABELS: Record<PreferenceAppliesTo, string> = {
  novel: '小説',
  roleplay: 'ロールプレイ',
  mixed: '両方',
};

export default function AmplifierProjectSettingsCard({
  projectId,
  isRoleplay,
  onError,
  onFlashMessage,
}: Props) {
  const [notebook, setNotebook] = useState<AmplifierProjectNotebook | null>(null);
  const [busy, setBusy] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [correctionScope, setCorrectionScope] = useState<PreferenceAppliesTo>(
    isRoleplay ? 'roleplay' : 'novel'
  );
  const [correctionText, setCorrectionText] = useState('');

  const load = async () => {
    try {
      const result = await api.getAmplifierProjectPreferences(projectId);
      setNotebook(result.notebook);
      setBoundaryDraft(result.notebook.projectBoundary);
    } catch (err) {
      onError(err instanceof Error ? err.message : '妄想増幅器の設定を読み込めませんでした');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const saveBoundary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        projectBoundary: boundaryDraft.trim(),
      });
      setNotebook(result.notebook);
      onFlashMessage('作品内境界を保存しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '境界の保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const toggleLearning = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        learningEnabled: enabled,
      });
      setNotebook(result.notebook);
      onFlashMessage(enabled ? 'この作品をグローバル学習の対象にしました。' : 'この作品をグローバル学習の対象外にしました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '更新に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const addCorrection = async () => {
    const text = correctionText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        addCorrections: [{ scope: 'project', appliesTo: correctionScope, text }],
      });
      setNotebook(result.notebook);
      setCorrectionText('');
      onFlashMessage('あなたの訂正として保存しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '訂正の保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const withdrawCorrection = async (correctionId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        withdrawCorrectionIds: [correctionId],
      });
      setNotebook(result.notebook);
      onFlashMessage('訂正を解除しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '訂正の解除に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const deleteMemo = async (memoId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        deleteMemoIds: [memoId],
      });
      setNotebook(result.notebook);
      onFlashMessage('メモを削除しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'メモの削除に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const resetCurrent = async (contextKey: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierProjectPreferences(projectId, {
        resetCurrentContextKeys: [contextKey],
      });
      setNotebook(result.notebook);
      onFlashMessage('current メモをリセットしました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'リセットに失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.retryAmplifierProjectInterpretation(projectId);
      onFlashMessage('解釈を再開しました。');
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : '再試行に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const memos = notebook?.projectMemos ?? [];
  const activeCorrections = (notebook?.corrections ?? []).filter(
    (correction) => correction.status === 'active' && correction.scope === 'project'
  );
  const currentEntries = Object.entries(notebook?.currentMemos ?? {});
  const interpreterFailed = notebook?.interpreter.state === 'failed';

  return (
    <section className="summary-card detail-settings-card">
      <header className="summary-card-header">
        <h2>妄想増幅器・作品内の人間理解</h2>
        <span className="settings-meta">作品内メモ {memos.length}件</span>
      </header>
      <p className="settings-help">
        この作品内の観察ノートです。生成には current ＞ project ＞ global の順で反映されます。
        仮説は診断ではなく、AIが現在持っている創作体験上の理解です。
      </p>

      {interpreterFailed && (
        <p className="settings-help" style={{ color: 'var(--danger)' }}>
          直前の解釈に失敗しました（生成はブロックされません）。
          <button onClick={() => void retry()} disabled={busy}>
            再試行
          </button>
        </p>
      )}

      <h4>この作品の理解（project）</h4>
      {memos.length === 0 ? (
        <p className="settings-help">まだメモがありません。選択が蓄まると作られます。</p>
      ) : (
        <ul className="amplifier-memo-list">
          {memos.map((memo) => (
            <MemoRow
              key={memo.memoId}
              memo={memo}
              onDelete={() => void deleteMemo(memo.memoId)}
              disabled={busy}
            />
          ))}
        </ul>
      )}

      <h4>あなたが訂正したこと</h4>
      {activeCorrections.length === 0 ? (
        <p className="settings-help">訂正はありません。</p>
      ) : (
        <ul className="amplifier-memo-list">
          {activeCorrections.map((correction) => (
            <li key={correction.correctionId} className="amplifier-memo amplifier-memo--correction">
              <div className="amplifier-memo-main">
                <span className="amplifier-memo-meta">
                  [{APPLIES_TO_LABELS[correction.appliesTo]}] あなたの訂正
                </span>
                <p>{correction.text}</p>
              </div>
              <button
                onClick={() => void withdrawCorrection(correction.correctionId)}
                disabled={busy}
              >
                解除
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="amplifier-correction-form">
        <select
          value={correctionScope}
          onChange={(e) => setCorrectionScope(e.target.value as PreferenceAppliesTo)}
          disabled={busy}
        >
          <option value="novel">小説</option>
          <option value="roleplay">ロールプレイ</option>
          <option value="mixed">両方</option>
        </select>
        <input
          type="text"
          value={correctionText}
          onChange={(e) => setCorrectionText(e.target.value)}
          placeholder="この作品での誤りや訂正（例: この作品では年上の態度を崩さない）"
          disabled={busy}
        />
        <button onClick={() => void addCorrection()} disabled={busy || !correctionText.trim()}>
          訂正を追加
        </button>
      </div>

      <h4>作品内境界</h4>
      <p className="settings-help">この作品では避けること。探索候補も境界を越えません。</p>
      <textarea
        value={boundaryDraft}
        onChange={(e) => setBoundaryDraft(e.target.value)}
        rows={2}
        disabled={busy}
        placeholder="例: この作品では離別エンドを出さない"
      />
      <div className="summary-card-actions">
        <button onClick={() => void saveBoundary()} disabled={busy}>
          境界を保存
        </button>
      </div>

      <div className="summary-card-actions">
        <button
          onClick={() => void toggleLearning(!(notebook?.learningEnabled ?? true))}
          disabled={busy}
        >
          この作品からグローバルへ学習する: {notebook?.learningEnabled === false ? 'オフ' : 'オン'}
        </button>
        <span className="settings-help">
          （オフにするとこの作品の選択はグローバル学習へ送られません。設定画面からも変更できます）
        </span>
      </div>

      <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}>
        <summary>current メモ（上級者向け）</summary>
        {currentEntries.length === 0 ? (
          <p className="settings-help">current メモはありません。</p>
        ) : (
          <ul className="amplifier-memo-list">
            {currentEntries.map(([contextKey, memos]) => (
              <li key={contextKey} className="amplifier-memo">
                <div className="amplifier-memo-main">
                  <span className="amplifier-memo-meta">{contextKey}</span>
                  {memos.map((memo) => (
                    <p key={memo.memoId}>{memo.text}</p>
                  ))}
                </div>
                <button onClick={() => void resetCurrent(contextKey)} disabled={busy}>
                  リセット
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="settings-help">
          current は直近数ターンの一時的な欲求です。ロールプレイの新しい会話では空から始まり、
          project と global を引き継ぎます。
        </p>
      </details>
    </section>
  );
}

function MemoRow({
  memo,
  onDelete,
  disabled,
}: {
  memo: PreferenceMemo;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <li className="amplifier-memo">
      <div className="amplifier-memo-main">
        <span className="amplifier-memo-meta">
          [{APPLIES_TO_LABELS[memo.appliesTo]}] {memo.confidence === 'recurring' ? '繰り返し確認' : '暫定'}・根拠 {memo.evidenceEventIds.length} 件
        </span>
        <p>{memo.text}</p>
      </div>
      <button onClick={onDelete} disabled={disabled}>
        削除
      </button>
    </li>
  );
}
