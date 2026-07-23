import { useEffect, useRef, useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';
import AppSettingsPanel from './components/AppSettingsPanel';
import RoleplayWorkspace from './components/RoleplayWorkspace';
import { useNotificationCenter } from './components/NotificationCenter';
import { api } from './clientApi';
import type {
  GenerationNotificationSettings,
  ProjectType,
  RefineAutomationRun,
  SettingsFocusTarget,
  SetupPurpose,
} from '@shared/types';

type View =
  | 'list'
  | 'new'
  | 'setup'
  | 'read'
  | 'roleplay'
  | 'app-settings'
  | 'settings-work'
  | 'settings-tech'
  | 'settings-memory';

const MAINTENANCE_WATCH_TERMINAL_PHASES = new Set(['complete', 'needsReview', 'stale', 'failed']);
const MAINTENANCE_POLL_INTERVAL_MS = 1_500;
const AWAITING_ACCEPTANCE_POLL_INTERVAL_MS = 7_500;

export default function App() {
  const notificationCenter = useNotificationCenter();
  const [view, setView] = useState<View>('list');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [appSettingsBackView, setAppSettingsBackView] = useState<View>('list');
  const [appSettingsInitialProvider, setAppSettingsInitialProvider] = useState<string | undefined>();
  // NOTE: 相談セッションの用途。setup 画面遷移・設定往復・再読込で同じ値を渡す。
  const [setupPurpose, setSetupPurpose] = useState<SetupPurpose>('novel');
  // NOTE: 設定画面から戻る先を「Reader / RoleplayWorkspace」で分けるための保持。
  const [projectMainView, setProjectMainView] = useState<'read' | 'roleplay'>('read');
  // NOTE: 通知クリックで「作品設定相談の該当run/patch」へフォーカスするための一時state。
  // SettingPanel -> WorkSettingsTab -> RefineChatPanel まで受け渡し、消費後にクリアする。
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget | null>(null);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const [notificationSettings, setNotificationSettings] = useState<GenerationNotificationSettings | null>(null);
  const seenMaintenancePhasesRef = useRef<Map<string, string>>(new Map());
  const maintenanceWatchPhasesRef = useRef<Map<string, string>>(new Map());

  const openProjectByType = (projectId: string, projectType: ProjectType) => {
    setActiveProjectId(projectId);
    if (projectType === 'roleplay') {
      setProjectMainView('roleplay');
      setView('roleplay');
    } else {
      setProjectMainView('read');
      setView('read');
    }
  };

  const handleOpenProject = async (projectId: string, projectType?: ProjectType) => {
    if (projectType) {
      openProjectByType(projectId, projectType);
      return;
    }
    // NOTE: サマリーから projectType が渡らなかった場合は API で確認してから遷移する。
    try {
      const project = await api.getProject(projectId);
      openProjectByType(projectId, project.projectType ?? 'novel');
    } catch {
      openProjectByType(projectId, 'novel');
    }
  };

  const handleCreateProject = async (projectId: string) => {
    // NOTE: setup コミットから戻ってきたときは projectType を再確認して振り分ける。
    try {
      const project = await api.getProject(projectId);
      openProjectByType(projectId, project.projectType ?? 'novel');
    } catch {
      openProjectByType(projectId, 'novel');
    }
  };

  const handleBackToList = () => {
    setActiveProjectId(null);
    setView('list');
  };

  const settingsInitialTab =
    view === 'settings-work' ? 'work' :
    view === 'settings-tech' ? 'tech' :
    view === 'settings-memory' ? 'memory' : undefined;

  const openAppSettings = (backView: View, initialProvider?: string) => {
    setAppSettingsBackView(backView);
    setAppSettingsInitialProvider(initialProvider);
    setView('app-settings');
  };

  const openSettings = (nextView: 'settings-work' | 'settings-tech' | 'settings-memory') => {
    setView(nextView);
  };

  // NOTE: 生成通知のクリック時遷移。対象作品が既に削除されている場合は一覧へ戻し、
  // 理由を短く表示する（設計書 12.1）。
  useEffect(() => {
    return notificationCenter.registerClickHandler((target) => {
      if (target.kind === 'setup') {
        setView('setup');
        return;
      }
      const projectId = target.projectId;
      if (!projectId) return;
      void api
        .getProject(projectId)
        .then((project) => {
          const projectType = project.projectType ?? 'novel';
          if (target.kind === 'settingsFocus') {
            setSettingsFocusTarget(target.focus ?? null);
            setActiveProjectId(projectId);
            setProjectMainView(projectType === 'roleplay' ? 'roleplay' : 'read');
            setView('settings-work');
          } else {
            openProjectByType(projectId, projectType);
          }
        })
        .catch(() => {
          setListNotice('通知の対象は見つかりませんでした。作品が削除された可能性があります。');
          setActiveProjectId(null);
          setView('list');
        });
    });
  }, [notificationCenter.registerClickHandler]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getNotificationSettings()
      .then((settings) => {
        if (!cancelled) setNotificationSettings(settings);
      })
      .catch(() => {
        // 通知設定の取得失敗は本文編集を妨げない。次の App 再描画時に再取得される。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // NOTE: Reader が unmount された後も、自動レビューの terminal phase を通知するための
  // App 全体監視。runId + phase を記憶して polling ごとの重複を防ぐ。採用待ちは
  // モデル処理も書き込みも行わないため、その間だけ監視間隔を下げる。
  useEffect(() => {
    if (!notificationSettings || notificationCenter.maintenanceWatchProjectIds.size === 0) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      const projectIds = Array.from(notificationCenter.maintenanceWatchProjectIds);
      await Promise.all(
        projectIds.map(async (projectId) => {
          try {
            const { status } = await api.getRefineAutomationSettings(projectId);
            if (cancelled) return;
            if (!status) {
              maintenanceWatchPhasesRef.current.delete(projectId);
              notificationCenter.removeMaintenanceWatch(projectId);
              return;
            }
            maintenanceWatchPhasesRef.current.set(projectId, status.phase);
            const phaseKey = `${status.runId}:${status.phase}`;
            if (seenMaintenancePhasesRef.current.get(projectId) === phaseKey) {
              // A terminal state may be re-observed after its notification was already
              // de-duplicated; it must still release the watcher.
              if (MAINTENANCE_WATCH_TERMINAL_PHASES.has(status.phase)) {
                maintenanceWatchPhasesRef.current.delete(projectId);
                notificationCenter.removeMaintenanceWatch(projectId);
              }
              return;
            }
            seenMaintenancePhasesRef.current.set(projectId, phaseKey);

            const clickTarget = {
              kind: 'settingsFocus' as const,
              projectId,
              focus: { section: 'refine-history' as const, automationRunId: status.runId },
            };
            if (status.phase === 'awaitingAcceptance') {
              notificationCenter.notify(notificationSettings, {
                eventType: 'reviewRequired',
                dedupeKey: `reviewRequired:${status.runId}:awaitingAcceptance`,
                title: '採用後に反映する提案があります',
                body: 'この生成案を採用すると、根拠を再確認して設定へ反映します。',
                clickTarget,
                persistent: true,
              });
              return;
            }

            if (!MAINTENANCE_WATCH_TERMINAL_PHASES.has(status.phase)) return;
            const runs = await api.getRefineAutomationRuns(projectId).catch(() => [] as RefineAutomationRun[]);
            if (cancelled) return;
            const run = runs.find((candidate) => candidate.runId === status.runId);
            if (status.phase === 'complete' && status.appliedPatchIds.length > 0) {
              const highRiskApplied = (run?.highRiskAppliedPatchIds.length ?? 0) > 0;
              notificationCenter.notify(notificationSettings, {
                eventType: highRiskApplied ? 'reviewRequired' : 'settingsUpdated',
                dedupeKey: `${highRiskApplied ? 'reviewRequired' : 'settingsUpdated'}:${status.runId}`,
                title: highRiskApplied ? '重要な設定を自動更新しました' : '設定を更新しました',
                body: `${status.appliedPatchIds.length}件の設定変更を${highRiskApplied ? '確認してください' : '反映しました'}`,
                clickTarget,
                persistent: highRiskApplied,
                forceInApp: highRiskApplied,
              });
            } else if (status.phase === 'needsReview') {
              notificationCenter.notify(notificationSettings, {
                eventType: 'reviewRequired',
                dedupeKey: `reviewRequired:${status.runId}`,
                title: '確認が必要な提案があります',
                body: `${status.pendingPatchIds.length}件の設定提案を確認してください`,
                clickTarget,
                persistent: true,
              });
            } else if (status.phase === 'failed') {
              const scanFailed = (run?.patchIds.length ?? 0) === 0;
              notificationCenter.notify(notificationSettings, {
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
            maintenanceWatchPhasesRef.current.delete(projectId);
            notificationCenter.removeMaintenanceWatch(projectId);
          } catch {
            // 作品削除や一時的なネットワーク切断では監視を残し、次回の polling で再確認する。
          }
        })
      );
    };
    const scheduleNextPoll = () => {
      if (cancelled || notificationCenter.maintenanceWatchProjectIds.size === 0) return;
      const projectIds = Array.from(notificationCenter.maintenanceWatchProjectIds);
      const allAwaitingAcceptance =
        projectIds.length > 0 &&
        projectIds.every((projectId) => maintenanceWatchPhasesRef.current.get(projectId) === 'awaitingAcceptance');
      timer = window.setTimeout(() => {
        void poll().finally(scheduleNextPoll);
      }, allAwaitingAcceptance ? AWAITING_ACCEPTANCE_POLL_INTERVAL_MS : MAINTENANCE_POLL_INTERVAL_MS);
    };
    void poll().finally(scheduleNextPoll);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [notificationSettings, notificationCenter]);

  return (
    <div className="app">
      {view === 'list' && (
        <>
          {listNotice && (
            <div className="status-toast" role="status" onClick={() => setListNotice(null)}>
              {listNotice}
            </div>
          )}
          <ProjectList
            onOpen={handleOpenProject}
            onNew={() => setView('new')}
            onSetupNew={() => {
              setSetupPurpose('novel');
              setView('setup');
            }}
            onSetupRoleplay={() => {
              setSetupPurpose('roleplay');
              setView('setup');
            }}
            onOpenAppSettings={() => openAppSettings('list')}
          />
        </>
      )}
      {view === 'new' && <ProjectForm onCreated={handleCreateProject} onCancel={handleBackToList} />}
      {view === 'setup' && (
        <SetupWorkspace
          purpose={setupPurpose}
          onCreated={handleCreateProject}
          onCancel={handleBackToList}
          onOpenSettings={() => openAppSettings('setup')}
        />
      )}
      {view === 'read' && activeProjectId && (
        <Reader
          projectId={activeProjectId}
          onBack={handleBackToList}
          onOpenWorkSettings={() => openSettings('settings-work')}
          onOpenTechSettings={() => openSettings('settings-tech')}
          onOpenMemories={() => openSettings('settings-memory')}
        />
      )}
      {view === 'roleplay' && activeProjectId && (
        <RoleplayWorkspace
          projectId={activeProjectId}
          onBack={handleBackToList}
          onOpenWorkSettings={() => openSettings('settings-work')}
          onOpenTechSettings={() => openSettings('settings-tech')}
        />
      )}
      {view === 'app-settings' && (
        <AppSettingsPanel
          initialProvider={appSettingsInitialProvider}
          onBack={() => setView(appSettingsBackView)}
        />
      )}
      {(view === 'settings-work' || view === 'settings-tech' || view === 'settings-memory') &&
        activeProjectId && (
          <SettingPanel
            projectId={activeProjectId}
            onBack={() => setView(projectMainView)}
            onOpenAppSettings={(provider) => openAppSettings('settings-tech', provider)}
            initialTab={settingsInitialTab}
            focusTarget={settingsFocusTarget}
            onFocusTargetConsumed={() => setSettingsFocusTarget(null)}
          />
        )}
    </div>
  );
}
