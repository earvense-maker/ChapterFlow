import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import type { GenerationRecord, Project } from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenSettings: () => void;
  onOpenMemories: () => void;
}

export default function Reader({ projectId, onBack, onOpenSettings, onOpenMemories }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [text, setText] = useState('');
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [status, setStatus] = useState<GenerationRecord['status'] | null>(null);
  const [wish, setWish] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(18);
  const inputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const state = await api.getReaderState(projectId);
      setProject(state.project);
      setFontSize(state.state.uiState.fontSize);
      if (state.currentGeneration) {
        setText(state.currentGeneration.responseText);
        setGenerationId(state.currentGeneration.generationId);
        setStatus(state.currentGeneration.status);
      } else {
        setText('');
        setGenerationId(null);
        setStatus(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    load();
  }, [projectId]);

  async function handleGenerate(mode: 'continue' | 'regenerate' | 'variate') {
    try {
      setLoading(true);
      setError(null);
      const shouldStream = project?.streamingEnabled ?? false;
      setGenerationId(null);
      setStatus(null);

      const record = shouldStream
        ? await api.generateStream(projectId, { wish, mode }, (() => {
            let streamedText = '';
            setText('');
            return (chunk: string) => {
              streamedText += chunk;
              setText(streamedText);
            };
          })())
        : await api.generate(projectId, { wish, mode });

      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
      setWish('');
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleAccept() {
    if (!generationId) return;
    try {
      setLoading(true);
      setError(null);
      await api.acceptGeneration(projectId, generationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '採用に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleReject() {
    if (!generationId) return;
    try {
      setLoading(true);
      setError(null);
      await api.rejectGeneration(projectId, generationId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '破棄に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevert() {
    try {
      setLoading(true);
      setError(null);
      const record = await api.revertGeneration(projectId);
      setText(record.responseText);
      setGenerationId(record.generationId);
      setStatus(record.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : '復帰に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function adjustFontSize(delta: number) {
    const next = Math.max(12, Math.min(32, fontSize + delta));
    setFontSize(next);
    try {
      await api.updateState(projectId, { uiState: { readingPosition: 0, fontSize: next } });
    } catch {
      // 状態保存失敗は無視して、画面上のサイズは保持
    }
  }

  const isDraft = status === 'draft';
  const hasText = text.length > 0;

  return (
    <div className="reader">
      <header className="reader-header">
        <button onClick={onBack}>← 一覧</button>
        <h1>{project?.title || '読み込み中…'}</h1>
        <div className="reader-header-actions">
          <button onClick={() => adjustFontSize(-1)} title="文字を小さく">A-</button>
          <button onClick={() => adjustFontSize(1)} title="文字を大きく">A+</button>
          <button onClick={onOpenMemories}>記憶</button>
          <button onClick={onOpenSettings}>設定</button>
        </div>
      </header>

      <main className="reader-body">
        {error && <div className="error-toast">{error}</div>}
        {hasText ? (
          <article className="reader-text" style={{ fontSize: `${fontSize}px` }}>
            {text}
          </article>
        ) : (
          <div className="reader-empty">
            <p>まだ本文がありません。下の欄に短い希望を入れて、続きを生成してください。</p>
          </div>
        )}
      </main>

      <footer className="reader-controls">
        <form
          className="wish-input"
          onSubmit={(e) => {
            e.preventDefault();
            handleGenerate('continue');
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            placeholder="もっと不穏に、会話多めで、まだ告白しない…"
            disabled={loading}
          />
          <button type="submit" className="primary" disabled={loading}>
            {loading ? '生成中…' : hasText ? '続きを生成' : '最初の場面を生成'}
          </button>
        </form>

        <div className="generation-actions">
          {hasText && (
            <>
              <button onClick={() => handleGenerate('regenerate')} disabled={loading}>
                書き直す
              </button>
              <button onClick={() => handleGenerate('variate')} disabled={loading}>
                少し変える
              </button>
              <button onClick={handleRevert} disabled={loading}>
                前の案に戻す
              </button>
              {generationId && (
                <a
                  className="button-link"
                  href={api.generationMarkdownUrl(projectId, generationId)}
                  download
                >
                  MDを保存
                </a>
              )}
              {isDraft && (
                <>
                  <button className="primary" onClick={handleAccept} disabled={loading}>
                    この案を採用
                  </button>
                  <button className="danger" onClick={handleReject} disabled={loading}>
                    破棄
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="status-bar">
          {loading && (project?.streamingEnabled ?? false) && 'ストリーミング生成中です'}
          {status === 'draft' && 'この案は下書きです'}
          {status === 'accepted' && 'この場面は採用済みです'}
        </div>
      </footer>
    </div>
  );
}
