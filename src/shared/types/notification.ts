// ===== 生成通知（アプリ全体設定） =====

export interface GenerationNotificationEvents {
  firstOutput: boolean;
  completed: boolean;
  failed: boolean;
  settingsUpdated: boolean;
  reviewRequired: boolean;
}

export interface GenerationNotificationSettings {
  soundEnabled: boolean;
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
