import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useNotificationCenter } from '../components/NotificationCenter';
import type {
  GenerationNotificationSettings,
  RefineAutomationRun,
} from '@shared/types';

const TERMINAL_PHASES = new Set(['complete', 'needsReview', 'stale', 'failed']);
const POLL_INTERVAL_MS = 1_500;
const AWAITING_ACCEPTANCE_POLL_INTERVAL_MS = 7_500;

/**
 * Keeps post-generation maintenance notifications alive while project screens
 * mount and unmount. The notification center owns the watch list; this hook
 * owns only polling, phase de-duplication, and notification formatting.
 */
export function useMaintenanceNotifications(): void {
  const {
    maintenanceWatchProjectIds,
    notify,
    removeMaintenanceWatch,
  } = useNotificationCenter();
  const [settings, setSettings] = useState<GenerationNotificationSettings | null>(null);
  const seenPhasesRef = useRef<Map<string, string>>(new Map());
  const watchPhasesRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    void api
      .getNotificationSettings()
      .then((nextSettings) => {
        if (!cancelled) setSettings(nextSettings);
      })
      .catch(() => {
        // 通知設定の取得失敗は本文編集を妨げない。App の次回 mount で再取得する。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE: Reader が unmount された後も、自動レビューの terminal phase を通知する。
  // runId + phase を記憶して polling ごとの重複を防ぎ、採用待ちの間だけ監視間隔を下げる。
  useEffect(() => {
    if (!settings || maintenanceWatchProjectIds.size === 0) return;

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      const projectIds = Array.from(maintenanceWatchProjectIds);
      await Promise.all(
        projectIds.map(async (projectId) => {
          try {
            const { status } = await api.getRefineAutomationSettings(projectId);
            if (cancelled) return;
            if (!status) {
              watchPhasesRef.current.delete(projectId);
              removeMaintenanceWatch(projectId);
              return;
            }

            watchPhasesRef.current.set(projectId, status.phase);
            const phaseKey = `${status.runId}:${status.phase}`;
            if (seenPhasesRef.current.get(projectId) === phaseKey) {
              // terminal state の通知が既に重複除外されていても watcher は解放する。
              if (TERMINAL_PHASES.has(status.phase)) {
                watchPhasesRef.current.delete(projectId);
                removeMaintenanceWatch(projectId);
              }
              return;
            }
            seenPhasesRef.current.set(projectId, phaseKey);

            const clickTarget = {
              kind: 'settingsFocus' as const,
              projectId,
              focus: { section: 'refine-history' as const, automationRunId: status.runId },
            };
            if (status.phase === 'awaitingAcceptance') {
              notify(settings, {
                eventType: 'reviewRequired',
                dedupeKey: `reviewRequired:${status.runId}:awaitingAcceptance`,
                title: '採用後に反映する提案があります',
                body: 'この生成案を採用すると、根拠を再確認して設定へ反映します。',
                clickTarget,
                persistent: true,
              });
              return;
            }

            if (!TERMINAL_PHASES.has(status.phase)) return;
            const runs = await api
              .getRefineAutomationRuns(projectId)
              .catch(() => [] as RefineAutomationRun[]);
            if (cancelled) return;
            const run = runs.find((candidate) => candidate.runId === status.runId);

            if (status.phase === 'complete' && status.appliedPatchIds.length > 0) {
              const highRiskApplied = (run?.highRiskAppliedPatchIds.length ?? 0) > 0;
              notify(settings, {
                eventType: highRiskApplied ? 'reviewRequired' : 'settingsUpdated',
                dedupeKey: `${highRiskApplied ? 'reviewRequired' : 'settingsUpdated'}:${status.runId}`,
                title: highRiskApplied ? '重要な設定を自動更新しました' : '設定を更新しました',
                body: `${status.appliedPatchIds.length}件の設定変更を${highRiskApplied ? '確認してください' : '反映しました'}`,
                clickTarget,
                persistent: highRiskApplied,
                forceInApp: highRiskApplied,
              });
            } else if (status.phase === 'needsReview') {
              notify(settings, {
                eventType: 'reviewRequired',
                dedupeKey: `reviewRequired:${status.runId}`,
                title: '確認が必要な提案があります',
                body: `${status.pendingPatchIds.length}件の設定提案を確認してください`,
                clickTarget,
                persistent: true,
              });
            } else if (status.phase === 'failed') {
              const scanFailed = (run?.patchIds.length ?? 0) === 0;
              notify(settings, {
                eventType: 'settingsUpdated',
                dedupeKey: `settingsUpdated:${status.runId}:failed`,
                title: scanFailed ? '設定の走査に失敗しました' : '設定更新の一部に失敗しました',
                body: scanFailed
                  ? '走査に失敗しました。本文は生成済みです。'
                  : (status.errorMessage ?? '自動設定レビューの状態を確認してください。'),
                clickTarget,
                persistent: true,
                forceInApp: true,
              });
            }

            watchPhasesRef.current.delete(projectId);
            removeMaintenanceWatch(projectId);
          } catch {
            // 作品削除や一時的なネットワーク切断では監視を残し、次回 polling で再確認する。
          }
        })
      );
    };

    const scheduleNextPoll = () => {
      if (cancelled || maintenanceWatchProjectIds.size === 0) return;
      const projectIds = Array.from(maintenanceWatchProjectIds);
      const allAwaitingAcceptance =
        projectIds.length > 0 &&
        projectIds.every(
          (projectId) => watchPhasesRef.current.get(projectId) === 'awaitingAcceptance'
        );
      timer = window.setTimeout(() => {
        void poll().finally(scheduleNextPoll);
      }, allAwaitingAcceptance ? AWAITING_ACCEPTANCE_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    };

    void poll().finally(scheduleNextPoll);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [maintenanceWatchProjectIds, notify, removeMaintenanceWatch, settings]);
}
