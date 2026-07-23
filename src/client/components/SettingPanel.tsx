import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { Project, SettingsFocusTarget } from '@shared/types';
import WorkSettingsTab from './WorkSettingsTab';
import TechSettingsTab from './TechSettingsTab';
import MemoryEditor from './MemoryEditor';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenAppSettings: (provider?: string) => void;
  initialTab?: Tab;
  // NOTE: 通知クリックで作品設定相談の該当履歴へ飛ぶための遷移先。設定されている間は
  // work タブを強制する（refine-history は work タブにしか存在しないため）。
  focusTarget?: SettingsFocusTarget | null;
  onFocusTargetConsumed?: () => void;
}

// NOTE: 作品ページ内から開いた場合の設定。プリセット再選択 UI は出さず、
// 「作品設定（世界・人物・システムプロンプト）」と「生成設定（作品ごとのモデル・
// サンプリング・NG 表現）」と「記憶」の 3 タブに分ける。
type Tab = 'work' | 'tech' | 'memory';

export default function SettingPanel({
  projectId,
  onBack,
  onOpenAppSettings,
  initialTab,
  focusTarget,
  onFocusTargetConsumed,
}: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>(focusTarget ? 'work' : initialTab ?? 'work');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const navigationLocked = false;

  useEffect(() => {
    if (focusTarget) setTab('work');
  }, [focusTarget]);

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
    window.setTimeout(() => setMessage(null), 5000);
  }

  function showError(text: string | null) {
    setError(text);
  }

  if (!project && !error) return <div className="loading">読み込み中…</div>;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack} disabled={navigationLocked}>← 戻る</button>
        <h1>作品設定{project ? `: ${project.title}` : ''}</h1>
      </header>

      <nav className="settings-tabs" role="tablist" aria-label="設定タブ">
        <button
          role="tab"
          aria-selected={tab === 'work'}
          className={tab === 'work' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('work')}
          disabled={navigationLocked}
        >
          作品設定
        </button>
        <button
          role="tab"
          aria-selected={tab === 'memory'}
          className={tab === 'memory' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('memory')}
          disabled={navigationLocked}
        >
          記憶
        </button>
        <button
          role="tab"
          aria-selected={tab === 'tech'}
          className={tab === 'tech' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setTab('tech')}
          disabled={navigationLocked}
        >
          生成設定
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
          onProjectUpdated={setProject}
          focusTarget={focusTarget}
          onFocusTargetConsumed={onFocusTargetConsumed}
        />
      )}
      {project && tab === 'tech' && (
        <TechSettingsTab
          projectId={projectId}
          project={project}
          onProjectUpdated={setProject}
          onError={showError}
          onFlashMessage={flashMessage}
          onOpenAppSettings={onOpenAppSettings}
        />
      )}
      {project && tab === 'memory' && <MemoryEditor projectId={projectId} />}
    </div>
  );
}
