import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { useNotificationCenter } from './NotificationCenter';
import {
  NOTIFICATION_SOUND_OPTIONS,
  isSystemPopupAvailable,
  playNotificationSound,
  requestSystemPopupPermission,
  systemPopupPermission,
} from '../services/notificationService';
import type { GenerationNotificationSettings, NotificationSoundId } from '@shared/types';

interface Props {
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  // NOTE: アプリ設定以外（作品の生成設定タブなど）に置くときだけ、アプリ全体設定である
  // ことを明示するための補足。設定の実体は1つで、どこから変えても同じ値を書き換える。
  scopeNote?: string;
}

export default function GenerationNotificationSection({ onError, onFlashMessage, scopeNote }: Props) {
  const notificationCenter = useNotificationCenter();
  const [settings, setSettings] = useState<GenerationNotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [popupPermission, setPopupPermission] = useState<NotificationPermission>(systemPopupPermission());

  useEffect(() => {
    let cancelled = false;
    api
      .getNotificationSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : '通知設定の読み込みに失敗しました');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // NOTE: onError は呼び出し側で毎レンダー再生成される想定なので依存に入れない。
    // 取得はマウント時の1回だけでよい。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(next: GenerationNotificationSettings) {
    setSettings(next);
    try {
      setSaving(true);
      onError(null);
      const saved = await api.updateNotificationSettings(next);
      setSettings(saved);
      onFlashMessage('生成通知の設定を保存しました。');
    } catch (err) {
      onError(err instanceof Error ? err.message : '通知設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  function update(patch: Partial<GenerationNotificationSettings>) {
    if (!settings) return;
    void save({ ...settings, ...patch });
  }

  function updateEvent(event: keyof GenerationNotificationSettings['events'], value: boolean) {
    if (!settings) return;
    void save({ ...settings, events: { ...settings.events, [event]: value } });
  }

  async function handleSystemPopupToggle(checked: boolean) {
    if (checked) {
      const permission = await requestSystemPopupPermission();
      setPopupPermission(permission);
    }
    update({ systemPopupEnabled: checked });
  }

  function handleSoundChange(soundId: NotificationSoundId) {
    // NOTE: 選んだ音をその場で鳴らす。選択操作自体がユーザージェスチャなので、
    // ここで AudioContext を解錠しておけば初回選択から試聴できる。
    notificationCenter.enableAudioFromGesture();
    void playNotificationSound(soundId);
    update({ soundId });
  }

  function previewSound() {
    notificationCenter.enableAudioFromGesture();
    if (!settings) return;
    void playNotificationSound(settings.soundId);
  }

  function sendTestNotification() {
    notificationCenter.enableAudioFromGesture();
    if (!settings) return;
    notificationCenter.notify(settings, {
      eventType: 'completed',
      dedupeKey: `test-notification-${Date.now()}`,
      title: 'テスト通知',
      body: 'この内容が音・ポップアップ・アプリ内通知として届けば設定は正しく動いています。',
      clickTarget: { kind: 'setup' },
      // NOTE: completed イベントは既定 false のため、テスト用にゲートを迂回して
      // 有効なチャネル全てを使って発火させる（設計書の意図と揃える）。
      bypassEventGate: true,
    });
  }

  return (
    <section className="settings-section">
      <h2>生成通知</h2>
      <p className="settings-help">
        本文の生成開始・完了・失敗や、設定の自動更新を音・システムポップアップ・アプリ内通知でお知らせします。
      </p>
      {scopeNote && <p className="settings-help">{scopeNote}</p>}
      {loading ? (
        <div className="loading">読み込み中…</div>
      ) : !settings ? (
        // NOTE: 取得に失敗しても onError 側のトーストは他の操作で消える。ここが
        // 「読み込み中…」のままだと復帰手段が分からないので、この節にも残す。
        <p className="settings-help">通知設定を読み込めませんでした。画面を再読み込みしてください。</p>
      ) : (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.soundEnabled}
              onChange={(e) => {
                notificationCenter.enableAudioFromGesture();
                update({ soundEnabled: e.target.checked });
              }}
              disabled={saving}
            />
            <span>通知音を鳴らす</span>
          </label>
          <label>
            通知音の種類
            <select
              value={settings.soundId}
              onChange={(e) => handleSoundChange(e.target.value as NotificationSoundId)}
              disabled={saving}
            >
              {NOTIFICATION_SOUND_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="summary-card-actions">
            <button type="button" onClick={previewSound} disabled={saving}>
              この音を試聴
            </button>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.systemPopupEnabled}
              onChange={(e) => void handleSystemPopupToggle(e.target.checked)}
              disabled={saving || !isSystemPopupAvailable()}
            />
            <span>システムポップアップを出す</span>
          </label>
          {settings.systemPopupEnabled && popupPermission === 'denied' && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              システム通知は許可されていません。アプリ内通知を使います。
            </p>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.onlyWhenUnfocused}
              onChange={(e) => update({ onlyWhenUnfocused: e.target.checked })}
              disabled={saving}
            />
            <span>アプリが背面にあるときだけ通知する</span>
          </label>

          <p className="settings-help" style={{ marginTop: '0.75rem' }}>
            通知するタイミング
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.firstOutput}
              onChange={(e) => updateEvent('firstOutput', e.target.checked)}
              disabled={saving}
            />
            <span>最初の文章が届いたとき</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.completed}
              onChange={(e) => updateEvent('completed', e.target.checked)}
              disabled={saving}
            />
            <span>生成が完了したとき</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.failed}
              onChange={(e) => updateEvent('failed', e.target.checked)}
              disabled={saving}
            />
            <span>生成に失敗したとき</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.settingsUpdated}
              onChange={(e) => updateEvent('settingsUpdated', e.target.checked)}
              disabled={saving}
            />
            <span>設定が自動更新されたとき</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.reviewRequired}
              onChange={(e) => updateEvent('reviewRequired', e.target.checked)}
              disabled={saving}
            />
            <span>確認が必要な変更があるとき</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={settings.events.ngRewrite}
              onChange={(e) => updateEvent('ngRewrite', e.target.checked)}
              disabled={saving}
            />
            <span>NG表現の書き換えが済んだとき</span>
          </label>

          <div className="summary-card-actions">
            <button type="button" onClick={sendTestNotification} disabled={saving}>
              テスト通知を送る
            </button>
          </div>
        </>
      )}
    </section>
  );
}
