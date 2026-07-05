import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import type {
  Character,
  RefineMessage,
  RefinePatch,
  RefinePatchOperation,
  RefinePatchStatus,
  RefineSession,
} from '@shared/types';

interface Props {
  projectId: string;
  characters: Character[];
  onSettingsChanged: () => void;
}

export default function RefineChatPanel({ projectId, characters, onSettingsChanged }: Props) {
  const [session, setSession] = useState<RefineSession | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [busyPatchId, setBusyPatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const s = await api.getRefineSession(projectId);
        if (!cancelled) setSession(s);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'セッション取得に失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    // NOTE: メッセージが増えたら末尾へ自動スクロール。
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session?.messages.length, session?.patches.length]);

  async function handleSend() {
    const content = input.trim();
    if (!content || sending || busyPatchId) return;
    try {
      setSending(true);
      setError(null);
      const result = await api.sendRefineMessage(projectId, content);
      setSession(result.session);
      setInput('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました');
    } finally {
      setSending(false);
    }
  }

  async function reloadSessionQuietly() {
    try {
      const s = await api.getRefineSession(projectId);
      setSession(s);
    } catch {
      // NOTE: 元の操作エラーを UI に残すため、同期失敗はここでは握りつぶす。
    }
  }

  async function handleApply(patchId: string) {
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.applyRefinePatch(projectId, patchId);
      setSession(result.session);
      onSettingsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パッチ反映に失敗しました');
      await reloadSessionQuietly();
    } finally {
      setBusyPatchId(null);
    }
  }

  async function handleReject(patchId: string) {
    try {
      setBusyPatchId(patchId);
      setError(null);
      const result = await api.rejectRefinePatch(projectId, patchId);
      setSession(result.session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'パッチ却下に失敗しました');
      await reloadSessionQuietly();
    } finally {
      setBusyPatchId(null);
    }
  }

  async function handleReset() {
    if (busyPatchId) return;
    if (!window.confirm('相談の履歴をリセットしますか？（適用済みの変更はそのまま残ります）'))
      return;
    try {
      setSending(true);
      setError(null);
      const s = await api.resetRefineSession(projectId);
      setSession(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'リセットに失敗しました');
    } finally {
      setSending(false);
    }
  }

  const patchesByMessageId = new Map<string, RefinePatch[]>();
  if (session) {
    for (const patch of session.patches) {
      const list = patchesByMessageId.get(patch.sourceMessageId) ?? [];
      list.push(patch);
      patchesByMessageId.set(patch.sourceMessageId, list);
    }
  }

  if (loading) return <div className="loading">相談セッションを読み込んでいます…</div>;

  const patchActionDisabled = sending || busyPatchId !== null;

  return (
    <section className="summary-card refine-chat-card">
      <header className="summary-card-header">
        <h2>AI と相談して編集</h2>
        <div className="summary-card-badges">
          <span className="settings-meta">
            世界設定・人物設定について対話で修正できます
          </span>
          <button
            onClick={handleReset}
            disabled={sending || busyPatchId !== null || !session?.messages.length}
          >
            履歴をリセット
          </button>
        </div>
      </header>

      {error && <div className="refine-scan-error">{error}</div>}

      <div className="refine-chat-messages" ref={scrollRef}>
        {(!session || session.messages.length === 0) && (
          <p className="summary-empty">
            例：「望月の年齢を28歳に設定して」「世界設定に長崎の描写を追加したい」など、
            変えたい・足したい点を話しかけてください。
          </p>
        )}
        {session?.messages.map((msg) => (
          <div key={msg.messageId}>
            <ChatBubble message={msg} />
            {(patchesByMessageId.get(msg.messageId) ?? []).map((patch) => (
              <PatchCard
                key={patch.patchId}
                patch={patch}
                characters={characters}
                busy={busyPatchId === patch.patchId}
                disabled={patchActionDisabled}
                onApply={() => handleApply(patch.patchId)}
                onReject={() => handleReject(patch.patchId)}
              />
            ))}
          </div>
        ))}
      </div>

      <form
        className="refine-chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="世界設定や人物設定について、変えたい点や足したい点を書いてください"
          rows={3}
          disabled={sending || busyPatchId !== null}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={sending || busyPatchId !== null || !input.trim()}
        >
          {sending ? '送信中…' : '送る'}
        </button>
      </form>
      <p className="refine-chat-hint">Ctrl/Cmd+Enter でも送信できます。</p>
    </section>
  );
}

