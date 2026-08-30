import { useEffect, useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';
import QuickSetupWorkspace from './components/QuickSetupWorkspace';
import AppSettingsPanel from './components/AppSettingsPanel';
import RoleplayWorkspace from './components/RoleplayWorkspace';
import DreamWorkspace from './components/DreamWorkspace';
import AmplifierEntry from './components/AmplifierEntry';
import ErrorBoundary from './components/ErrorBoundary';
import { useNotificationCenter } from './components/NotificationCenter';
import { useMaintenanceNotifications } from './hooks/useMaintenanceNotifications';
import { api } from './clientApi';
import type {
  ExperienceMode,
  ProjectType,
  SettingsFocusTarget,
  SetupPurpose,
} from '@shared/types';

type View =
  | 'list'
  | 'new'
  | 'setup'
  | 'quick-setup'
  | 'amplifier-entry'
  | 'read'
  | 'roleplay'
  | 'dream'
  | 'app-settings'
  | 'settings-work'
  | 'settings-tech'
  | 'settings-memory';

type SetupSessionEntry = 'fresh' | 'resume';

export default function App() {
  const notificationCenter = useNotificationCenter();
  useMaintenanceNotifications();
  const [view, setView] = useState<View>('list');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [appSettingsBackView, setAppSettingsBackView] = useState<View>('list');
  const [appSettingsInitialProvider, setAppSettingsInitialProvider] = useState<string | undefined>();
  // NOTE: 相談セッションの用途。setup 画面遷移・設定往復・再読込で同じ値を渡す。
  const [setupPurpose, setSetupPurpose] = useState<SetupPurpose>('novel');
  // NOTE: 体験モード（妄想増幅器）。クイックセットアップから詳細設定へ移っても失わない
  // （設計書 4.1）。SetupWorkspace 側でもセッション値から復元される。
  const [setupExperienceMode, setSetupExperienceMode] = useState<ExperienceMode>('standard');
  // NOTE: 一覧の作成入口は別作品の古い相談を引き継がず、設定画面との往復や
  // クイック設定で作成済みの相談だけを再開する。
  const [setupSessionEntry, setSetupSessionEntry] = useState<SetupSessionEntry>('resume');
  // NOTE: 設定画面から戻る先を「Reader / RoleplayWorkspace / DreamWorkspace」で分けるための保持。
  const [projectMainView, setProjectMainView] = useState<'read' | 'roleplay' | 'dream'>('read');
  // NOTE: 通知クリックで「作品設定相談の該当run/patch」へフォーカスするための一時state。
  // SettingPanel -> WorkSettingsTab -> RefineChatPanel まで受け渡し、消費後にクリアする。
  const [settingsFocusTarget, setSettingsFocusTarget] = useState<SettingsFocusTarget | null>(null);
  const [listNotice, setListNotice] = useState<string | null>(null);

  // NOTE: 夢見るモード（設計書 §9）。experienceMode === 'dream' を最優先で振り分け、
  // 次に projectType === 'roleplay'、それ以外は Reader。
  const openProjectByType = (
    projectId: string,
    projectType?: ProjectType,
    experienceMode?: ExperienceMode
  ) => {
    setActiveProjectId(projectId);
    if (experienceMode === 'dream') {
      setProjectMainView('dream');
      setView('dream');
    } else if (projectType === 'roleplay') {
      setProjectMainView('roleplay');
      setView('roleplay');
    } else {
      setProjectMainView('read');
      setView('read');
    }
  };

  const handleOpenProject = async (
    projectId: string,
    projectType?: ProjectType,
    experienceMode?: ExperienceMode
  ) => {
    if (projectType) {
      openProjectByType(projectId, projectType, experienceMode);
      return;
    }
    // NOTE: サマリーから projectType が渡らなかった場合は API で確認してから遷移する。
    try {
      const project = await api.getProject(projectId);
      openProjectByType(projectId, project.projectType ?? 'novel', project.experienceMode);
    } catch {
      openProjectByType(projectId, 'novel');
    }
  };

  const handleCreateProject = async (projectId: string) => {
    // NOTE: setup コミットから戻ってきたときは projectType / experienceMode を再確認して
    // 振り分ける（設計書 §9: 作成完了や通知からの遷移も取得した project 本体で判定）。
    try {
      const project = await api.getProject(projectId);
      openProjectByType(projectId, project.projectType ?? 'novel', project.experienceMode);
    } catch {
      openProjectByType(projectId, 'novel');
    }
  };

  const handleBackToList = () => {
    setActiveProjectId(null);
    // 妄想増幅器の作成フローを離れた後、通常作成へモードを持ち越さない。
    setSetupExperienceMode('standard');
    setView('list');
  };

  const settingsInitialTab =
    view === 'settings-work' ? 'work' :
    view === 'settings-tech' ? 'tech' :
    view === 'settings-memory' ? 'memory' : undefined;

  const openAppSettings = (backView: View, initialProvider?: string) => {
    if (backView === 'setup') {
      // 設定画面から戻ったときは、いま開いている相談を作り直さず再開する。
      setSetupSessionEntry('resume');
    }
    setAppSettingsBackView(backView);
    setAppSettingsInitialProvider(initialProvider);
    setView('app-settings');
  };

  const openSettings = (nextView: 'settings-work' | 'settings-tech' | 'settings-memory') => {
    setView(nextView);
  };

  // SPA 内の画面切替では一覧側のスクロール位置が残る。妄想増幅器の入口や作成画面を
  // 見出しの途中から表示しないよう、対象ビューへ入った時だけ先頭へ戻す。
  useEffect(() => {
    if (
      view === 'amplifier-entry' ||
      (setupExperienceMode !== 'standard' && (view === 'quick-setup' || view === 'setup'))
    ) {
      window.scrollTo(0, 0);
    }
  }, [setupExperienceMode, view]);

  // NOTE: 生成通知のクリック時遷移。対象作品が既に削除されている場合は一覧へ戻し、
  // 理由を短く表示する（設計書 12.1）。
  useEffect(() => {
    return notificationCenter.registerClickHandler((target) => {
      if (target.kind === 'setup') {
        setSetupSessionEntry('resume');
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
            setProjectMainView(
              project.experienceMode === 'dream'
                ? 'dream'
                : projectType === 'roleplay'
                  ? 'roleplay'
                  : 'read'
            );
            setView('settings-work');
          } else {
            openProjectByType(projectId, projectType, project.experienceMode);
          }
        })
        .catch(() => {
          setListNotice('通知の対象は見つかりませんでした。作品が削除された可能性があります。');
          setActiveProjectId(null);
          setView('list');
        });
    });
  }, [notificationCenter.registerClickHandler]);

  return (
    <div className="app">
      {/* NOTE: 1画面の描画エラーでアプリ全体が白画面にならないようにする。フォールバックの
          「一覧に戻る」は境界の外にある handleBackToList を呼ぶので、崩れた画面からも脱出できる。 */}
      <ErrorBoundary onReset={handleBackToList} resetLabel="一覧に戻る">
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
              setSetupExperienceMode('standard');
              setSetupSessionEntry('fresh');
              setView('setup');
            }}
            onSetupRoleplay={() => {
              setSetupPurpose('roleplay');
              setSetupExperienceMode('standard');
              setSetupSessionEntry('fresh');
              setView('setup');
            }}
            onQuickSetupNovel={() => {
              setSetupPurpose('novel');
              setSetupExperienceMode('standard');
              setView('quick-setup');
            }}
            onQuickSetupRoleplay={() => {
              setSetupPurpose('roleplay');
              setSetupExperienceMode('standard');
              setView('quick-setup');
            }}
            onQuickSetupDream={() => {
              setSetupPurpose('roleplay');
              setSetupExperienceMode('dream');
              setView('quick-setup');
            }}
            onAmplifierStart={() => {
              setView('amplifier-entry');
            }}
            onOpenAppSettings={() => openAppSettings('list')}
          />
        </>
      )}
      {view === 'new' && <ProjectForm onCreated={handleCreateProject} onCancel={handleBackToList} />}
      {view === 'amplifier-entry' && (
        <AmplifierEntry
          onChoose={(purpose) => {
            setSetupPurpose(purpose);
            setSetupExperienceMode('amplifier');
            setView('quick-setup');
          }}
          onOpenFullSetup={(purpose) => {
            setSetupPurpose(purpose);
            setSetupExperienceMode('amplifier');
            setSetupSessionEntry('fresh');
            setView('setup');
          }}
          onCancel={handleBackToList}
        />
      )}
      {view === 'setup' && (
        // NOTE: SetupWorkspace は購読中セッションを purpose 別に一度だけ読み込む。key を
        // 付けて用途が変わったら必ず作り直し、小説の相談状態が残ったまま roleplay 表示に
        // なる事故を防ぐ。
        <SetupWorkspace
          key={`${setupPurpose}:${setupExperienceMode}:${setupSessionEntry}`}
          purpose={setupPurpose}
          experienceMode={setupExperienceMode}
          resumeExistingSession={setupSessionEntry === 'resume'}
          onCreated={handleCreateProject}
          onCancel={handleBackToList}
          onOpenSettings={() => openAppSettings('setup')}
        />
      )}
      {view === 'quick-setup' && (
        <QuickSetupWorkspace
          purpose={setupPurpose}
          experienceMode={setupExperienceMode}
          onCreated={handleCreateProject}
          onCancel={handleBackToList}
          onOpenFullSetup={(hasCurrentSession) => {
            setSetupSessionEntry(hasCurrentSession ? 'resume' : 'fresh');
            setView('setup');
          }}
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
      {view === 'dream' && activeProjectId && (
        <DreamWorkspace
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
      </ErrorBoundary>
    </div>
  );
}
