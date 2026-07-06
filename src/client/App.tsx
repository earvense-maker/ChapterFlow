import { useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';

type View = 'list' | 'new' | 'setup' | 'read' | 'settings-work' | 'settings-app' | 'settings-memory';

export default function App() {
  const [view, setView] = useState<View>('list');
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

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
    view === 'settings-app' ? 'tech' :
    view === 'settings-memory' ? 'memory' : undefined;

  return (
    <div className="app">
      {view === 'list' && (
        <ProjectList
          onOpen={handleOpenProject}
          onNew={() => setView('new')}
          onSetupNew={() => setView('setup')}
        />
      )}
      {view === 'new' && <ProjectForm onCreated={handleCreateProject} onCancel={handleBackToList} />}
      {view === 'setup' && (
        <SetupWorkspace
          onCreated={handleCreateProject}
          onCancel={handleBackToList}
          onOpenSettings={() => setView('settings-app')}
        />
      )}
      {view === 'read' && activeProjectId && (
        <Reader
          projectId={activeProjectId}
          onBack={handleBackToList}
          onOpenWorkSettings={() => setView('settings-work')}
          onOpenAppSettings={() => setView('settings-app')}
          onOpenMemories={() => setView('settings-memory')}
        />
      )}
      {(view === 'settings-work' || view === 'settings-app' || view === 'settings-memory') &&
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
