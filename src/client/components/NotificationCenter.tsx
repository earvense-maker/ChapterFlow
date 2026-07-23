import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { GenerationNotificationSettings, NotificationEventType, ProjectType, SettingsFocusTarget } from '@shared/types';
import {
  currentFocusState,
  playNotificationSound,
  resolveNotificationChannels,
  showSystemPopup,
  unlockAudioContext,
} from '../services/notificationService';

export interface NotificationClickTarget {
  kind: 'project' | 'settingsFocus' | 'setup';
  projectId?: string;
  projectType?: ProjectType;
  focus?: SettingsFocusTarget;
}

export interface NotifyInput {
  eventType: NotificationEventType;
  dedupeKey: string;
  title: string;
  body: string;
  clickTarget: NotificationClickTarget;
  // NOTE: 要確認通知など、ユーザーが閉じるまで残す通知。
  persistent?: boolean;
  // NOTE: events[eventType] が false でも、監査上の正本としてアプリ内通知だけは
  // 出したい場合に使う（all モードでの高リスク自動適用、適用/取消失敗など）。
  // 音・システムポップアップはこのフラグの影響を受けない。
  forceInApp?: boolean;
  // NOTE: 「テスト通知を送る」ボタン用。events[eventType] のゲートを完全に迂回して、
  // 現在有効なチャネル（sound/popup/inApp）だけを使って発火する。設定画面は常に
  // フォーカス中なので、onlyWhenUnfocused も迂回する。
  bypassEventGate?: boolean;
}

interface InAppNotice {
  id: string;
  eventType: NotificationEventType;
  title: string;
  body: string;
  clickTarget: NotificationClickTarget;
  persistent: boolean;
  createdAt: number;
}

const AUTO_DISMISS_MS = 6000;
const MAX_DEDUPE_KEYS = 200;

interface NotificationCenterValue {
  notices: InAppNotice[];
  notify: (settings: GenerationNotificationSettings, input: NotifyInput) => void;
  dismissNotice: (id: string) => void;
  registerClickHandler: (handler: (target: NotificationClickTarget) => void) => () => void;
  maintenanceWatchProjectIds: ReadonlySet<string>;
  addMaintenanceWatch: (projectId: string) => void;
  removeMaintenanceWatch: (projectId: string) => void;
  enableAudioFromGesture: () => void;
}

const NotificationCenterContext = createContext<NotificationCenterValue | null>(null);

