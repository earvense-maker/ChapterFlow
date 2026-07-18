// NOTE: ロールプレイ型プロジェクトの主画面（設計書 4.1）。
//
// レイアウト:
//  - 左: セッション一覧 + 新規会話ボタン
//  - 右: キャラ名・シナリオ・チャット吹き出し・入力欄・停止/再生成
//
// SSE の暫定表示:
//  - 生成中は生成中の吹き出しに streamingText を表示。
//  - done 受信時に返却 session.messages で置換する。
//  - error/停止時は暫定表示を破棄して GET で再同期する（409復旧）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type RoleplayStreamHandlers } from '../clientApi';
import type {
  Character,
  Project,
  RoleplaySessionSummary,
  RoleplaySessionView,
} from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenWorkSettings: () => void;
  onOpenTechSettings: () => void;
}

interface StartConversationInput {
  characterId: string;
  scenario?: string;
}

export default function RoleplayWorkspace({
  projectId,
  onBack,
  onOpenWorkSettings,
  onOpenTechSettings,
}: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [sessions, setSessions] = useState<RoleplaySessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<RoleplaySessionView | null>(null);
  const [message, setMessage] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isRegenerate, setIsRegenerate] = useState(false);
  const [pendingReplaceMessageId, setPendingReplaceMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewModal, setShowNewModal] = useState(false);
  // NOTE: キャラ発言の選択→NG登録。Reader.tsx と同型の UX で、
  // 1〜30 字だけをフローティングボタンの対象にする（本編と同じ制約）。
  const [selectedText, setSelectedText] = useState('');
  const [selectionButtonPosition, setSelectionButtonPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sentMessageRef = useRef('');
  const stopRequestedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [proj, chars, sessionsRes] = await Promise.all([
        api.getProject(projectId),
        api.getCharacters(projectId),
        api.listRoleplaySessions(projectId),
      ]);
      setProject(proj);
      setCharacters(chars);
      setSessions(sessionsRes.sessions);
      if (sessionsRes.sessions.length > 0) {
        const first = sessionsRes.sessions[0];
        const view = await api.getRoleplaySession(projectId, first.sessionId);
        setActiveSession(view.session);
        setPendingReplaceMessageId(null);
      } else if (chars.length > 0) {
        // NOTE: セッションが1つも無ければ、モーダルを自動で開いて開始を促す。
        setShowNewModal(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  useEffect(() => {
    if (autoScrollRef.current && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [activeSession?.messages.length, streamingText]);

  const currentCharacterName = activeSession?.characterName ?? '';

  const resetStreamState = useCallback(() => {
    setStreamingText('');
    setIsStreaming(false);
    setIsStopping(false);
    setIsRegenerate(false);
    abortRef.current = null;
    stopRequestedRef.current = false;
    sentMessageRef.current = '';
  }, []);

  const showStopNotice = useCallback((text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(null), 2500);
  }, []);

  const handleStartConversation = useCallback(
    async (input: StartConversationInput) => {
      setError(null);
      setShowNewModal(false);
      try {
        const res = await api.createRoleplaySession(projectId, input);
        setActiveSession(res.session);
        setPendingReplaceMessageId(null);
        const list = await api.listRoleplaySessions(projectId);
        setSessions(list.sessions);
      } catch (err) {
        setError(err instanceof Error ? err.message : '会話を開始できませんでした');
      }
    },
    [projectId]
  );

  const handleSelectSession = useCallback(
    async (sessionId: string) => {
      if (isStreaming) {
        setError('生成中は他の会話に移動できません。停止してからやり直してください。');
        return;
      }
      setError(null);
      try {
        const res = await api.getRoleplaySession(projectId, sessionId);
        setActiveSession(res.session);
        setStreamingText('');
        setPendingReplaceMessageId(null);
        setMessage('');
      } catch (err) {
        setError(err instanceof Error ? err.message : '会話を読み込めませんでした');
      }
    },
    [projectId, isStreaming]
  );

  const handleSend = useCallback(async () => {
    if (!activeSession || !message.trim() || isStreaming) return;
    const text = message.trim();
    const replacePendingMessageId = pendingReplaceMessageId ?? undefined;
    // NOTE: 送信前 revision を控え、pre-header 失敗（user 未保存）と post-header 失敗
    // （user 保存済み・応答失敗）を再同期後の revision 比較で判別する（review §5.4/6）。
    const preSendRevision = activeSession.revision;
    setMessage('');
    setStreamingText('');
    setIsStreaming(true);
    setIsStopping(false);
    setIsRegenerate(false);
    setError(null);
    stopRequestedRef.current = false;
    sentMessageRef.current = text;
    autoScrollRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    const handlers: RoleplayStreamHandlers = {
      onChunk: (chunk) => {
        if (!stopRequestedRef.current) {
          setStreamingText((prev) => prev + chunk);
        }
      },
      onDone: async (session) => {
        const sentText = sentMessageRef.current;
        const stopWasRequested = stopRequestedRef.current;
        if (stopWasRequested) {
          // NOTE: 停止と完了が入れ違った場合、既に応答まで保存された元発言を
          // 入力欄へ残して二重送信させない。停止後に利用者が編集した文は保持する。
          setMessage((current) => (current === sentText ? '' : current));
        }
        setActiveSession(session);
        setPendingReplaceMessageId(null);
        resetStreamState();
        const list = await api.listRoleplaySessions(projectId).catch(() => null);
        if (list) setSessions(list.sessions);
      },
      onError: async (err) => {
        const stoppedSend = err.code === 'aborted' && stopRequestedRef.current;
        const sentText = sentMessageRef.current || text;
        setStreamingText('');
        abortRef.current = null;
        if (stoppedSend) {
          setError(null);
        } else {
          setError(err.error);
        }
        // NOTE: エラー時は GET で最新セッションに再同期して revision ズレを吸収し、
        // 末尾が未応答 user なら明示的な訂正送信へ移る。単なる入力欄の解放では
        // サーバーの pending_response 制約を越えられないため、messageId も保持する。
        let userWasSaved = true;
        try {
          const res = await api.getRoleplaySession(projectId, activeSession.sessionId);
          setActiveSession(res.session);
          userWasSaved = res.session.revision > preSendRevision;
          const last = res.session.messages[res.session.messages.length - 1];
          if (stoppedSend && last?.role === 'user') {
            setPendingReplaceMessageId(last.messageId);
            setMessage((current) => (current ? current : sentText));
          } else {
            setPendingReplaceMessageId(null);
            // NOTE: クライアント側は中断済みでも、サーバーが先に応答を保存していた場合は
            // 復元した元発言だけを消す。停止後に利用者が編集した文は保持する。
            if (stoppedSend && last?.role === 'character') {
              setMessage((current) => (current === sentText ? '' : current));
            }
          }
        } catch {
          // 再同期失敗時は「保存された可能性」寄りに倒し、二重送信リスクを避ける。
          userWasSaved = true;
        }
        if (!userWasSaved) {
          // NOTE: setMessage は state のクロージャに依らないため、
          // ユーザーがエラー中に別の文字を打ち始めていても上書きしないよう prev ベースにする。
          setMessage((current) => (current ? current : sentText));
        }
        resetStreamState();
        if (stoppedSend) {
          showStopNotice('応答を停止しました。文章を訂正して送信できます。');
        }
      },
    };

    await api.sendRoleplayMessageStream(
      projectId,
      activeSession.sessionId,
      { message: text, revision: preSendRevision, replacePendingMessageId },
      handlers,
      controller.signal
    );
  }, [
    activeSession,
    message,
    isStreaming,
    pendingReplaceMessageId,
    projectId,
    resetStreamState,
    showStopNotice,
  ]);

  const canRegenerate = useMemo(() => {
    // NOTE: 末尾が character + 直前 user、または末尾 user（送信失敗・再起動からの復旧）
    // のどちらでも再生成可能にする（review §5.3）。サーバー側 beginTurn は末尾 user を
    // 「送信失敗からの再試行」として受け付ける契約になっている。
    if (!activeSession) return false;
    const messages = activeSession.messages;
    if (messages.length === 0) return false;
    const last = messages[messages.length - 1];
    if (last.role === 'user') return true;
    if (last.role === 'character') {
      const previous = messages[messages.length - 2];
      return previous?.role === 'user';
    }
    return false;
  }, [activeSession]);

  const regenerateLabel = useMemo(() => {
    // NOTE: 末尾がユーザー発言のとき（＝直前送信の応答がまだ返っていない）は
    // 「再生成」よりも「もう一度応答をもらう」の方が意図が伝わる。
    if (!activeSession) return '↻ 再生成';
    const messages = activeSession.messages;
    const last = messages[messages.length - 1];
    if (last?.role === 'user') return '↻ もう一度応答をもらう';
    return '↻ 再生成';
  }, [activeSession]);

  const handleRegenerate = useCallback(async () => {
    if (!activeSession || !canRegenerate || isStreaming) return;
    if (pendingReplaceMessageId) {
      // 「もう一度応答をもらう」は保存済みの発言をそのまま再試行する操作。
      // 訂正用に復元した同じ文を新規入力として残さない。
      setMessage('');
      setPendingReplaceMessageId(null);
    }
    setStreamingText('');
    setIsStreaming(true);
    setIsStopping(false);
    setIsRegenerate(true);
    stopRequestedRef.current = false;
    sentMessageRef.current = '';
    autoScrollRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;

    const handlers: RoleplayStreamHandlers = {
      onChunk: (chunk) => {
        if (!stopRequestedRef.current) {
          setStreamingText((prev) => prev + chunk);
        }
      },
      onDone: async (session) => {
        setActiveSession(session);
        setPendingReplaceMessageId(null);
        resetStreamState();
        const list = await api.listRoleplaySessions(projectId).catch(() => null);
        if (list) setSessions(list.sessions);
      },
      onError: async (err) => {
        const stoppedRegenerate = err.code === 'aborted' && stopRequestedRef.current;
        if (stoppedRegenerate) {
          setError(null);
        } else {
          setError(err.error);
        }
        try {
          const res = await api.getRoleplaySession(projectId, activeSession.sessionId);
          setActiveSession(res.session);
        } catch {
          // ignore
        }
        setPendingReplaceMessageId(null);
        resetStreamState();
        if (stoppedRegenerate) {
          showStopNotice('応答を停止しました。「もう一度応答をもらう」から再試行できます。');
        }
      },
    };

    await api.regenerateRoleplayStream(
      projectId,
      activeSession.sessionId,
      { revision: activeSession.revision },
      handlers,
      controller.signal
    );
  }, [
    activeSession,
    canRegenerate,
    isStreaming,
    pendingReplaceMessageId,
    projectId,
    resetStreamState,
    showStopNotice,
  ]);

  const handleStop = useCallback(() => {
    if (!abortRef.current || isStopping) return;
    stopRequestedRef.current = true;
    setIsStopping(true);
    if (!isRegenerate && sentMessageRef.current) {
      setMessage((current) => (current ? current : sentMessageRef.current));
    }
    abortRef.current.abort();
  }, [isRegenerate, isStopping]);

  const handleArchive = useCallback(async () => {
    if (!activeSession || isStreaming || isStopping) return;
    if (!window.confirm('この会話をアーカイブしますか？（一覧から消えますが履歴は保持されます）')) {
      return;
    }
    try {
      await api.archiveRoleplaySession(projectId, activeSession.sessionId, {
        revision: activeSession.revision,
      });
      setPendingReplaceMessageId(null);
      setMessage('');
      setStreamingText('');
      setIsStreaming(false);
      setIsStopping(false);
      setIsRegenerate(false);
      abortRef.current = null;
      stopRequestedRef.current = false;
      sentMessageRef.current = '';
      setActiveSession(null);
      const list = await api.listRoleplaySessions(projectId);
      setSessions(list.sessions);
      if (list.sessions.length > 0) {
        const first = list.sessions[0];
        const res = await api.getRoleplaySession(projectId, first.sessionId);
        setActiveSession(res.session);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'アーカイブに失敗しました');
    }
  }, [activeSession, isStopping, isStreaming, projectId]);

  // NOTE: 選択→NG登録の対象範囲検証（review §5.6 / P2）。
  //   1) selection の anchor/focus 両方が同一の「character バブル本文」要素内に閉じているか
  //      を data 属性 + closest で検証。user 発言・ラベル・複数バブルを跨いだ選択は弾く。
  //   2) mouseup だけでなく selectionchange でも判定を走らせ、touch 系（iOS Safari）で
  //      mouseup が来ない経路でもボタンが出るようにする。selectionchange は input への
  //      入力でも発火するため、無関係な選択はガードで早期 return する。
  //   3) 1〜30 字の制約は本編 Reader.tsx と揃える（本編と同じ NG ストアに入るため）。
  const evaluateSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setSelectionButtonPosition(null);
      setSelectedText('');
      return;
    }
    const range = selection.getRangeAt(0);
    // NOTE: 選択の両端がどこにあるかを判定するのに、範囲全体を包含する最小要素から
    // closest で character バブル属性を持つ祖先を探す。commonAncestor がテキストノード
    // の場合はその親要素から探し始める。
    const container = range.commonAncestorContainer;
    const containerEl: Element | null =
      container.nodeType === Node.ELEMENT_NODE
        ? (container as Element)
        : container.parentElement;
    const bubbleContent = containerEl?.closest('[data-roleplay-character-bubble="true"]') ?? null;
    if (!bubbleContent) {
      // NOTE: 選択が character バブル本文の外にある、あるいは複数バブルを跨いでいる
      // （commonAncestor が上位に飛ぶ）→ 対象外。
      setSelectionButtonPosition(null);
      setSelectedText('');
      return;
    }
    // NOTE: commonAncestor が bubble 内でも、anchor/focus がそれぞれ実際に含まれるか
    // 二重チェック（Range.commonAncestorContainer は「両端を含む最小のノード」なので
    // 概念上は同義だが、DOM API の実装差異を避けるため明示的に検査する）。
    if (
      !selection.anchorNode ||
      !selection.focusNode ||
      !bubbleContent.contains(selection.anchorNode) ||
      !bubbleContent.contains(selection.focusNode)
    ) {
      setSelectionButtonPosition(null);
      setSelectedText('');
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 1 || text.length > 30) {
      setSelectionButtonPosition(null);
      setSelectedText('');
      return;
    }
    const rect = range.getBoundingClientRect();
    // NOTE: getBoundingClientRect が 0,0 の場合（IME 中など）は位置更新をスキップ。
    if (rect.width === 0 && rect.height === 0) return;
    setSelectedText(text);
    setSelectionButtonPosition({ top: rect.bottom + 4, left: rect.left });
  }, []);

  const handleRegisterSelectedNg = useCallback(async () => {
    if (!selectedText) return;
    try {
      await api.createExpression(projectId, { text: selectedText, source: 'selection' });
      setNotice(`「${selectedText}」をNG表現に登録しました。次のターンから反映されます。`);
      window.setTimeout(() => setNotice(null), 2500);
      setSelectionButtonPosition(null);
      setSelectedText('');
      window.getSelection()?.removeAllRanges();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'NG表現の登録に失敗しました');
    }
  }, [projectId, selectedText]);

  // NOTE: selectionchange はドキュメント全体の選択変化を捉える（touch 選択の受け口）。
  // evaluateSelection 側で対象外の場合は早期 return するので副作用は最小限。
  useEffect(() => {
    document.addEventListener('selectionchange', evaluateSelection);
    return () => document.removeEventListener('selectionchange', evaluateSelection);
  }, [evaluateSelection]);

  if (loading) {
    return <div className="loading" style={{ padding: '2rem' }}>読み込み中…</div>;
  }

  return (
    <div className="roleplay-workspace" style={styles.wrapper}>
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <button onClick={onBack} style={styles.linkButton}>← 一覧に戻る</button>
          <h2 style={{ margin: '0.5rem 0', fontSize: '1rem' }}>{project?.title ?? ''}</h2>
        </div>
        <button
          onClick={() => setShowNewModal(true)}
          className="primary"
          style={{ margin: '0 0.75rem 0.5rem' }}
          disabled={characters.length === 0}
        >
          + 新しい会話
        </button>
        {characters.length === 0 && (
          <p style={styles.hint}>
            キャラクターがまだ登録されていません。作品設定でキャラを追加してから会話を始められます。
          </p>
        )}
        <ul style={styles.sessionList}>
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                onClick={() => handleSelectSession(s.sessionId)}
                style={{
                  ...styles.sessionItem,
                  ...(activeSession?.sessionId === s.sessionId
                    ? styles.sessionItemActive
                    : {}),
                }}
                title={s.scenario || undefined}
              >
                <div style={styles.sessionItemTitle}>{s.characterName}</div>
                {s.scenario && (
                  <div style={styles.sessionItemScenario}>{s.scenario}</div>
                )}
                {s.lastExcerpt && (
                  <div style={styles.sessionItemExcerpt}>{s.lastExcerpt}</div>
                )}
              </button>
            </li>
          ))}
        </ul>
        <div style={styles.sidebarFooter}>
          <button onClick={onOpenWorkSettings} style={styles.linkButton}>作品設定</button>
          <button onClick={onOpenTechSettings} style={styles.linkButton}>技術設定</button>
        </div>
      </aside>

      <main style={styles.main}>
        {error && (
          <div className="error-toast" style={{ marginBottom: '0.5rem' }}>
            {error}
            <button
              onClick={() => setError(null)}
              style={{ marginLeft: '0.5rem' }}
            >
              ✕
            </button>
          </div>
        )}

        {activeSession ? (
          <>
            <div style={styles.mainHeader}>
              <div>
                <div style={styles.characterName}>{currentCharacterName}</div>
                {activeSession.scenario && (
                  <div style={styles.scenario}>舞台: {activeSession.scenario}</div>
                )}
              </div>
              <button
                onClick={handleArchive}
                style={styles.linkButton}
                disabled={isStreaming || isStopping}
              >
                アーカイブ
              </button>
            </div>

            <div
              style={styles.chatArea}
              onScroll={(e) => {
                const el = e.currentTarget;
                const nearBottom =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                autoScrollRef.current = nearBottom;
              }}
            >
              {activeSession.messages
                .filter((m) => {
                  // NOTE: regenerate 中で、末尾がキャラ発言のときはそれを一時非表示にして
                  // その位置に streamingText を出す（旧応答が新応答で置換されるため）。
                  // 末尾が user 発言のときは何も隠さず、streamingText はその下に新規追加
                  // される形になる。
                  if (isStreaming && isRegenerate) {
                    const last = activeSession.messages[activeSession.messages.length - 1];
                    if (last?.role === 'character' && m.messageId === last.messageId) {
                      return false;
                    }
                  }
                  return true;
                })
                .map((m) => (
                  <div
                    key={m.messageId}
                    style={{
                      ...styles.bubble,
                      ...(m.role === 'user' ? styles.userBubble : styles.characterBubble),
                    }}
                    // NOTE: onMouseUp でも即時判定する（selectionchange はブラウザによって
                    // 遅延・欠落する場合がある）。touch 系は selectionchange 経由で拾う。
                    onMouseUp={m.role === 'character' ? evaluateSelection : undefined}
                  >
                    <div style={styles.bubbleLabel}>
                      {m.role === 'user' ? 'あなた' : currentCharacterName}
                    </div>
                    <div
                      style={styles.bubbleContent}
                      // NOTE: 選択→NG登録の対象範囲マーカー。character 発言本文だけに付ける
                      //（ラベル・user 発言・複数バブル横断選択を弾く根拠になる）。
                      data-roleplay-character-bubble={m.role === 'character' ? 'true' : undefined}
                    >
                      {m.content}
                    </div>
                  </div>
                ))}
              {isStreaming && (
                <div style={{ ...styles.bubble, ...styles.characterBubble }}>
                  <div style={styles.bubbleLabel}>
                    {currentCharacterName}
                    <span style={styles.streamingBadge}>生成中…</span>
                  </div>
                  <div style={styles.bubbleContent}>
                    {streamingText || <em style={styles.placeholder}>応答を待っています…</em>}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div style={styles.inputArea}>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!isStreaming) void handleSend();
                  }
                }}
                disabled={(isStreaming && !isStopping) || activeSession.status !== 'active'}
                placeholder={
                  activeSession.status === 'archived'
                    ? 'このセッションはアーカイブ済みです'
                    : 'メッセージを入力（Enterで送信、Shift+Enterで改行）'
                }
                style={styles.textarea}
                rows={3}
              />
              <div style={styles.inputActions}>
                {isStreaming && !isStopping ? (
                  <button onClick={handleStop}>停止</button>
                ) : isStopping ? (
                  <button disabled>停止完了後に送信できます</button>
                ) : (
                  <>
                    {canRegenerate && (
                      <button
                        onClick={handleRegenerate}
                        title="末尾のキャラ発言を作り直す、または直前ユーザー発言への応答をもう一度取り直す"
                      >
                        {regenerateLabel}
                      </button>
                    )}
                    <button
                      className="primary"
                      onClick={handleSend}
                      disabled={!message.trim() || activeSession.status !== 'active'}
                    >
                      {pendingReplaceMessageId ? '訂正して送信' : '送信'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div style={styles.emptyMain}>
            <p>まだ会話がありません。「新しい会話」ボタンから始められます。</p>
            {characters.length > 0 && (
              <button className="primary" onClick={() => setShowNewModal(true)}>
                会話を始める
              </button>
            )}
          </div>
        )}
      </main>

      {showNewModal && (
        <NewSessionModal
          characters={characters}
          scenarioSeeds={project?.scenarioSeeds ?? []}
          onCancel={() => setShowNewModal(false)}
          onStart={handleStartConversation}
        />
      )}

      {selectionButtonPosition && (
        // NOTE: 選択の直下にフローティングボタンを固定配置。position:fixed で
        // ビューポート座標をそのまま使う（Reader.tsx と同型）。
        <button
          onMouseDown={(e) => {
            // NOTE: mousedown で selection が消えないよう preventDefault する。
            e.preventDefault();
          }}
          onClick={handleRegisterSelectedNg}
          style={{
            position: 'fixed',
            top: selectionButtonPosition.top,
            left: selectionButtonPosition.left,
            zIndex: 200,
            padding: '0.35rem 0.7rem',
            fontSize: '0.8rem',
            borderRadius: '6px',
            background: 'var(--accent)',
            color: '#ffffff',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}
        >
          「{selectedText}」を NG に登録
        </button>
      )}

      {notice && (
        <div
          style={{
            position: 'fixed',
            bottom: '1rem',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 200,
            padding: '0.5rem 1rem',
            borderRadius: '6px',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            fontSize: '0.9rem',
          }}
        >
          {notice}
        </div>
      )}
    </div>
  );
}

