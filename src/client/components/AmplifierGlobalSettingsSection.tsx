// 妄想増幅器・人間理解のグローバル設定（設計書 14.1）
//
// - グローバル学習と利用のオン・オフ（初期値オン）
// - 現在のグローバル観察ノート（通常は折りたたむ）
// - メモの区別（novel / roleplay / mixed）
// - メモ修正・誤りの指摘・個別削除
// - グローバル境界の編集
// - グローバル理解の全消去
// - 解釈失敗時の再試行

import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import type {
  GlobalNotebook,
  PreferenceAppliesTo,
  PreferenceMemo,
} from '@shared/types';

interface Props {
  onError: (message: string) => void;
  onFlashMessage: (message: string) => void;
  disabled?: boolean;
}

const APPLIES_TO_LABELS: Record<PreferenceAppliesTo, string> = {
  novel: '小説',
  roleplay: 'ロールプレイ',
  mixed: '両方',
};

export default function AmplifierGlobalSettingsSection({
  onError,
  onFlashMessage,
  disabled,
}: Props) {
  const confirmAction = useConfirm();
  const [settings, setSettings] = useState<{
    globalLearningEnabled: boolean;
    globalLearningResetAt: string | null;
  } | null>(null);
  const [notebook, setNotebook] = useState<GlobalNotebook | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState('');
  const [correctionScope, setCorrectionScope] = useState<PreferenceAppliesTo>('novel');
  const [correctionText, setCorrectionText] = useState('');

  const load = async () => {
    try {
      const [settingsResult, preferences] = await Promise.all([
        api.getAmplifierSettings(),
        api.getAmplifierGlobalPreferences(),
      ]);
      setSettings(settingsResult);
      setNotebook(preferences.notebook);
      setBoundaryDraft(preferences.notebook.globalBoundary);
    } catch (err) {
      onError(err instanceof Error ? err.message : '妄想増幅器の設定を読み込めませんでした');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleLearning = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierSettings({ globalLearningEnabled: enabled });
      setSettings(result);
      onFlashMessage(enabled ? 'グローバル学習をオンにしました。' : 'グローバル学習をオフにしました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const saveBoundary = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierGlobalPreferences({
        globalBoundary: boundaryDraft.trim(),
      });
      setNotebook(result.notebook);
      onFlashMessage('グローバル境界を保存しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '境界の保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const addCorrection = async () => {
    const text = correctionText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const result = await api.updateAmplifierGlobalPreferences({
        addCorrections: [{ appliesTo: correctionScope, text }],
      });
      setNotebook(result.notebook);
      setCorrectionText('');
      onFlashMessage('あなたの訂正として保存しました。AIの解釈は上書きされません。');
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
      const result = await api.updateAmplifierGlobalPreferences({
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
      const result = await api.updateAmplifierGlobalPreferences({
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

  const wipeAll = async () => {
    if (
      !(await confirmAction(
        'グローバル理解（メモ・訂正・版履歴・抽象観察）をすべて削除します。作品の本文やログは残ります。よろしいですか？',
        { confirmLabel: 'すべて消去', danger: true }
      ))
    ) {
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.wipeAmplifierGlobalPreferences();
      setNotebook(result.notebook);
      setSettings({
        globalLearningEnabled: result.notebook.globalLearningEnabled,
        globalLearningResetAt: result.notebook.globalLearningResetAt ?? null,
      });
      onFlashMessage('グローバル理解をすべて消去しました。過去のログから自動復活はしません。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '全消去に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.retryAmplifierGlobalInterpretation();
      onFlashMessage('解釈を再開しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '再試行に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const memos = notebook?.memos ?? [];
  const activeCorrections = (notebook?.corrections ?? []).filter(
    (correction) => correction.status === 'active'
  );
  const interpreterFailed = notebook?.interpreter.state === 'failed';
  const interpreterPending = notebook?.interpreter.state === 'pending';

  return (
    <section className="settings-section">
      <h2>妄想増幅器・人間理解</h2>
      <p className="settings-help">
        選択や自由記述から、作品をまたいで「あなたが楽しめる方向」の暫定仮説を更新します。
        仮説は診断ではなく、AIが現在持っている創作体験上の理解です。この画面で閲覧・修正・
        削除できます。
      </p>

      <div className="summary-card">
        <div className="summary-card-header">
          <h3>グローバル学習と利用</h3>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={settings?.globalLearningEnabled ?? true}
            onChange={(e) => void toggleLearning(e.target.checked)}
            disabled={busy || disabled}
          />
          グローバル学習をオンにする（初期値: オン）
        </label>
        <p className="settings-help">
          オフにすると、既存のグローバルメモを生成へ使わず、新しいグローバル観察も作りません。
          作品内の学習は継続します。既存データは削除されません。
        </p>
        {settings?.globalLearningResetAt && (
          <p className="settings-help">
            前回の全消去: {new Date(settings.globalLearningResetAt).toLocaleString('ja-JP')}
          </p>
        )}
      </div>

      <div className="summary-card">
        <div className="summary-card-header">
          <h3>グローバル観察ノート</h3>
          <button onClick={() => setOpen(!open)} disabled={busy}>
            {open ? '閉じる' : '開く'}
          </button>
        </div>
        {open && (
          <>
            {interpreterPending && <p className="settings-help">解釈を実行中です…</p>}
            {interpreterFailed && (
              <p className="settings-help" style={{ color: 'var(--danger)' }}>
                直前の解釈に失敗しました（生成はブロックされません）。
                <button onClick={() => void retry()} disabled={busy}>
                  再試行
                </button>
              </p>
            )}
            <p className="settings-help">
              メモは仮説です。「あなたが訂正したこと」はAIの解釈とは別に保持され、
              次の解釈で反転されません。
            </p>

            <h4>AIの現在の理解</h4>
            {memos.length === 0 ? (
              <p className="settings-help">まだメモがありません。選択が蓄まると作られます。</p>
            ) : (
              <ul className="amplifier-memo-list">
                {memos.map((memo) => (
                  <MemoRow key={memo.memoId} memo={memo} onDelete={() => void deleteMemo(memo.memoId)} disabled={busy || disabled === true} />
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
                      disabled={busy || disabled}
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
                disabled={busy || disabled}
              >
                <option value="novel">小説</option>
                <option value="roleplay">ロールプレイ</option>
                <option value="mixed">両方</option>
              </select>
              <input
                type="text"
                value={correctionText}
                onChange={(e) => setCorrectionText(e.target.value)}
                placeholder="誤りや訂正を書く（例: 見下し系ではなく対等な距離感が好き）"
                disabled={busy || disabled}
              />
              <button onClick={() => void addCorrection()} disabled={busy || disabled || !correctionText.trim()}>
                訂正を追加
              </button>
            </div>

            <h4>グローバル境界</h4>
            <p className="settings-help">どの妄想でも避けること。探索候補も境界を越えません。</p>
            <textarea
              value={boundaryDraft}
              onChange={(e) => setBoundaryDraft(e.target.value)}
              rows={2}
              disabled={busy || disabled}
              placeholder="例: 未成年キャラクターの恋愛描写はしない"
            />
            <div className="summary-card-actions">
              <button onClick={() => void saveBoundary()} disabled={busy || disabled}>
                境界を保存
              </button>
            </div>

            <div className="summary-card-actions">
              <button className="danger" onClick={() => void wipeAll()} disabled={busy || disabled}>
                グローバル理解を全消去
              </button>
            </div>
          </>
        )}
      </div>
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
