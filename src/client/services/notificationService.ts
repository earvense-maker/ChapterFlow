import type { GenerationNotificationSettings, NotificationEventType } from '@shared/types';

// NOTE: 音・OS通知・アプリ内通知の実際のディスパッチと、どのチャネルを使うべきかの
// 判定ロジック。React に依存しない純粋関数＋ブラウザAPIラッパーのみで構成する。

export interface FocusState {
  visible: boolean;
  focused: boolean;
}

export function currentFocusState(): FocusState {
  return {
    visible: typeof document !== 'undefined' ? document.visibilityState === 'visible' : true,
    focused: typeof document !== 'undefined' ? document.hasFocus() : true,
  };
}

export interface ResolvedNotificationChannels {
  sound: boolean;
  popup: boolean;
  inApp: boolean;
}

// NOTE: events[eventType] が false でも、監査上の正本として必ずアプリ内通知を出したい
// 場合（all モードでの高リスク自動適用、適用/取消の失敗）は呼び出し側が forceInApp を
// 使う。ここでは「通常の設定に従った場合」のチャネルだけを判定する。
export function resolveNotificationChannels(
  settings: GenerationNotificationSettings,
  eventType: NotificationEventType,
  focus: FocusState
): ResolvedNotificationChannels {
  if (!settings.events[eventType]) {
    return { sound: false, popup: false, inApp: false };
  }
  const unfocusedGateOpen = !settings.onlyWhenUnfocused || !focus.visible || !focus.focused;
  return {
    sound: settings.soundEnabled && unfocusedGateOpen,
    popup: settings.systemPopupEnabled && unfocusedGateOpen,
    inApp: true,
  };
}

// ---------- 通知音（Web Audio oscillator） ----------
// NOTE: リポジトリに音声アセットが無いため、簡単な発振音で代替する。失敗しても
// 生成処理自体には影響させない（設計書 6.2 / 12.1）。

let audioContext: AudioContext | null = null;
let audioUnlockAttempted = false;

// NOTE: ブラウザの自動再生制限により、最初のユーザージェスチャ（設定操作や送信操作）
// より前は AudioContext を作れない/鳴らせないことがある。呼び出し側は設定操作や
// 送信操作のハンドラ内でこれを呼ぶ。失敗しても静かに諦め、次回以降また試す。
export function unlockAudioContext(): void {
  if (audioContext || audioUnlockAttempted) return;
  audioUnlockAttempted = true;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
    if (!Ctor) return;
    audioContext = new Ctor();
  } catch {
    // NOTE: 失敗時は audioContext が null のままになり、playNotificationSound が
    // 静かに no-op する。次のユーザー操作でまた unlockAudioContext を呼べば再試行できる。
    audioUnlockAttempted = false;
  }
}

export async function playNotificationSound(): Promise<void> {
  if (!audioContext) return;
  try {
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.35);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.4);
  } catch (err) {
    console.warn('[notification] sound playback failed', err);
  }
}

// ---------- OS システムポップアップ（Web Notification API） ----------

export function isSystemPopupAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification !== 'undefined';
}

export function systemPopupPermission(): NotificationPermission {
  return isSystemPopupAvailable() ? Notification.permission : 'denied';
}

// NOTE: 許可要求は「設定を有効化したユーザー操作の中」でだけ呼ぶこと（起動時に
// 呼ばない）。'default' 以外（granted/denied）は再要求しない — 連打防止（設計書 12.1）。
export async function requestSystemPopupPermission(): Promise<NotificationPermission> {
  if (!isSystemPopupAvailable()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function showSystemPopup(title: string, body: string, onClick: () => void): boolean {
  if (!isSystemPopupAvailable() || Notification.permission !== 'granted') return false;
  try {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
    return true;
  } catch (err) {
    console.warn('[notification] system popup failed', err);
    return false;
  }
}
