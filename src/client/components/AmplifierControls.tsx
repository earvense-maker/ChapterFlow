// 妄想増幅器の場面後共通UI（設計書 4.3）
//
// - 3〜5個の方向カード
// - 自由記述欄
// - 常設「この場面に留まる」
// - 常設「別の方向を出す」（本文ではなく選択肢だけを作り直す）
// - 「この方向は違う」（理由は任意・方向違いとして記録してから別の方向を作る）
// - 場面全体の「ここ好き」（選択範囲のお気に入りは親コンポーネントが呼ぶ）
//
// 方向カードには自然な見出しと短い説明だけを表示する。「鉄板」「変奏」「冒険」や
// 分析語は表示しない（設計書 5.2）。strategy は生成制御と評価用の非表示メタデータ。

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import type {
  AmplifierAnchor,
  AmplifierDirectionInput,
  AmplifierTurn,
} from '@shared/types';

interface Props {
  projectId: string;
  mode: 'novel' | 'roleplay';
  anchor: AmplifierAnchor;
  anchorExcerpt: string;
  // NOTE: 進行側（Reader/RoleplayWorkspace）が advance を開始する。turn はサーバー保存値の
  // 解決に必要なので必ず渡す（選択肢のラベル・本文をクライアントから信用しない・設計書 13.1）。
  onAdvance: (input: AmplifierDirectionInput, clientEventId: string, turn: AmplifierTurn) => void;
  onError: (message: string, code?: string) => void;
}

function anchorEquals(a: AmplifierAnchor, b: AmplifierAnchor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'novel') {
    return b.kind === 'novel' && a.generationId === b.generationId && a.textRevisionNumber === b.textRevisionNumber;
  }
  return (
    b.kind === 'roleplay' &&
    a.sessionId === b.sessionId &&
    a.messageId === b.messageId &&
    a.contentRevision === b.contentRevision
  );
}

