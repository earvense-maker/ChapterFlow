// ===== 生成通知（アプリ全体設定） =====

export interface GenerationNotificationEvents {
  firstOutput: boolean;
  completed: boolean;
  failed: boolean;
  settingsUpdated: boolean;
  reviewRequired: boolean;
}

// NOTE: リポジトリに音声アセットを持たないため、通知音は Web Audio の合成音で用意する
// （notificationService の SOUND_SPECS が実体）。ID は保存データに載るので、音色を
// 調整しても ID 自体は変えない。
export type NotificationSoundId = 'chime' | 'bell' | 'marimba' | 'blip';

export interface GenerationNotificationSettings {
  soundEnabled: boolean;
  soundId: NotificationSoundId;
  systemPopupEnabled: boolean;
  onlyWhenUnfocused: boolean;
  events: GenerationNotificationEvents;
}

export type NotificationEventType = keyof GenerationNotificationEvents;

// NOTE: URL router が無いため、通知クリック時の遷移先を state として明示的に運ぶ。
// 現状は作品設定 → 作品設定相談 → 履歴 の1箇所のみが対象。
export interface SettingsFocusTarget {
  section: 'refine-history';
  automationRunId?: string;
  patchId?: string;
}
