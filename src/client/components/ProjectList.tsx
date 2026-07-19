import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import type { ProjectSummary, ProjectType } from '@shared/types';

interface Props {
  onOpen: (projectId: string, projectType: ProjectType) => void;
  onNew: () => void;
  onSetupNew: () => void;
  onSetupRoleplay: () => void;
  onOpenAppSettings: () => void;
}

export default function ProjectList({
  onOpen,
  onNew,
  onSetupNew,
  onSetupRoleplay,
  onOpenAppSettings,
}: Props) {
  const confirmAction = useConfirm();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    // NOTE: 開発モードで tsx watch や Vite プロキシが再起動直後に 500 を返す瞬間があり、
    // 一度だけ短い遅延を挟んで再取得することで、初回起動時のフラッシュを防ぐ。
    try {
      setLoading(true);
      setError(null);
      const data = await fetchProjectsWithRetry();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function fetchProjectsWithRetry() {
    try {
      return await api.listProjects();
    } catch (firstErr) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        return await api.listProjects();
      } catch {
        throw firstErr;
      }
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
    if (!(await confirmAction('この作品を削除しますか？', { confirmLabel: '削除', danger: true }))) {
      return;
    }
    try {
      await api.deleteProject(projectId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    }
  }

  async function handleShutdown() {
    if (
      !(await confirmAction(
        'ChapterFlow を終了しますか？サーバーとターミナルも一緒に閉じます。',
        { confirmLabel: '終了', danger: true }
      ))
    ) return;
    try {
      await api.shutdown();
    } catch {
      // サーバー側は即座に応答して自プロセスを落とすため、ネットワーク断で
      // request が例外になっても正常系。無視してウィンドウを閉じる。
    }
    // NOTE: --app モードで開いたウィンドウは window.close() で閉じる。
    // 通常タブ (script で開いていない) では閉じないブラウザもあるので、
    // 閉じられなかった場合の表示だけ残す。
    setTimeout(() => {
      window.close();
      setError('サーバーを停止しました。このウィンドウを閉じてください。');
    }, 300);
  }

  return (
    <div className="project-list">
      <header className="project-list-header">
        <div>
          <h1>ChapterFlow</h1>
          <p className="product-tagline">API-Powered Narrative Studio</p>
        </div>
        <div className="project-list-actions">
          <button className="primary" onClick={onSetupNew}>相談して作る</button>
          <button className="primary" onClick={onSetupRoleplay}>
            キャラと話す作品を作る
          </button>
          <button onClick={onNew}>設定を直接入力</button>
          <button onClick={onOpenAppSettings}>アプリ設定</button>
          <button className="danger" onClick={handleShutdown} title="サーバーとターミナルも終了">
            終了
          </button>
        </div>
      </header>

      {error && <div className="error-toast">{error}</div>}

      {loading ? (
        <div className="loading">読み込み中…</div>
      ) : projects.length === 0 ? (
        <div className="empty">
          <p>まずは相談しながら物語を作るか、設定を直接入力して始めましょう。</p>
          <div className="project-list-actions center">
            <button className="primary" onClick={onSetupNew}>相談して作る</button>
            <button className="primary" onClick={onSetupRoleplay}>
              キャラと話す作品を作る
            </button>
            <button onClick={onNew}>設定を直接入力して作る</button>
          </div>
        </div>
      ) : (
        <ul className="project-cards">
          {projects.map((p) => (
            <li
              key={p.projectId}
              className="project-card"
              onClick={() => onOpen(p.projectId, p.projectType)}
            >
              <div className="project-card-main">
                <h2>
                  {p.title}
                  {p.projectType === 'roleplay' && (
                    <span
                      className="project-type-badge project-type-badge--roleplay"
                      title="ロールプレイ型プロジェクト"
                      style={{
                        marginLeft: '0.5rem',
                        padding: '0.1rem 0.5rem',
                        fontSize: '0.7rem',
                        borderRadius: '999px',
                        background: 'var(--accent-soft, #d9e6ff)',
                        color: 'var(--accent-strong, #2952a3)',
                        fontWeight: 500,
                      }}
                    >
                      ロールプレイ
                    </span>
                  )}
                </h2>
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
