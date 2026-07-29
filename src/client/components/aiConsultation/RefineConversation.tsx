import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import LightMarkdown from '../LightMarkdown';
import type {
  Character,
  RefineAutomationRun,
  RefineMessage,
  RefinePatch,
  RefineSession,
  RefineSuggestedAction,
} from '@shared/types';
import AutomationRunSummary from './AutomationRunSummary';
import RefinePatchCard from './RefinePatchCard';
import RefineSuggestedActions from './RefineSuggestedActions';

export interface ConversationStarter {
  label: string;
  message: string;
}

// NOTE: 空状態の開始ボタン。押した時点で初めて API を呼ぶ。タブを開いただけでは
// モデルを呼ばない（設計書 3.6 / 13）。すべて consult で送るのでパッチは出ない。
export const CONVERSATION_STARTERS: ConversationStarter[] = [
  { label: '今の設定の良さを整理', message: '今の設定の良いところを整理してほしいです。' },
  { label: '設定の弱いところを見つける', message: '今の設定で弱いところはどこだと思いますか。' },
  { label: '人物の背景を深掘り', message: '人物の背景をもう少し深掘りしたいです。' },
  { label: '関係性を強くする', message: '人物どうしの関係をもっと効かせたいです。' },
  { label: '意外な方向を提案', message: 'この作品で意外性のある方向はありますか。' },
  { label: '本文との食い違いを確認', message: '設定と本文で食い違っていそうな点はありますか。' },
];

interface Props {
  session: RefineSession | null;
  characters: Character[];
  runs: RefineAutomationRun[];
  sending: boolean;
  busyPatchId: string | null;
  revertingRunId: string | null;
  retryingRunId: string | null;
  actionsDisabled: boolean;
  onStartTopic: (starter: ConversationStarter) => void;
  onSelectSuggestedAction: (action: RefineSuggestedAction) => void;
  onApplyPatch: (patchId: string) => void;
  onRejectPatch: (patchId: string) => void;
  onDiscussAdjustment: (patch: RefinePatch) => void;
  onAcknowledgeRun: (runId: string) => void;
  onRevertRun: (runId: string) => void;
  onRetryRun: (runId: string) => void;
}