function newClientEventId(): string {
  return `amp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AmplifierControls({
  projectId,
  mode,
  anchor,
  anchorExcerpt,
  onAdvance,
  onError,
}: Props) {
  const [turn, setTurn] = useState<AmplifierTurn | null>(null);
  const [creating, setCreating] = useState(false);
  const [freeText, setFreeText] = useState('');
  const [rejectedReason, setRejectedReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [busyChoiceId, setBusyChoiceId] = useState<string | null>(null);
  const [favoriting, setFavoriting] = useState(false);
  const loadRequestRef = useRef(0);

  // NOTE: アンカーが変わったら（本文編集・別案・再生成・別セッション）古いターンを捨て、
  // 現在の実効本文へ選択肢を作り直す（設計書 4.3）。
  const ensureTurn = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    const query =
      mode === 'roleplay' && anchor.kind === 'roleplay'
        ? { kind: 'roleplay' as const, sessionId: anchor.sessionId }
        : { kind: 'novel' as const };
    const stateResult = await api.getAmplifierState(projectId, query);
    if (requestId !== loadRequestRef.current) return;
    const existing = stateResult.turn;
    if (existing && anchorEquals(existing.anchor, anchor)) {
      setTurn(existing);
      return;
    }
    setTurn(null);
    setCreating(true);
    try {
      const result = await api.createAmplifierTurn(projectId, { anchor });
      if (requestId !== loadRequestRef.current) return;
      // NOTE: 生成中に本文が変わって stale になった場合は表示せず、次回アンカー変更時に作り直す
      setTurn(anchorEquals(result.turn.anchor, anchor) ? result.turn : null);
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      const code = (err as { code?: string }).code;
      if (code === 'amplifier_turn_in_progress') return;
      setTurn(null);
    } finally {
      if (requestId === loadRequestRef.current) setCreating(false);
    }
  }, [projectId, mode, anchor, anchorExcerpt]);

  useEffect(() => {
    setTurn(null);
    setBusyChoiceId(null);
    void ensureTurn();
  }, [ensureTurn]);

  const handleAlternatives = async () => {
    if (!turn || turn.status !== 'ready') return;
    setCreating(true);
    try {
      const result = await api.requestAmplifierTurnAlternatives(projectId, turn.turnId, {
        clientEventId: newClientEventId(),
        expectedTurnRevision: turn.revision,
      });
      setTurn(anchorEquals(result.turn.anchor, anchor) ? result.turn : null);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'amplifier_turn_stale') {
        void ensureTurn();
      } else {
        onError(err instanceof Error ? err.message : '別の方向の作成に失敗しました。', code);
      }
    } finally {
      setCreating(false);
    }
  };

  const handleRejectAndAlternatives = async () => {
    if (!turn || turn.status !== 'ready') return;
    setRejecting(true);
    try {
      const clientEventId = newClientEventId();
      await api.recordAmplifierDirectionRejection(projectId, turn.turnId, {
        clientEventId,
        turnId: turn.turnId,
        expectedTurnRevision: turn.revision,
        ...(rejectedReason.trim() ? { reason: rejectedReason.trim() } : {}),
      });
      setRejectedReason('');
      await handleAlternatives();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'amplifier_turn_stale') {
        void ensureTurn();
      } else {
        onError(err instanceof Error ? err.message : '方向違いの記録に失敗しました。', code);
      }
    } finally {
      setRejecting(false);
    }
  };

  const handleFavorite = async () => {
    if (favoriting) return;
    setFavoriting(true);
    try {
      await api.recordAmplifierFavorite(projectId, {
        clientEventId: newClientEventId(),
        scope: 'whole',
        anchor,
        excerpt: anchorExcerpt.trim() ? anchorExcerpt.trim().slice(0, 500) : undefined,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'お気に入りの保存に失敗しました。', (err as { code?: string }).code);
    } finally {
      setFavoriting(false);
    }
  };

  const choose = (choiceId: string) => {
    if (!turn || turn.status !== 'ready' || busyChoiceId) return;
    setBusyChoiceId(choiceId);
    onAdvance({ selectedChoiceId: choiceId }, newClientEventId(), turn);
  };

  const submitFreeText = () => {
    const text = freeText.trim();
    if (!text || !turn || turn.status !== 'ready' || busyChoiceId) return;
    setBusyChoiceId('free-text');
    onAdvance({ freeText: text }, newClientEventId(), turn);
  };

  const stay = () => {
    if (!turn || turn.status !== 'ready' || busyChoiceId) return;
    setBusyChoiceId('stay');
    onAdvance({ command: 'stay' }, newClientEventId(), turn);
  };

  const status = turn?.status ?? (creating ? 'choices_pending' : null);

  return (
    <div className="amplifier-controls" data-amplifier-controls>
      {status === 'choices_pending' && (
        <p className="amplifier-status">次の方向を考えています…</p>
      )}
      {status === 'failed' && (
        <div className="amplifier-status amplifier-status--failed">
          <span>方向の取得に失敗しました。本文はそのまま残っています。</span>
          <button onClick={() => void ensureTurn()} disabled={creating}>
            方向を再取得
          </button>
        </div>
      )}
      {status === 'ready' && turn && (
        <>
          <div className="amplifier-choices">
            {turn.choices.map((choice) => (
              <button
                key={choice.choiceId}
                className="amplifier-choice"
                onClick={() => choose(choice.choiceId)}
                disabled={Boolean(busyChoiceId)}
              >
                <span className="amplifier-choice-label">{choice.label}</span>
                <span className="amplifier-choice-description">{choice.description}</span>
              </button>
            ))}
          </div>
          <div className="amplifier-free-text">
            <input
              type="text"
              value={freeText}
              placeholder="こんな方向も見たい…（自由記述）"
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submitFreeText();
              }}
              disabled={Boolean(busyChoiceId)}
            />
            <button onClick={submitFreeText} disabled={!freeText.trim() || Boolean(busyChoiceId)}>
              送る
            </button>
          </div>
          <div className="amplifier-stay-actions">
            <button onClick={stay} disabled={Boolean(busyChoiceId)}>
              この場面に留まる
            </button>
            <button onClick={() => void handleAlternatives()} disabled={creating}>
              別の方向を出す
            </button>
            <button onClick={() => void handleFavorite()} disabled={favoriting}>
              ここ好き
            </button>
            {rejecting ? (
              <span className="amplifier-status">新しい方向を考えています…</span>
            ) : (
              <span className="amplifier-reject">
                <input
                  type="text"
                  value={rejectedReason}
                  placeholder="この方向は違う（理由は任意）"
                  onChange={(e) => setRejectedReason(e.target.value)}
                  disabled={creating}
                />
                <button
                  onClick={() => void handleRejectAndAlternatives()}
                  disabled={creating}
                >
                  違う
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
