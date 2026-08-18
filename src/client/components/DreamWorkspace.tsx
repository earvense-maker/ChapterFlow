// NOTE: 夢見るモードの主画面（docs/design/夢見るモード_MVP設計書.md §2 / §8 / §9）。
//
// 表示するものは、夢の本文、末尾の一行入力欄、生成中の最小限の状態と停止、画面端の小さな
// 「目覚める」、回復に必要なエラーだけ。吹き出し、発言者名、セッション一覧、設定ピル、
// 再生成ボタン、選択肢は出さない。ユーザー入力も本文中には再表示しない（設計書 §2）。
//
// キーボード（設計書 §2）:
//  - Enter: 送信。空入力なら observe（しばらく眺める）。
//  - Shift+Enter: 改行。IME 変換中の Enter は送信にしない。
//  - Escape: 生成中だけ停止。
//  - /wake + Enter: 目覚める。
//
// 復旧契約（設計書 §8 / §10）: ストリーム中断後は GET 再同期し、保存済み末尾 user 発言から
// replacePendingMessageId で再試行する（同じ入力を追加しない）。初回生成失敗でも作成済み
// session は削除せず、Enter で再試行できる。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type RoleplayStreamHandlers } from '../clientApi';
import type { DreamMemorySettings, Project, RoleplaySessionView } from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
  onOpenWorkSettings: () => void;
  onOpenTechSettings: () => void;
}

