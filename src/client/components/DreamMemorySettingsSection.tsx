// NOTE: 明晰夢モードの生の選択記憶の設定（docs/design/明晰夢モード_世界自己反転_改修設計書.md §12）。
//
// - 初回説明（入力原文と直前の明晰夢の本文を作品を越えて保存すること）
// - 記録・想起の一時停止（オフにしても既存記憶は自動削除しない）
// - 生記憶の閲覧・書き出し
// - 全消去（プロジェクト削除後も残ることを明示）
//
// 「ずっと記憶する」は明示的な削除権より優先しない（設計書 §5）。保存契約は変更しない。

import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import type { DreamMemorySettings, DreamTraceEvent } from '@shared/types';

interface Props {
  onError: (message: string) => void;
  onFlashMessage: (message: string) => void;
  disabled?: boolean;
}

export default function DreamMemorySettingsSection({
  onError,
  onFlashMessage,
  disabled,
}: Props) {
  const confirmAction = useConfirm();
  const [settings, setSettings] = useState<DreamMemorySettings | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [events, setEvents] = useState<DreamTraceEvent[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const [status, browse] = await Promise.all([
        api.getDreamMemorySettings(),
        api.getDreamMemoryEvents(),
      ]);
      setSettings(status.settings);
      setEventCount(status.eventCount);
      setEvents(browse.events);
    } catch (err) {
      onError(err instanceof Error ? err.message : '明晰夢の記憶の設定を読み込めませんでした');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleRecording = async (enabled: boolean) => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const result = await api.updateDreamMemorySettings({ recordingEnabled: enabled });
      setSettings(result.settings);
      setEventCount(result.eventCount);
      onFlashMessage(
        enabled
          ? '明晰夢の記憶の記録と想起を再開しました。'
          : '明晰夢の記憶の記録と想起を一時停止しました。'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : '設定の保存に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const refreshEvents = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const browse = await api.getDreamMemoryEvents();
      setEvents(browse.events);
    } catch (err) {
      onError(err instanceof Error ? err.message : '明晰夢の記憶を読み込めませんでした');
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const result = await api.exportDreamMemory();
      const blob = new Blob([JSON.stringify(result.events, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `dream-memory-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      onFlashMessage(`明晰夢の記憶を書き出しました（${result.events.length}件）。`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '書き出しに失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const wipeAll = async () => {
    if (
      !(await confirmAction(
        '明晰夢の記憶（作品を越えて保存された、あなたが書いた言葉とそのときの明晰夢の本文）をすべて削除します。作品の本文やロールプレイの履歴は残ります。プロジェクトを削除しても残っていた生記憶もここで完全に消えます。よろしいですか？',
        { confirmLabel: 'すべて消去', danger: true }
      ))
    ) {
      return;
    }
    if (busy || disabled) return;
    setBusy(true);
    try {
      await api.wipeDreamMemory();
      setEventCount(0);
      setEvents([]);
      onFlashMessage('明晰夢の記憶をすべて消去しました。古い作品やセッションから自動復活はしません。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '全消去に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2>明晰夢の記憶</h2>
      <p className="settings-help">
        明晰夢の中で書かれた言葉（入力原文）と、その直前の明晰夢の本文は、作品を越えてこのアプリの保存先に記録されます。
        記録された言葉は、未来の明晰夢の本文として現在選択中のモデル提供者へ送信されることがあります。
      </p>
      <p className="settings-help">
        この記憶は「あなたの理解」ではありません。何を好むか、なぜ選んだかは保存されず、
        そのとき実際に何を書いたか／何も書かず眺めたかのみが残ります。
        プロジェクトを削除しても、この記憶は残ります。
      </p>

      {settings && (
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={settings.recordingEnabled}
            onChange={(event) => void toggleRecording(event.target.checked)}
            disabled={busy || disabled}
          />
          <span>
            明晰夢の記憶を記録し、未来の明晰夢へ残響として使う
            {!settings.recordingEnabled && (
              <span className="settings-meta">（一時停止中。既存の記憶は自動削除されません）</span>
            )}
          </span>
        </label>
      )}

      <div className="settings-meta">
        保存件数: {eventCount}件
      </div>

      <div className="settings-action-row">
        <button type="button" onClick={() => setOpen((current) => !current)} disabled={busy || disabled}>
          {open ? '生記憶を閉じる' : '生記憶を閲覧する'}
        </button>
        <button type="button" onClick={refreshEvents} disabled={busy || disabled}>
          最新に更新
        </button>
        <button type="button" onClick={exportAll} disabled={busy || disabled}>
          書き出し（JSON）
        </button>
        <button type="button" className="danger" onClick={() => void wipeAll()} disabled={busy || disabled}>
          全消去
        </button>
      </div>

      {open && (
        <div className="dream-memory-browse">
          {!events || events.length === 0 ? (
            <p className="settings-meta">記録された明晰夢の記憶はありません。</p>
          ) : (
            <ul className="dream-memory-list">
              {[...events].reverse().map((event) => (
                <li key={event.eventId} className="dream-memory-item">
                  <div className="settings-meta">
                    {new Date(event.createdAt).toLocaleString('ja-JP')} ／
                    {event.type === 'observe'
                      ? '何も書かず観察した'
                      : event.type === 'wake'
                        ? '目覚めた'
                        : '書いた言葉'}
                    {event.rawText && <strong>「{event.rawText}」</strong>}
                  </div>
                  {event.anchor.contextText && (
                    <blockquote className="dream-memory-context">
                      {event.anchor.contextText.length > 200
                        ? `${event.anchor.contextText.slice(0, 200)}…`
                        : event.anchor.contextText}
                    </blockquote>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