interface NewSessionModalProps {
  characters: Character[];
  scenarioSeeds: string[];
  onCancel: () => void;
  onStart: (input: StartConversationInput) => Promise<void>;
}

function NewSessionModal({
  characters,
  scenarioSeeds,
  onCancel,
  onStart,
}: NewSessionModalProps) {
  const [characterId, setCharacterId] = useState<string>(
    characters[0]?.characterId ?? ''
  );
  const [scenario, setScenario] = useState('');
  const [starting, setStarting] = useState(false);

  const handleStart = async () => {
    if (!characterId) return;
    setStarting(true);
    try {
      await onStart({ characterId, scenario: scenario.trim() || undefined });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div style={styles.modalBackdrop}>
      <div style={styles.modal}>
        <h3>新しい会話を始める</h3>
        <div style={{ marginBottom: '1rem' }}>
          <label style={styles.label}>
            相手キャラクター
            <select
              value={characterId}
              onChange={(e) => setCharacterId(e.target.value)}
              style={styles.select}
            >
              {characters.map((c) => (
                <option key={c.characterId} value={c.characterId}>
                  {c.name || '（無名）'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label style={styles.label}>
            シナリオ（会話の舞台。空でもOK）
            {scenarioSeeds.length > 0 && (
              <div style={styles.scenarioChips}>
                {scenarioSeeds.map((seed, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setScenario(seed)}
                    style={styles.scenarioChip}
                  >
                    {seed}
                  </button>
                ))}
              </div>
            )}
            <textarea
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              placeholder="例：放課後の教室で二人きり"
              rows={2}
              style={styles.textarea}
              maxLength={1000}
            />
          </label>
        </div>
        <div style={styles.modalActions}>
          <button onClick={onCancel} disabled={starting}>
            キャンセル
          </button>
          <button
            className="primary"
            onClick={handleStart}
            disabled={!characterId || starting}
          >
            {starting ? '開始中…' : '会話を始める'}
          </button>
        </div>
      </div>
    </div>
  );
}

// NOTE: 既存 styles.css のテーマ変数（--bg / --surface / --text / --text-muted /
// --accent / --border / --overlay）をそのまま利用する。フォールバック値は
// ダークテーマ寄りにするより、テーマが崩れて未定義になったら「白背景に黒文字」
// で確実に読める組み合わせを渡す。
const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    height: '100vh',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  sidebar: {
    width: '280px',
    borderRight: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--surface)',
    color: 'var(--text)',
  },
  sidebarHeader: {
    padding: '0.75rem',
    borderBottom: '1px solid var(--border)',
  },
  sidebarFooter: {
    marginTop: 'auto',
    padding: '0.5rem 0.75rem',
    borderTop: '1px solid var(--border)',
    display: 'flex',
    gap: '0.5rem',
  },
  sessionList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    overflow: 'auto',
    flex: 1,
  },
  sessionItem: {
    width: '100%',
    textAlign: 'left',
    padding: '0.6rem 0.75rem',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
    color: 'var(--text)',
  },
  sessionItemActive: {
    background: 'var(--surface-hover)',
  },
  sessionItemTitle: {
    fontWeight: 600,
    marginBottom: '0.15rem',
    color: 'var(--text)',
  },
  sessionItemScenario: {
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
    marginBottom: '0.15rem',
  },
  sessionItemExcerpt: {
    fontSize: '0.75rem',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  linkButton: {
    background: 'transparent',
    border: 'none',
    color: 'var(--accent)',
    cursor: 'pointer',
    padding: '0.2rem 0.4rem',
    fontSize: '0.85rem',
  },
  hint: {
    padding: '0 0.75rem 0.5rem',
    fontSize: '0.8rem',
    color: 'var(--text-muted)',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '0.75rem',
    minWidth: 0,
    color: 'var(--text)',
  },
  mainHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    borderBottom: '1px solid var(--border)',
    paddingBottom: '0.5rem',
    marginBottom: '0.5rem',
  },
  characterName: {
    fontSize: '1.1rem',
    fontWeight: 600,
    color: 'var(--text)',
  },
  scenario: {
    fontSize: '0.85rem',
    color: 'var(--text-muted)',
  },
  chatArea: {
    flex: 1,
    overflow: 'auto',
    padding: '0.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  bubble: {
    maxWidth: '80%',
    padding: '0.6rem 0.9rem',
    borderRadius: '12px',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
  },
  // NOTE: ユーザー吹き出しはアクセント色ベース。文字色は白でどちらのテーマでも
  // 読める（アプリのアクセントは中間色なので白がコントラストを稼げる）。
  userBubble: {
    alignSelf: 'flex-end',
    background: 'var(--accent)',
    color: '#ffffff',
  },
  // NOTE: キャラ吹き出しは surface。ダークでもライトでも「本文の下地」に馴染む。
  characterBubble: {
    alignSelf: 'flex-start',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  },
  bubbleLabel: {
    fontSize: '0.7rem',
    opacity: 0.8,
    marginBottom: '0.25rem',
    display: 'flex',
    gap: '0.4rem',
    alignItems: 'center',
  },
  bubbleContent: {
    fontSize: '0.95rem',
  },
  streamingBadge: {
    fontSize: '0.7rem',
    padding: '0.05rem 0.4rem',
    borderRadius: '999px',
    background: 'var(--accent)',
    color: '#ffffff',
  },
  placeholder: {
    color: 'var(--text-muted)',
  },
  inputArea: {
    borderTop: '1px solid var(--border)',
    paddingTop: '0.5rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  textarea: {
    width: '100%',
    resize: 'vertical',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    padding: '0.5rem',
    borderRadius: '8px',
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text)',
    boxSizing: 'border-box',
  },
  inputActions: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'flex-end',
  },
  emptyMain: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    color: 'var(--text-muted)',
  },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    background: 'var(--overlay)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  // NOTE: モーダル本体は surface。ここが以前 #fff 固定だったため、ダークテーマの
  // 明るいテキスト色（--text = #e8e8e8）が白背景に載って読めなくなっていた。
  modal: {
    background: 'var(--surface)',
    color: 'var(--text)',
    padding: '1.5rem',
    borderRadius: '12px',
    width: '90%',
    maxWidth: '480px',
    border: '1px solid var(--border)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.35)',
  },
  label: {
    display: 'block',
    fontSize: '0.9rem',
    color: 'var(--text)',
  },
  select: {
    width: '100%',
    marginTop: '0.35rem',
    padding: '0.4rem',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  scenarioChips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.35rem',
    margin: '0.35rem 0',
  },
  scenarioChip: {
    padding: '0.2rem 0.6rem',
    borderRadius: '999px',
    border: '1px solid var(--border)',
    background: 'var(--bg)',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: '0.8rem',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '1rem',
  },
};