export default function DreamWorkspace({
  projectId,
  onBack,
  onOpenWorkSettings,
  onOpenTechSettings,
}: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [activeSession, setActiveSession] = useState<RoleplaySessionView | null>(null);
  const [message, setMessage] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [shouldFocusInput, setShouldFocusInput] = useState(false);
  const [pendingReplaceMessageId, setPendingReplaceMessageId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [waking, setWaking] = useState(false);
  const [ended, setEnded] = useState(false);
  // NOTE: 初回の記録の明示（設計書 §5）。acknowledge するまで最初の observe は送らない。
  const [disclosure, setDisclosure] = useState<DreamMemorySettings | null>(null);
  // NOTE: sendTurnForSession は acknowledge 直後に startFirstDream から呼ばれるため、
  // state 反映前でも正しく判定できるよう ref で同期する。
  const disclosureAcknowledgedRef = useRef(false);
  disclosureAcknowledgedRef.current = disclosure?.disclosureAcknowledged ?? false;

  const abortRef = useRef<AbortController | null>(null);
  const streamActiveRef = useRef(false);
  const streamStartedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const projectIdRef = useRef(projectId);
  const sentMessageRef = useRef('');
  const stopRequestedRef = useRef(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const dreamAreaRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const noticeTimerRef = useRef<number | null>(null);
  projectIdRef.current = projectId;

  useEffect(() => {
    mountedRef.current = true;
    abortRef.current = null;
    streamActiveRef.current = false;
    streamStartedAtRef.current = 0;
    stopRequestedRef.current = false;
    sentMessageRef.current = '';
    setIsStreaming(false);
    setIsStopping(false);
    setStreamingText('');
    setError(null);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      streamActiveRef.current = false;
      streamStartedAtRef.current = 0;
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    };
  }, [projectId]);

  const resetStreamState = useCallback(() => {
    setStreamingText('');
    setIsStreaming(false);
    setIsStopping(false);
    abortRef.current = null;
    streamActiveRef.current = false;
    streamStartedAtRef.current = 0;
    stopRequestedRef.current = false;
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      if (mountedRef.current) setNotice(null);
    }, 2500);
  }, []);

  // NOTE: 送信の本体。session は引数で受け取り、初回生成（setActiveSession 反映前）でも
  // 使えるようにする（設計書 §8-4: セッション作成と初回生成は別リクエスト）。
  const sendTurnForSession = useCallback(
    async (
      session: RoleplaySessionView,
      input: { kind: 'text' | 'observe'; text?: string }
    ) => {
      if (isStreaming || streamActiveRef.current) return;
      // NOTE: 初回の明示（設計書 §5）を確認するまで、記録が始まる送信は行わない。
      if (!disclosureAcknowledgedRef.current) {
        setError('夢の記録についての説明を確認してから始めてください。');
        setShouldFocusInput(true);
        return;
      }
      const preSendRevision = session.revision;
      const replacePendingMessageId = pendingReplaceMessageId ?? undefined;
      const rawText = input.kind === 'text' ? input.text ?? '' : '';
      setMessage('');
      setStreamingText('');
      setError(null);
      setIsStreaming(true);
      setIsStopping(false);
      stopRequestedRef.current = false;
      sentMessageRef.current = input.kind === 'text' ? rawText : '';
      autoScrollRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      streamActiveRef.current = true;
      streamStartedAtRef.current = Date.now();

      const handlers: RoleplayStreamHandlers = {
        onChunk: (chunk) => {
          if (
            mountedRef.current &&
            projectIdRef.current === projectId &&
            abortRef.current === controller &&
            !stopRequestedRef.current
          ) {
            setStreamingText((prev) => prev + chunk);
          }
        },
        onDone: async (nextSession) => {
          if (
            !mountedRef.current ||
            projectIdRef.current !== projectId ||
            abortRef.current !== controller
          ) return;
          if (stopRequestedRef.current) {
            // NOTE: 停止と完了が入れ違った場合、応答まで保存された元入力は復元しない。
            // 停止後に利用者が新しく入力していた場合だけ、その内容を保持する。
            const sentText = sentMessageRef.current;
            setMessage((current) => (current === sentText ? '' : current));
          }
          setActiveSession(nextSession);
          setPendingReplaceMessageId(null);
          resetStreamState();
          setShouldFocusInput(true);
        },
        onError: async (err) => {
          if (
            !mountedRef.current ||
            projectIdRef.current !== projectId ||
            abortRef.current !== controller
          ) return;
          const stopped = err.code === 'aborted' && stopRequestedRef.current;
          const sentText = sentMessageRef.current || rawText;
          setStreamingText('');
          abortRef.current = null;
          setError(stopped ? null : err.error);
          // NOTE: GET で再同期し、末尾が未応答 user なら訂正送信（replacePendingMessageId）
          // で再試行する。同じ入力を追加しない（設計書 §10）。
          let userWasSaved = true;
          try {
            const res = await api.getRoleplaySession(projectId, session.sessionId);
            if (!mountedRef.current || projectIdRef.current !== projectId) return;
            setActiveSession(res.session);
            userWasSaved = res.session.revision > preSendRevision;
            const last = res.session.messages[res.session.messages.length - 1];
            if (last?.role === 'user') {
              setPendingReplaceMessageId(last.messageId);
              if (last.inputKind !== 'observe') {
                setMessage((current) => (current ? current : sentText));
              }
            } else {
              setPendingReplaceMessageId(null);
              if (stopped && last?.role === 'character') {
                setMessage((current) => (current === sentText ? '' : current));
              }
            }
          } catch {
            // 再同期できない間は「保存済みかもしれない」側へ倒し、同じ入力を新しい turn として
            // 二重送信しない。再読み込み時にサーバーの正本から復元する。
            userWasSaved = true;
          }
          if (!userWasSaved) {
            setMessage((current) => (current ? current : sentText));
          }
          resetStreamState();
          setShouldFocusInput(true);
          if (stopped) {
            showNotice('停止しました。空のまま Enter で眺めることもできます。');
          }
        },
      };

      try {
        await api.sendRoleplayMessageStream(
          projectId,
          session.sessionId,
          {
            ...(input.kind === 'text' ? { message: rawText } : {}),
            ...(input.kind === 'observe' ? { inputKind: 'observe' } : {}),
            revision: preSendRevision,
            replacePendingMessageId,
          },
          handlers,
          controller.signal
        );
      } catch (err) {
        await handlers.onError({
          error: err instanceof Error ? err.message : '夢の取得に失敗しました。',
          code: 'unexpected_client_error',
          retryable: true,
        });
      }
    },
    [isStreaming, pendingReplaceMessageId, projectId]
  );

  const sendTurn = useCallback(
    async (input: { kind: 'text' | 'observe'; text?: string }) => {
      if (!activeSession) return;
      await sendTurnForSession(activeSession, input);
    },
    [activeSession, sendTurnForSession]
  );

  const startFirstDream = useCallback(async () => {
    const expectedProjectId = projectId;
    setIsCreatingSession(true);
    setError(null);
    try {
      const res = await api.createRoleplaySession(projectId, {
        characterId: '',
        sessionMode: 'dream',
      });
      if (!mountedRef.current || projectIdRef.current !== expectedProjectId) return;
      setActiveSession(res.session);
      // NOTE: 作成後、UI が直ちに inputKind: 'observe' の最初ターンを送る（設計書 §8-3）。
      // 初回生成が失敗しても session は失わず、Enter で再試行できる（設計書 §8-4）。
      await sendTurnForSession(res.session, { kind: 'observe' });
    } catch (err) {
      if (mountedRef.current && projectIdRef.current === expectedProjectId) {
        setError(err instanceof Error ? err.message : '夢を始められませんでした');
      }
    } finally {
      if (mountedRef.current && projectIdRef.current === expectedProjectId) {
        setIsCreatingSession(false);
      }
    }
  }, [projectId, sendTurnForSession]);

  const loadInitial = useCallback(async () => {
    const expectedProjectId = projectId;
    setLoading(true);
    setError(null);
    try {
      const [proj, sessionsRes, memorySettings] = await Promise.all([
        api.getProject(projectId),
        api.listRoleplaySessions(projectId),
        api.getDreamMemorySettings(),
      ]);
      if (!mountedRef.current || projectIdRef.current !== expectedProjectId) return;
      setProject(proj);
      setDisclosure(memorySettings.settings);
      // NOTE: ロード直後に startFirstDream が走るため、state 反映前でも判定できるよう
      // ref をここで立てる（render 時の同期は後続の変更用）。
      disclosureAcknowledgedRef.current = memorySettings.settings.disclosureAcknowledged;
      if (sessionsRes.sessions.length > 0) {
        // NOTE: active session の最新件があればそのまま再開する（設計書 §8-1）。
        const first = sessionsRes.sessions[0];
        const view = await api.getRoleplaySession(projectId, first.sessionId);
        if (!mountedRef.current || projectIdRef.current !== expectedProjectId) return;
        setActiveSession(view.session);
        setPendingReplaceMessageId(null);
        setShouldFocusInput(true);
        // NOTE: 末尾が未応答 user（送信・通信断）なら、入力欄に元の言葉を戻して Enter で
        // 再試行できるようにする（設計書 §10: 同じ入力を追加しない）。
        const last = view.session.messages[view.session.messages.length - 1];
        if (last?.role === 'user') {
          setPendingReplaceMessageId(last.messageId);
          if (last.inputKind !== 'observe') setMessage(last.content);
        }
      } else if (memorySettings.settings.disclosureAcknowledged) {
        // NOTE: セッションが無ければ dream 空セッションを作り、直後に初回 observe を送る
        // （設計書 §8-2 / §8-3）。
        await startFirstDream();
      }
    } catch (err) {
      if (mountedRef.current && projectIdRef.current === expectedProjectId) {
        setError(err instanceof Error ? err.message : '夢の読み込みに失敗しました');
      }
    } finally {
      if (mountedRef.current && projectIdRef.current === expectedProjectId) {
        setLoading(false);
      }
    }
  }, [projectId, startFirstDream]);

  // NOTE: projectId ごとに一度だけ初期化する。loadInitial は sendTurnForSession の依存
  // （isStreaming / pendingReplaceMessageId 等）で毎 render 作り直されるため、そのまま
  // useEffect の依存にするとエラー後の再同期で GET 再初期化が繰り返される。
  const initializedRef = useRef<string | null>(null);
  useEffect(() => {
    if (initializedRef.current === projectId) return;
    initializedRef.current = projectId;
    void loadInitial();
  }, [loadInitial, projectId]);

  const handleWake = useCallback(async () => {
    if (!activeSession || isStreaming || isStopping || waking) return;
    setWaking(true);
    setError(null);
    try {
      await api.archiveRoleplaySession(projectId, activeSession.sessionId, {
        revision: activeSession.revision,
      });
      if (!mountedRef.current || projectIdRef.current !== projectId) return;
      setEnded(true);
      setActiveSession(null);
      setMessage('');
      setPendingReplaceMessageId(null);
    } catch (err) {
      if (mountedRef.current && projectIdRef.current === projectId) {
        setError(
          err instanceof Error ? err.message : '目覚められませんでした。もう一度お試しください。'
        );
      }
    } finally {
      if (mountedRef.current && projectIdRef.current === projectId) {
        setWaking(false);
      }
    }
  }, [activeSession, isStopping, isStreaming, projectId, waking]);

  const handleStop = useCallback(() => {
    if (!abortRef.current || isStopping) return;
    stopRequestedRef.current = true;
    setIsStopping(true);
    abortRef.current.abort();
  }, [isStopping]);

  // NOTE: Escape は生成中だけ停止（設計書 §2）。生成中は入力欄が表示されないため、
  // ウィンドウ単位で受け取る。入力欄にフォーカスがあるときは textarea 側でも拾う。
  useEffect(() => {
    if (!isStreaming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleStop();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleStop, isStreaming]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // NOTE: IME 変換中の Enter は送信にしない（設計書 §2）。
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (isStreaming) return;
        const trimmed = message.trim();
        if (trimmed === '/wake') {
          void handleWake();
          return;
        }
        void sendTurn(
          trimmed ? { kind: 'text', text: message } : { kind: 'observe', text: undefined }
        );
      } else if (event.key === 'Escape' && isStreaming) {
        event.preventDefault();
        handleStop();
      }
    },
    [handleStop, handleWake, isStreaming, message, sendTurn]
  );

  const acknowledgeDisclosure = useCallback(async () => {
    try {
      const result = await api.updateDreamMemorySettings({ disclosureAcknowledged: true });
      // NOTE: startFirstDream が同一イベントループ内で sendTurnForSession を呼ぶため、
      // ref を先に立てておく（state は次 render で反映される）。
      disclosureAcknowledgedRef.current = true;
      setDisclosure(result.settings);
      if (mountedRef.current && projectIdRef.current === projectId && !activeSession) {
        await startFirstDream();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '設定を保存できませんでした');
    }
  }, [activeSession, startFirstDream]);

  // NOTE: 生成完了・回復可能なエラー後は、常に入力欄へフォーカスを戻す（設計書 §2）。
  useEffect(() => {
    if (!shouldFocusInput || isStreaming) return;
    setShouldFocusInput(false);
    const input = textAreaRef.current;
    if (input && !input.disabled) input.focus();
  }, [isStreaming, shouldFocusInput]);

  const dreamText = useMemo(() => {
    const prose = (activeSession?.messages ?? []).filter((m) => m.role === 'character');
    return prose.map((m) => m.content).join('\n\n');
  }, [activeSession?.messages]);

  useLayoutEffect(() => {
    const area = dreamAreaRef.current;
    if (!area || !autoScrollRef.current) return;
    area.scrollTop = area.scrollHeight;
  }, [dreamText, isStreaming, streamingText]);

  const isPendingUserMessage =
    activeSession && activeSession.messages[activeSession.messages.length - 1]?.role === 'user';

  if (loading) {
    return <div className="loading dream-workspace-loading">夢を開いています…</div>;
  }

  return (
    <div className="dream-workspace">
      <header className="dream-workspace-header">
        <button className="dream-link" onClick={onBack}>← 一覧へ戻る</button>
        <span className="dream-title" title={project?.title ?? ''}>
          {project?.title ?? ''}
        </span>
        {/* NOTE: 画面端の小さな「目覚める」（設計書 §2）。生成中は目覚めず、停止完了を待つ。 */}
        <button
          className="dream-wake-button"
          onClick={() => void handleWake()}
          disabled={!activeSession || isStreaming || isStopping || waking || ended}
        >
          {waking ? '目覚めています…' : '目覚める'}
        </button>
      </header>

      <div className="dream-workspace-settings">
        <button className="dream-link" onClick={onOpenWorkSettings}>作品設定</button>
        <button className="dream-link" onClick={onOpenTechSettings}>技術設定</button>
      </div>

      {error && (
        <div className="dream-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {!disclosure?.disclosureAcknowledged && (
        <div className="dream-disclosure" role="note">
          <p>
            夢の中であなたが書いた言葉と、その直前の夢の本文は、作品を越えてこのアプリの
            保存先に記録されます。記録された言葉は未来の夢の本文として、現在選択中のモデル
            提供者へ送信されることがあります。アプリ設定から閲覧・書き出し・全消去・一時停止
            できます。
          </p>
          <button className="primary" onClick={() => void acknowledgeDisclosure()}>
            了解しました
          </button>
        </div>
      )}

      {ended ? (
        <div className="dream-ended">
          <p>目が覚めました。</p>
          <div>
            {/* NOTE: 目覚めると session は archive され、次回は新しい夢を開始できる（AC9）。 */}
            <button
              className="primary"
              onClick={() => {
                setEnded(false);
                void startFirstDream();
              }}
            >
              もう一度夢を見る
            </button>
            <button onClick={onBack}>一覧へ戻る</button>
          </div>
        </div>
      ) : (
        <main className="dream-main">
          {activeSession ? (
            <>
              <div
                className="dream-text"
                ref={dreamAreaRef}
                onScroll={(event) => {
                  const el = event.currentTarget;
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                  autoScrollRef.current = nearBottom;
                }}
              >
                {dreamText ? (
                  dreamText.split(/\n{2,}/).map((paragraph, index) => (
                    <p key={index} className="dream-paragraph">
                      {paragraph}
                    </p>
                  ))
                ) : (
                  <p className="dream-placeholder">……</p>
                )}
                {isStreaming && streamingText && (
                  <p className="dream-streaming">{streamingText}</p>
                )}
                {isStreaming && !streamingText && (
                  <p className="dream-placeholder">夢が立ち上がるのを待っています…</p>
                )}
              </div>

              <div className="dream-input-area">
                {isStreaming ? (
                  <div className="dream-streaming-status">
                    <span>{isStopping ? '止めています…' : '夢が続いています…'}</span>
                    {!isStopping && (
                      <button className="dream-stop-button" onClick={handleStop}>
                        停止 (Esc)
                      </button>
                    )}
                  </div>
                ) : (
                  <textarea
                    ref={textAreaRef}
                    className="dream-input"
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={!activeSession || activeSession.status !== 'active' || isCreatingSession}
                    rows={Math.min(4, Math.max(1, message.split('\n').length))}
                    placeholder={
                      activeSession.status === 'archived'
                        ? 'この夢は終わっています'
                        : isPendingUserMessage
                          ? 'Enter で夢を続ける（同じ言葉で再試行）'
                          : '浮かんだ言葉を書いて Enter。空のまま Enter でしばらく眺める'
                    }
                  />
                )}
                {notice && <div className="dream-notice">{notice}</div>}
              </div>
            </>
          ) : (
            <div className="dream-empty">
              <p>
                {isCreatingSession
                  ? '夢の入り口を開いています…'
                  : disclosure?.disclosureAcknowledged
                    ? '夢がありません。'
                    : '始める前に、夢の記録についてひとことだけ確認させてください。'}
              </p>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
