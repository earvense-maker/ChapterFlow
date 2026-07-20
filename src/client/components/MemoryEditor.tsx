import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import { MEMORY_CONTENT_MAX_CHARS, type Memory } from '@shared/types';

interface Props {
  projectId: string;
  // NOTE: onBack が undefined のときは埋め込み表示(独立画面ではなくタブ内)。
  // ヘッダーを描画しない。
  onBack?: () => void;
}

const typeLabels: Record<Memory['type'], string> = {
  storyFact: '物語の事実',
  preference: '好み',
  negative: 'NG',
};

export default function MemoryEditor({ projectId, onBack }: Props) {
  const confirmAction = useConfirm();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [type, setType] = useState<Memory['type']>('storyFact');
  const [content, setContent] = useState('');
  const [importance, setImportance] = useState<Memory['importance']>('high');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const projectIdRef = useRef(projectId);
  const loadRequestRef = useRef(0);
  const mutationRef = useRef(false);

  async function load(targetProjectId = projectId) {
    const requestId = ++loadRequestRef.current;
    try {
      setError(null);
      const data = await api.getMemories(targetProjectId);
      if (
        !mountedRef.current ||
        projectIdRef.current !== targetProjectId ||
        loadRequestRef.current !== requestId
      ) return;
      setMemories(data);
    } catch (err) {
      if (
        !mountedRef.current ||
        projectIdRef.current !== targetProjectId ||
        loadRequestRef.current !== requestId
      ) return;
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    projectIdRef.current = projectId;
    setMemories([]);
    void load(projectId);
    return () => {
      loadRequestRef.current += 1;
    };
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mutationRef.current) return;
    const targetProjectId = projectId;
    mutationRef.current = true;
    try {
      setLoading(true);
      setError(null);
      await api.createMemory(targetProjectId, { type, content, importance });
      if (!mountedRef.current || projectIdRef.current !== targetProjectId) return;
      setContent('');
      await load(targetProjectId);
    } catch (err) {
      if (!mountedRef.current || projectIdRef.current !== targetProjectId) return;
      setError(err instanceof Error ? err.message : '追加に失敗しました');
    } finally {
      mutationRef.current = false;
      if (mountedRef.current && projectIdRef.current === targetProjectId) setLoading(false);
    }
  }

  async function handleDelete(memoryId: string) {
    if (!(await confirmAction('この記憶を削除しますか？', { confirmLabel: '削除', danger: true }))) {
      return;
    }
    if (mutationRef.current) return;
    const targetProjectId = projectId;
    mutationRef.current = true;
    try {
      setLoading(true);
      await api.deleteMemory(targetProjectId, memoryId);
      if (!mountedRef.current || projectIdRef.current !== targetProjectId) return;
      await load(targetProjectId);
    } catch (err) {
      if (!mountedRef.current || projectIdRef.current !== targetProjectId) return;
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      mutationRef.current = false;
      if (mountedRef.current && projectIdRef.current === targetProjectId) setLoading(false);
    }
  }

  return (
    <div className="memory-editor">
      {onBack && (
        <header className="reader-header">
          <button onClick={onBack}>← 戻る</button>
          <h1>記憶の管理</h1>
        </header>
      )}

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
            maxLength={MEMORY_CONTENT_MAX_CHARS}
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
