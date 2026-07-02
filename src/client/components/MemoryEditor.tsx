import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { Memory } from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
}

const typeLabels: Record<Memory['type'], string> = {
  storyFact: '物語の事実',
  preference: '好み',
  negative: 'NG',
};

export default function MemoryEditor({ projectId, onBack }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [type, setType] = useState<Memory['type']>('storyFact');
  const [content, setContent] = useState('');
  const [importance, setImportance] = useState<Memory['importance']>('high');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const data = await api.getMemories(projectId);
      setMemories(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    load();
  }, [projectId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);
      await api.createMemory(projectId, { type, content, importance });
      setContent('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '追加に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(memoryId: string) {
    if (!window.confirm('この記憶を削除しますか？')) return;
    try {
      setLoading(true);
      await api.deleteMemory(projectId, memoryId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="memory-editor">
      <header className="reader-header">
        <button onClick={onBack}>← 戻る</button>
        <h1>記憶の管理</h1>
      </header>

      {error && <div className="error-toast">{error}</div>}

      <form className="memory-form" onSubmit={handleSubmit}>
        <label>
          種類
          <select value={type} onChange={(e) => setType(e.target.value as Memory['type'])}>
            <option value="storyFact">物語の事実</option>
            <option value="preference">好み</option>
            <option value="negative">NG</option>
          </select>
        </label>
        <label>
          重要度
          <select
            value={importance}
            onChange={(e) => setImportance(e.target.value as Memory['importance'])}
          >
            <option value="high">高（常に参照）</option>
            <option value="medium">中</option>
            <option value="low">低</option>
          </select>
        </label>
        <label>
          内容
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="例: 主人公はまだ本心を話していない"
            required
          />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          追加
        </button>
      </form>

      <ul className="memory-list">
        {memories.map((m) => (
          <li key={m.memoryId} className="memory-item">
            <p>{m.content}</p>
            <div className="meta">
              {typeLabels[m.type]} / 重要度: {m.importance} / {new Date(m.createdAt).toLocaleString('ja-JP')}
              <button className="danger" onClick={() => handleDelete(m.memoryId)}>削除</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