function ChatBubble({ message }: { message: RefineMessage }) {
  return (
    <article className={`refine-chat-bubble role-${message.role}`}>
      <div className="refine-chat-role">
        {message.role === 'user' ? 'あなた' : 'アシスタント'}
      </div>
      <p className="refine-chat-content">{message.content}</p>
    </article>
  );
}

function PatchCard({
  patch,
  characters,
  busy,
  disabled,
  onApply,
  onReject,
}: {
  patch: RefinePatch;
  characters: Character[];
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  const isActionable = patch.status === 'pending';
  return (
    <div className={`refine-patch-card status-${patch.status}`}>
      <div className="refine-patch-header">
        <span className={`refine-patch-status status-${patch.status}`}>
          {statusLabel(patch.status)}
        </span>
        <span className="refine-patch-summary">{patch.summary}</span>
      </div>
      <ul className="refine-patch-ops">
        {patch.operations.map((op, idx) => (
          <li key={idx}>
            <PatchOpView op={op} characters={characters} />
          </li>
        ))}
      </ul>
      {patch.applyError && (
        <div className="refine-patch-error">反映失敗: {patch.applyError}</div>
      )}
      {isActionable && (
        <div className="refine-patch-actions">
          <button onClick={onReject} disabled={disabled}>
            却下
          </button>
          <button className="primary" onClick={onApply} disabled={disabled}>
            {busy ? '反映中…' : '反映する'}
          </button>
        </div>
      )}
    </div>
  );
}

function PatchOpView({
  op,
  characters,
}: {
  op: RefinePatchOperation;
  characters: Character[];
}) {
  switch (op.kind) {
    case 'world-replace':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 置換</div>
          <div className="refine-patch-old">- {op.op.anchor}</div>
          <div className="refine-patch-new">+ {op.op.replacement}</div>
        </div>
      );
    case 'world-append':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">世界: 追記</div>
          <div className="refine-patch-new">+ {op.op.text}</div>
        </div>
      );
    case 'character-update': {
      const character = characters.find((c) => c.characterId === op.characterId);
      const fields = Object.entries(op.fields);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">
            人物: 更新（{character?.name ?? op.characterId}）
          </div>
          {fields.map(([key, value]) => (
            <div key={key} className="refine-patch-field">
              <span className="refine-patch-field-key">{key}</span>
              <div className="refine-patch-old">
                - {formatCharacterFieldValue(character, key)}
              </div>
              <div className="refine-patch-new">+ {String(value ?? '')}</div>
            </div>
          ))}
        </div>
      );
    }
    case 'character-add':
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 追加</div>
          <div className="refine-patch-new">
            + {op.character.name}（{op.character.role}）
          </div>
          {op.character.description && (
            <div className="refine-patch-new"> {op.character.description}</div>
          )}
        </div>
      );
    case 'character-remove': {
      const character = characters.find((c) => c.characterId === op.characterId);
      return (
        <div className="refine-patch-diff">
          <div className="refine-patch-label">人物: 削除</div>
          <div className="refine-patch-old">
            - {character?.name ?? op.characterId}
          </div>
        </div>
      );
    }
  }
}

function statusLabel(status: RefinePatchStatus): string {
  switch (status) {
    case 'pending':
      return '要判断';
    case 'applied':
      return '反映済み';
    case 'rejected':
      return '却下';
    case 'stale':
      return '古い提案';
  }
}

function formatCharacterFieldValue(
  character: Character | undefined,
  key: string
): string {
  if (!character) return '（該当なし）';
  const value = (character as unknown as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.trim() || '（未記入）';
  return '（未記入）';
}