let noticeIdCounter = 0;
function nextNoticeId(): string {
  noticeIdCounter += 1;
  return `notice-${Date.now()}-${noticeIdCounter}`;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<InAppNotice[]>([]);
  const [maintenanceWatchProjectIds, setMaintenanceWatchProjectIds] = useState<Set<string>>(new Set());
  const seenDedupeKeysRef = useRef<string[]>([]);
  const seenDedupeKeysSetRef = useRef<Set<string>>(new Set());
  const dismissTimersRef = useRef<Map<string, number>>(new Map());
  const clickHandlerRef = useRef<((target: NotificationClickTarget) => void) | null>(null);

  const dismissNotice = useCallback((id: string) => {
    const timer = dismissTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      dismissTimersRef.current.delete(id);
    }
    setNotices((prev) => prev.filter((notice) => notice.id !== id));
  }, []);

  const notify = useCallback(
    (settings: GenerationNotificationSettings, input: NotifyInput) => {
      if (seenDedupeKeysSetRef.current.has(input.dedupeKey)) return;
      seenDedupeKeysSetRef.current.add(input.dedupeKey);
      seenDedupeKeysRef.current.push(input.dedupeKey);
      if (seenDedupeKeysRef.current.length > MAX_DEDUPE_KEYS) {
        const oldest = seenDedupeKeysRef.current.shift();
        if (oldest !== undefined) seenDedupeKeysSetRef.current.delete(oldest);
      }

      const focus = currentFocusState();
      // NOTE: bypassEventGate はテスト通知専用。ユーザーはフォーカスした設定画面から
      // 操作しているため onlyWhenUnfocused も迂回して「今そのチャネルが有効なら
      // 必ず鳴らす」挙動にする。イベントゲートだけを迂回してフォーカスゲートを残すと
      // 「音を鳴らしたのにテストで鳴らない」という混乱を招く。
      const channels = input.bypassEventGate
        ? {
            sound: settings.soundEnabled,
            popup: settings.systemPopupEnabled,
            inApp: true,
          }
        : resolveNotificationChannels(settings, input.eventType, focus);
      if (channels.sound) void playNotificationSound();
      if (channels.popup) {
        showSystemPopup(input.title, input.body, () => {
          clickHandlerRef.current?.(input.clickTarget);
        });
      }

      if (!channels.inApp && !input.forceInApp) return;

      const id = nextNoticeId();
      const persistent = !!input.persistent;
      setNotices((prev) => [
        ...prev,
        {
          id,
          eventType: input.eventType,
          title: input.title,
          body: input.body,
          clickTarget: input.clickTarget,
          persistent,
          createdAt: Date.now(),
        },
      ]);
      if (!persistent) {
        const timer = window.setTimeout(() => dismissNotice(id), AUTO_DISMISS_MS);
        dismissTimersRef.current.set(id, timer);
      }
    },
    [dismissNotice]
  );

  const registerClickHandler = useCallback((handler: (target: NotificationClickTarget) => void) => {
    clickHandlerRef.current = handler;
    return () => {
      if (clickHandlerRef.current === handler) clickHandlerRef.current = null;
    };
  }, []);

  const addMaintenanceWatch = useCallback((projectId: string) => {
    setMaintenanceWatchProjectIds((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, []);

  const removeMaintenanceWatch = useCallback((projectId: string) => {
    setMaintenanceWatchProjectIds((prev) => {
      if (!prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.delete(projectId);
      return next;
    });
  }, []);

  const enableAudioFromGesture = useCallback(() => {
    unlockAudioContext();
  }, []);

  useEffect(
    () => () => {
      for (const timer of dismissTimersRef.current.values()) window.clearTimeout(timer);
    },
    []
  );

  const handleCardClick = (notice: InAppNotice) => {
    clickHandlerRef.current?.(notice.clickTarget);
    if (!notice.persistent) dismissNotice(notice.id);
  };

  const value = useMemo<NotificationCenterValue>(
    () => ({
      notices,
      notify,
      dismissNotice,
      registerClickHandler,
      maintenanceWatchProjectIds,
      addMaintenanceWatch,
      removeMaintenanceWatch,
      enableAudioFromGesture,
    }),
    [
      notices,
      notify,
      dismissNotice,
      registerClickHandler,
      maintenanceWatchProjectIds,
      addMaintenanceWatch,
      removeMaintenanceWatch,
      enableAudioFromGesture,
    ]
  );

  return (
    <NotificationCenterContext.Provider value={value}>
      {children}
      {notices.length > 0 && (
        <div className="notification-toast-stack" aria-live="polite">
          {notices.map((notice) => (
            <div
              key={notice.id}
              className={`notification-toast${notice.persistent ? ' persistent' : ''}`}
              role="status"
            >
              <button
                type="button"
                className="notification-toast-body"
                onClick={() => handleCardClick(notice)}
              >
                <strong>{notice.title}</strong>
                <span>{notice.body}</span>
              </button>
              <button
                type="button"
                className="notification-toast-dismiss"
                aria-label="通知を閉じる"
                onClick={() => dismissNotice(notice.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </NotificationCenterContext.Provider>
  );
}

// NOTE: Provider が無い場合は throw ではなく無害な no-op を返す（useConfirm と同じく、
// 単体テストで通知機能を使わない画面を NotificationProvider 無しでレンダーできるように
// する）。実アプリでは main.tsx が必ず Provider をマウントするため、ここに来るのは
// テスト環境だけの想定。
const NOOP_NOTIFICATION_CENTER: NotificationCenterValue = {
  notices: [],
  notify: () => {},
  dismissNotice: () => {},
  registerClickHandler: () => () => {},
  maintenanceWatchProjectIds: new Set(),
  addMaintenanceWatch: () => {},
  removeMaintenanceWatch: () => {},
  enableAudioFromGesture: () => {},
};

export function useNotificationCenter(): NotificationCenterValue {
  const value = useContext(NotificationCenterContext);
  return value ?? NOOP_NOTIFICATION_CENTER;
}
