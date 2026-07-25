import type {
  GenerationNotificationSettings,
  NotificationEventType,
  NotificationSoundId,
} from '@shared/types';

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

interface ToneSpec {
  frequency: number;
  // NOTE: 発音開始のオフセット秒。複数 tone を重ねる/ずらすことで音色差を作る。
  startOffset: number;
  // NOTE: 減衰しきるまでの秒数。stop はこれに余韻ぶんを足した時刻で呼ぶ。
  decay: number;
  peak: number;
  type: OscillatorType;
}

// NOTE: 'chime' は音種選択を足す前から鳴っていた 880Hz 単音そのまま（既定値）。
// 他は聞き分けが目的なので、音域・波形・音数のどれかを必ず変えてある。
const SOUND_SPECS: Record<NotificationSoundId, ToneSpec[]> = {
  chime: [{ frequency: 880, startOffset: 0, decay: 0.35, peak: 0.2, type: 'sine' }],
  bell: [
    { frequency: 1318.5, startOffset: 0, decay: 0.6, peak: 0.16, type: 'sine' },
    { frequency: 659.25, startOffset: 0, decay: 0.9, peak: 0.09, type: 'sine' },
  ],
  marimba: [
    { frequency: 523.25, startOffset: 0, decay: 0.3, peak: 0.22, type: 'triangle' },
    { frequency: 1046.5, startOffset: 0, decay: 0.14, peak: 0.07, type: 'sine' },
  ],
  blip: [
    { frequency: 988, startOffset: 0, decay: 0.1, peak: 0.16, type: 'triangle' },
    { frequency: 1318.5, startOffset: 0.13, decay: 0.12, peak: 0.16, type: 'triangle' },
  ],
};

const SOUND_LABELS: Record<NotificationSoundId, string> = {
  chime: 'チャイム（高い単音）',
  bell: 'ベル（余韻が長い）',
  marimba: 'マリンバ（低く短い）',
  blip: 'ブリップ（2連の電子音）',
};

// NOTE: 選択肢は SOUND_SPECS から導出する。音を足したときにラベル漏れ（Record が
// 埋まっていない）も選択肢漏れも起きないようにするため、一覧を手で二重管理しない。
export const NOTIFICATION_SOUND_OPTIONS: readonly {
  id: NotificationSoundId;
  label: string;
}[] = (Object.keys(SOUND_SPECS) as NotificationSoundId[]).map((id) => ({
  id,
  label: SOUND_LABELS[id],
}));

export async function playNotificationSound(soundId: NotificationSoundId): Promise<void> {
  if (!audioContext) return;
  try {
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    // NOTE: 保存データに未知の ID が入っていても無音にはせず既定音へ倒す。
    const spec = SOUND_SPECS[soundId] ?? SOUND_SPECS.chime;
    const startedAt = audioContext.currentTime;
    for (const tone of spec) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const toneStart = startedAt + tone.startOffset;
      oscillator.type = tone.type;
      oscillator.frequency.value = tone.frequency;
      gain.gain.setValueAtTime(0.0001, toneStart);
      gain.gain.exponentialRampToValueAtTime(tone.peak, toneStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, toneStart + tone.decay);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneStart + tone.decay + 0.05);
    }
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
