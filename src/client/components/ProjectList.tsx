import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { ProjectSummary } from '@shared/types';

interface Props {
  onOpen: (projectId: string) => void;
  onNew: () => void;
}

export default function ProjectList({ onOpen, onNew }: Props) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      setError(null);
      const data = await api.listProjects();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleDuplicate(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    try {
      await api.duplicateProject(projectId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '複製に失敗しました');
    }
  }

  async function handleDelete(e: React.MouseEvent, projectId: string) {
    e.stopPropagation();
    if (!window.confirm('この作品を削除しますか？')) return;
    try {
      await api.deleteProject(projectId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    }
  }

  return (
    <div className="project-list">
      <header className="project-list-header">
        <h1>Yumeweaving</h1>
        <button className="primary" onClick={onNew}>新規作品</button>
      </header>

      {error && <div className="error-toast">{error}</div>}

      {loading ? (
        <div className="loading">読み込み中…</div>
      ) : projects.length === 0 ? (
        <div className="empty">
          <p>作品がありません。新規作品から始めてください。</p>
          <button className="primary" onClick={onNew}>新規作品を作る</button>
        </div>
      ) : (
        <ul className="project-cards">
          {projects.map((p) => (
            <li key={p.projectId} className="project-card" onClick={() => onOpen(p.projectId)}>
              <div className="project-card-main">
                <h2>{p.title}</h2>
                <p className="excerpt">{p.lastExcerpt || 'まだ本文がありません'}</p>
                <p className="meta">
                  最終更新: {new Date(p.updatedAt).toLocaleString('ja-JP')}
                </p>
              </div>
              <div className="project-card-actions">
                <button
                  onClick={(e) => handleDuplicate(e, p.projectId)}
                  title="複製"
                >
                  複製
                </button>
                <button
                  className="danger"
                  onClick={(e) => handleDelete(e, p.projectId)}
                  title="削除"
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
