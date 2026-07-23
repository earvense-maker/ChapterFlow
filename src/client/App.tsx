import { useEffect, useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';
import AppSettingsPanel from './components/AppSettingsPanel';
import RoleplayWorkspace from './components/RoleplayWorkspace';
import { useNotificationCenter } from './components/NotificationCenter';
import { api } from './clientApi';
import type { ProjectType, SettingsFocusTarget, SetupPurpose } from '@shared/types';

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