export default function RefineConversation({
  session,
  characters,
  runs,
  sending,
  busyPatchId,
  revertingRunId,
  retryingRunId,
  actionsDisabled,
  onStartTopic,
  onSelectSuggestedAction,
  onApplyPatch,
  onRejectPatch,
  onDiscussAdjustment,
  onAcknowledgeRun,
  onRevertRun,
  onRetryRun,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // NOTE: 初回描画では「新しい返答」を出さない。まだ何も追加されていないのに
  // 未読があるように見えてしまうため、件数が実際に増えたときだけ立てる。
  const seenCountRef = useRef<number | null>(null);
  const [hasNewReply, setHasNewReply] = useState(false);
  const messageCount = session?.messages.length ?? 0;

  // NOTE: 過去ログを読んでいる最中に無条件で最下部へ飛ばさない。下端付近にいた
  // ときだけ追従し、そうでなければ「新しい返答」ボタンで明示的に移動させる。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const previousCount = seenCountRef.current;
    seenCountRef.current = messageCount;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (previousCount === null || nearBottom) {
      el.scrollTop = el.scrollHeight;
      // NOTE: パッチカードや Markdown ブロックが同フレーム内で高さを変えることがあり、
      // 一度の代入では最下部に届かないことがある。次フレームでもう一度合わせる。
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (current) current.scrollTop = current.scrollHeight;
      });
      setHasNewReply(false);
      return;
    }
    if (messageCount > previousCount) setHasNewReply(true);
  }, [messageCount, session?.patches.length]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function handleScroll() {
      const target = scrollRef.current;
      if (!target) return;
      if (target.scrollHeight - target.scrollTop - target.clientHeight < 120) setHasNewReply(false);
    }
    el.addEventListener('scroll', handleScroll);
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const patchesByMessageId = new Map<string, RefinePatch[]>();
  const patchesByAutomationRunId = new Map<string, RefinePatch[]>();
  for (const patch of session?.patches ?? []) {
    const list = patchesByMessageId.get(patch.sourceMessageId) ?? [];
    list.push(patch);
    patchesByMessageId.set(patch.sourceMessageId, list);
    if (patch.automationRunId) {
      const runList = patchesByAutomationRunId.get(patch.automationRunId) ?? [];
      runList.push(patch);
      patchesByAutomationRunId.set(patch.automationRunId, runList);
    }
  }

  const runsByRunId = new Map(runs.map((run) => [run.runId, run]));
  // NOTE: run は session.messages の24件上限で落ちても refineAutomation.json には残る。
  // message と結び付く経路と、結び付かない run を単独描画する経路の2本立て。
  const messageAutomationRunIds = new Set(
    (session?.messages ?? [])
      .map((m) => m.automationRunId)
      .filter((id): id is string => typeof id === 'string')
  );
  const orphanRuns = runs.filter((run) => !messageAutomationRunIds.has(run.runId));
  const latestAppliedRun = runs.find(
    (r) =>
      r.appliedPatchIds.length > 0 &&
      r.status !== 'failed' &&
      r.acknowledgement !== 'reverted' &&
      r.beforeSnapshot !== undefined
  );

  function isRevertible(run: RefineAutomationRun | undefined): boolean {
    return Boolean(run && latestAppliedRun?.runId === run.runId);
  }

  const patchActionDisabled = sending || busyPatchId !== null || actionsDisabled;
  // NOTE: 操作できる候補は「session の最後のメッセージ」の候補だけ。再読み込み時も
  // messages の並びだけから同じ判定を再現できるようにする（設計書 5.1）。
  const lastMessage = session?.messages[session.messages.length - 1];
  const interactiveActionsMessageId =
    lastMessage?.role === 'assistant' && (lastMessage.suggestedActions?.length ?? 0) > 0
      ? lastMessage.messageId
      : null;

  return (
    <div className="refine-conversation">
      <div className="refine-chat-scroll refine-chat-messages" ref={scrollRef}>
        <div aria-live="polite" className="refine-conversation-live">
          {orphanRuns.length > 0 && (
            <div className="refine-automation-orphan-runs">
              <p className="refine-automation-orphan-heading">
                過去の自動レビュー履歴（相談の表示上限を超えたため単独表示）
              </p>
              {orphanRuns.map((run) => (
                <div key={run.runId}>
                  <AutomationRunSummary
                    run={run}
                    isLatestRevertible={isRevertible(run)}
                    busy={revertingRunId === run.runId}
                    disabled={actionsDisabled}
                    isRetryable={runs[0]?.runId === run.runId && run.status === 'failed'}
                    retrying={retryingRunId === run.runId}
                    onAcknowledge={() => onAcknowledgeRun(run.runId)}
                    onRevert={() => onRevertRun(run.runId)}
                    onRetry={() => onRetryRun(run.runId)}
                  />
                  {(patchesByAutomationRunId.get(run.runId) ?? []).map((patch) => (
                    <RefinePatchCard
                      key={patch.patchId}
                      patch={patch}
                      characters={characters}
                      busy={busyPatchId === patch.patchId}
                      disabled={patchActionDisabled}
                      onApply={() => onApplyPatch(patch.patchId)}
                      onReject={() => onRejectPatch(patch.patchId)}
                      onDiscussAdjustment={() => onDiscussAdjustment(patch)}
                      automationRun={run}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}

          {messageCount === 0 && (
            <ConversationEmptyState onStartTopic={onStartTopic} disabled={sending || actionsDisabled} />
          )}

          {session?.messages.map((message) => {
            const run = message.automationRunId
              ? runsByRunId.get(message.automationRunId)
              : undefined;
            return (
              <div key={message.messageId} className="refine-conversation-turn">
                <ChatBubble message={message} />
                {message.suggestedActions && message.suggestedActions.length > 0 && (
                  <RefineSuggestedActions
                    actions={message.suggestedActions}
                    interactive={interactiveActionsMessageId === message.messageId}
                    disabled={sending || busyPatchId !== null || actionsDisabled}
                    onSelect={onSelectSuggestedAction}
                  />
                )}
                {run && (
                  <AutomationRunSummary
                    run={run}
                    isLatestRevertible={isRevertible(run)}
                    busy={revertingRunId === run.runId}
                    disabled={actionsDisabled}
                    isRetryable={runs[0]?.runId === run.runId && run.status === 'failed'}
                    retrying={retryingRunId === run.runId}
                    onAcknowledge={() => onAcknowledgeRun(run.runId)}
                    onRevert={() => onRevertRun(run.runId)}
                    onRetry={() => onRetryRun(run.runId)}
                  />
                )}
                {(patchesByMessageId.get(message.messageId) ?? []).map((patch) => (
                  <RefinePatchCard
                    key={patch.patchId}
                    patch={patch}
                    characters={characters}
                    busy={busyPatchId === patch.patchId}
                    disabled={patchActionDisabled}
                    onApply={() => onApplyPatch(patch.patchId)}
                    onReject={() => onRejectPatch(patch.patchId)}
                    onDiscussAdjustment={() => onDiscussAdjustment(patch)}
                    automationRun={run}
                  />
                ))}
              </div>
            );
          })}
          {sending && <p className="refine-conversation-pending">AI が考えています…</p>}
        </div>
      </div>
      {hasNewReply && (
        <button
          type="button"
          className="refine-new-reply-button"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            setHasNewReply(false);
          }}
        >
          新しい返答 ↓
        </button>
      )}
    </div>
  );
}

function ConversationEmptyState({
  onStartTopic,
  disabled,
}: {
  onStartTopic: (starter: ConversationStarter) => void;
  disabled: boolean;
}) {
  return (
    <div className="refine-conversation-empty">
      <p className="summary-empty">
        まだ相談していません。感じていることをそのまま書いても、下のボタンから始めても構いません。
        「この人物が薄い気がする」「なんとなく物足りない」のような曖昧な言い方で大丈夫です。
      </p>
      <div className="refine-conversation-starters">
        {CONVERSATION_STARTERS.map((starter) => (
          <button
            key={starter.label}
            type="button"
            disabled={disabled}
            onClick={() => onStartTopic(starter)}
          >
            {starter.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: RefineMessage }) {
  const roleLabel =
    message.role === 'user' ? 'あなた' : message.role === 'assistant' ? 'AI' : 'システム';
  return (
    <article className={`refine-chat-bubble role-${message.role}`}>
      <div className="refine-chat-role">{roleLabel}</div>
      {message.role === 'assistant' ? (
        // NOTE: LightMarkdown は見出し・段落・箇条書き・太字・水平線だけを解釈する。
        // 生 HTML / 画像 / リンク / script は解釈せず、dangerouslySetInnerHTML も使わない。
        <div className="refine-chat-content">
          <LightMarkdown text={message.content} />
        </div>
      ) : (
        <p className="refine-chat-content">{message.content}</p>
      )}
    </article>
  );
}
