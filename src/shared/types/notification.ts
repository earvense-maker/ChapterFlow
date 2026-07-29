// ===== 生成通知（アプリ全体設定） =====

export interface GenerationNotificationEvents {
  firstOutput: boolean;
  completed: boolean;
  failed: boolean;
  settingsUpdated: boolean;
  reviewRequired: boolean;
  // NOTE: NG表現の局所リライトが本文を書き換えたとき。本文が勝手に変わったことは
  // 必ず知らせたいので、既定は on。
  ngRewrite: boolean;
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
// 遷移先は AI相談タブ（会話タイムライン + 気づき受信箱）の1箇所のみ。
// 旧 'refine-history' はクライアント内 state だけで運ばれていたため、生成側
// (useMaintenanceNotifications) と消費側を同時に更新すれば互換処理は不要。
export interface SettingsFocusTarget {
  section: 'ai-consultation';
  automationRunId?: string;
  patchId?: string;
  findingId?: string;
}
