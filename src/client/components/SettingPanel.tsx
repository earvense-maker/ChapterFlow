import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { Project } from '@shared/types';
import WorkSettingsTab from './WorkSettingsTab';
import TechSettingsTab from './TechSettingsTab';
import MemoryEditor from './MemoryEditor';

interface Props {
  projectId: string;
  onBack: () => void;
  initialTab?: Tab;
}

// NOTE: 作品ページ内から開いた場合の設定。プリセット再選択 UI は出さず、
// 「作品設定（世界・人物・システムプロンプト）」と「技術設定（モデル・
// サンプリング・NG 表現・APIキー）」と「記憶」の 3 タブに分ける。
type Tab = 'work' | 'tech' | 'memory';

export default function SettingPanel({ projectId, onBack, initialTab }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'work');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getProject(projectId)
      .then((data) => {
        if (!cancelled) setProject(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込みに失敗しました');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function flashMessage(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 2000);
  }

  function showError(text: string | null) {
    setError(text);
  }

  if (!project && !error) return <div className="loading">読み込み中…</div>;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack}>← 戻る</button>
        <h1>作品設定{project ? `: ${project.title}` : ''}</h1>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="設定タブ">
        <button
          role="tab"
          aria-selected={tab === 'work'}
          className={tab === 'work' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('work')}
        >
          📖 作品設定
        </button>
        <button
          role="tab"
          aria-selected={tab === 'memory'}
          className={tab === 'memory' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('memory')}
        >
          🧠 記憶
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tech'}
          className={tab === 'tech' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('tech')}
        >
          ⚙ 技術設定
        </button>
      </nav>

      {error && <div className="error-toast">{error}</div>}
      {message && <div className="status-bar">{message}</div>}

      {project && tab === 'work' && (
        <WorkSettingsTab
          projectId={projectId}
          project={project}
          onError={showError}
          onFlashMessage={flashMessage}
        />
      )}
      {project && tab === 'tech' && (
        <TechSettingsTab
          projectId={projectId}
          project={project}
          onProjectUpdated={setProject}
          onError={showError}
          onFlashMessage={flashMessage}
        />
      )}
      {project && tab === 'memory' && <MemoryEditor projectId={projectId} />}
    </div>
  );
}
