import { useState } from 'react';
import ProjectList from './components/ProjectList';
import ProjectForm from './components/ProjectForm';
import Reader from './components/Reader';
import MemoryEditor from './components/MemoryEditor';
import SettingPanel from './components/SettingPanel';
import SetupWorkspace from './components/SetupWorkspace';

type View = 'list' | 'new' | 'setup' | 'read' | 'settings' | 'memories';

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
      {view === 'setup' && <SetupWorkspace onCreated={handleCreateProject} onCancel={handleBackToList} />}
      {view === 'read' && activeProjectId && (
        <Reader
          projectId={activeProjectId}
          onBack={handleBackToList}
          onOpenSettings={() => setView('settings')}
          onOpenMemories={() => setView('memories')}
        />
      )}
      {view === 'settings' && activeProjectId && (
        <SettingPanel projectId={activeProjectId} onBack={() => setView('read')} />
      )}
      {view === 'memories' && activeProjectId && (
        <MemoryEditor projectId={activeProjectId} onBack={() => setView('read')} />
      )}
    </div>
  );
}
