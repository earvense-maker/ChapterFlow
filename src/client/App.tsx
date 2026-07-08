import { useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';
import AppSettingsPanel from './components/AppSettingsPanel';

type View = 'list' | 'new' | 'setup' | 'read' | 'app-settings' | 'settings-work' | 'settings-memory';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [appSettingsBackView, setAppSettingsBackView] = useState<View>('list');

  const handleOpenProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setView('read');
  };

  const handleCreateProject = (projectId: string) => {
    setActiveProjectId(projectId);
    setView('read');
  };

  const handleBackToList = () => {
    setActiveProjectId(null);
    setView('list');
  };

  // NOTE: 記憶は SettingPanel の1タブに統合済み。旧 memories ビューは廃止し、
  // メニューから「作品設定」「アプリ設定」「記憶(=作品設定の記憶タブ)」へ遷移する。
  const settingsInitialTab =
    view === 'settings-work' ? 'work' :
    view === 'settings-memory' ? 'memory' : undefined;

  const openAppSettings = (backView: View) => {
    setAppSettingsBackView(backView);
    setView('app-settings');
  };

  return (
    <div className="app">
      {view === 'list' && (
        <ProjectList
          onOpen={handleOpenProject}
          onNew={() => setView('new')}
          onSetupNew={() => setView('setup')}
          onOpenAppSettings={() => openAppSettings('list')}
        />
      )}
      {view === 'new' && <ProjectForm onCreated={handleCreateProject} onCancel={handleBackToList} />}
      {view === 'setup' && (
        <SetupWorkspace
          onCreated={handleCreateProject}
          onCancel={handleBackToList}
          onOpenSettings={() => openAppSettings('setup')}
        />
      )}
      {view === 'read' && activeProjectId && (
        <Reader
          projectId={activeProjectId}
          onBack={handleBackToList}
          onOpenWorkSettings={() => setView('settings-work')}
          onOpenAppSettings={() => openAppSettings('read')}
          onOpenMemories={() => setView('settings-memory')}
        />
      )}
      {view === 'app-settings' && (
        <AppSettingsPanel onBack={() => setView(appSettingsBackView)} />
      )}
      {(view === 'settings-work' || view === 'settings-memory') &&
        activeProjectId && (
          <SettingPanel
            projectId={activeProjectId}
            onBack={() => setView('read')}
            initialTab={settingsInitialTab}
          />
        )}
    </div>
  );
}
