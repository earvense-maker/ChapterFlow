// 妄想増幅器・小説 advance オーケストレーション（設計書 4.4 / 13.2）
//
// NOTE: UI は小説の方向選択で既存 accept と generate を個別に呼ばない。専用
// novel/advance-stream が、InteractionEvent の冪等保存、アンカー再検証、暗黙採用、
// pendingAdvance 予約、次場面生成をオーケストレーションする。
//
// 必ず prepare/reserve -> generate -> commit に分け、prepare/reserve と commit だけが
// project lock を取る。本文のモデル呼び出しはロック外（設計書 12.1）。
//
// 冪等性（設計書 12.3）:
//  - 同じ clientEventId の再送は既存イベントを返し、二重記録しない。
//  - lease が failed なら同じ operationId / 同じイベントで再試行できる。
//  - lease が complete なら保存済み生成をリプレイする。
//  - 別方向へ変更する場合だけ旧 advance を cancelled にして新イベントを作る。

import { nowIso } from '../utils/date.js';
import { generateTimestampId } from '../utils/id.js';
import { withProjectWriteLock } from './projectLock.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import * as amplifier from './amplifierService.js';
import { createTurnForAnchor } from './amplifierChoiceService.js';
import { requestProjectInterpretation } from './desireInterpreterService.js';
import * as generationService from './generationService.js';
import type {
  AmplifierAnchor,
  AmplifierDirectionInput,
  AmplifierProjectNotebook,
  GenerationRecord,
} from '../types/index.js';

const storage = localProjectStorage();

export class NovelAdvanceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(message);
    this.name = 'NovelAdvanceError';
  }
}

export interface BeginNovelAdvanceInput {
  projectId: string;
  clientEventId: string;
  turnId: string;
  turnRevision: number;
  anchor: AmplifierAnchor;
  direction: AmplifierDirectionInput;
}

export interface NovelAdvanceReservation {
  operationId: string;
  interactionEventId: string;
  sourceTurnId: string;
  acceptedGenerationId: string;
  anchor: AmplifierAnchor;
  direction: string;
  contextKey: string;
  replay?: { record: GenerationRecord };
}

export interface BeginNovelAdvanceResult {
  reservation: NovelAdvanceReservation;
}

// NOTE: direction 入力の検証は amplifierService.normalizeAmplifierDirectionInput に
// 共通化した（小説 advance とロールプレイ amplifier-turn で同じ規則。レビュー指摘:
// 検証前にイベント保存・turn消費をしない）。

// NOTE: prepare/reserve 段階（設計書 13.2）。project lock 内で event 保存・アンカー再検証・
// 暗黙採用・pendingAdvance lease 予約までを行い、ロックを解放する。暗黙採用の派生処理
// （story state更新・要約など）はロック外で runAcceptanceDerivedProcessing が起動する。
export async function beginNovelAdvance(
  input: BeginNovelAdvanceInput
): Promise<BeginNovelAdvanceResult> {
  const { projectId } = input;
  await amplifier.assertAmplifierProject(projectId);

  const locked = await withProjectWriteLock(projectId, async (): Promise<{
    reservation: NovelAdvanceReservation;
    acceptResult: generationService.AcceptGenerationResult | null;
  }> => {
    await amplifier.assertAmplifierProject(projectId);
    const notebook = await amplifier.readNotebook(projectId);
    const lease = amplifier.normalizeExpiredLease(notebook.pendingAdvance);

    // --- 冪等チェック（設計書 12.3） ---
    const existingEvent = await amplifier.findEventByClientId(projectId, input.clientEventId);
    if (existingEvent) {
      if (lease && lease.interactionEventId === existingEvent.eventId) {
        if (lease.status === 'generating' || lease.status === 'reserved') {
          throw new NovelAdvanceError(
            'この方向の場面生成が進行中です。',
            'amplifier_advance_in_progress',
            true,
            409
          );
        }
        if (lease.status === 'complete' && lease.resultGenerationId) {
          const record = await generationService.findGeneration(
            projectId,
            lease.resultGenerationId
          );
          if (record) {
            return {
              reservation: {
                operationId: lease.operationId,
                interactionEventId: existingEvent.eventId,
                sourceTurnId: lease.sourceTurnId,
                acceptedGenerationId: lease.acceptedGenerationId,
                anchor: existingEvent.anchor,
                direction: '',
                contextKey: existingEvent.contextKey,
                replay: { record },
              },
              acceptResult: null,
            };
          }
        }
        if (lease.status === 'failed' || lease.status === 'cancelled') {
          // 失敗からの再試行: 同じイベントを使い、lease を reserved へ戻す
          const refreshed = await amplifier.updateAdvanceLeaseUnlocked(projectId, notebook, {
            status: 'reserved',
            errorCode: undefined,
            leaseExpiresAt: new Date(Date.now() + amplifier.ADVANCE_LEASE_MS).toISOString(),
          });
          const pending = refreshed.pendingAdvance!;
          const direction = await resolveDirectionText(projectId, existingEvent.eventId);
          return {
            reservation: {
              operationId: pending.operationId,
              interactionEventId: existingEvent.eventId,
              sourceTurnId: pending.sourceTurnId,
              acceptedGenerationId: pending.acceptedGenerationId,
              anchor: existingEvent.anchor,
              direction,
              contextKey: existingEvent.contextKey,
            },
            acceptResult: null,
          };
        }
      }
      // event はあるが lease が見つからない（クラッシュ復帰）→ 新規 lease で続行
      const turn = await amplifier.readTurn(projectId, input.turnId);
      if (!turn || turn.status === 'consumed' || turn.status === 'superseded') {
        throw new NovelAdvanceError(
          'この選択肢は既に使われています。再読み込みしてください。',
          'amplifier_turn_stale',
          false,
          409
        );
      }
      const crashRecoveryGenerationId =
        input.anchor.kind === 'novel' ? input.anchor.generationId : null;
      if (!crashRecoveryGenerationId) {
        throw new NovelAdvanceError('アンカーが不正です。', 'invalid_anchor', false, 400);
      }
      const recovery = await reserveFreshLeaseAndReturn(
        projectId,
        notebook,
        existingEvent,
        turn,
        crashRecoveryGenerationId
      );
      return { reservation: recovery.reservation, acceptResult: null };
    }

    if (lease && lease.status !== 'complete' && lease.status !== 'failed' && lease.status !== 'cancelled') {
      throw new NovelAdvanceError(
        '別の方向選択の場面生成が進行中です。',
        'amplifier_advance_in_progress',
        true,
        409
      );
    }

    // --- ターンとアンカーの検証（設計書 8.2 / 13.2） ---
    const turn = await amplifier.readTurn(projectId, input.turnId);
    if (!turn) {
      throw new NovelAdvanceError('選択肢が見つかりません。', 'amplifier_turn_not_found', false, 404);
    }
    if (turn.status !== 'ready') {
      throw new NovelAdvanceError(
        turn.status === 'consumed' ? 'この選択肢は既に使われています。' : '選択肢がまだ準備できていません。',
        'amplifier_turn_not_ready',
        false,
        409
      );
    }
    if (turn.revision !== input.turnRevision) {
      throw new NovelAdvanceError(
        '選択肢が別の操作で更新されています。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }
    const anchor = normalizeAnchorEquality(input.anchor, turn.anchor);
    if (!anchor) {
      throw new NovelAdvanceError(
        '本文が更新されているため、この選択肢は使えません。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }
    if (anchor.kind !== 'novel') {
      throw new NovelAdvanceError('アンカーが不正です。', 'invalid_anchor', false, 400);
    }
    const generationId = anchor.generationId;
    const resolved = await amplifier.resolveEffectiveAnchorText(projectId, anchor);
    if (
      !resolved.ok ||
      !amplifier.verifyAnchorAgainstCurrent(anchor, resolved, turn.anchorTextHash)
    ) {
      throw new NovelAdvanceError(
        '本文が更新されているため、この選択肢は使えません。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }
    const state = await storage.readState(projectId);
    if (state?.selectedDraftGenerationId !== generationId) {
      throw new NovelAdvanceError(
        '現在の本文と一致しないため、この選択肢は使えません。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }

    // --- イベント保存（advance 開始前・設計書 7.4） ---
    // NOTE: 方向の検証を先に済ませてから保存する（不正入力でイベントやturnを消費しない）。
    const normalized = amplifier.normalizeAmplifierDirectionInput(input.direction, turn);
    const { event } = await amplifier.recordInteractionUnlocked(projectId, {
      clientEventId: input.clientEventId,
      mode: 'novel',
      type: normalized.type,
      anchor,
      turnId: turn.turnId,
      payload: normalized.payload,
      excludeFromGlobalLearning: !notebook.learningEnabled,
      contextKey: turn.contextKey,
    });

    // --- ターンを consumed に ---
    const consumed: typeof turn = {
      ...turn,
      status: 'consumed',
      consumedByEventId: event.eventId,
      updatedAt: nowIso(),
    };
    await amplifier.writeTurn(projectId, consumed);

    // --- 既存 acceptGeneration と同じ規則で採用（設計書 4.4 step 3） ---
    let acceptResult: generationService.AcceptGenerationResult | null = null;
    try {
      acceptResult = await generationService.acceptGenerationUnlocked(projectId, generationId);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'generation_not_selected' || code === 'generation_failed') {
        throw new NovelAdvanceError(
          '現在の本文と一致しないため、この選択肢は使えません。再読み込みしてください。',
          'amplifier_turn_stale',
          false,
          409
        );
      }
      throw err;
    }

    // --- pendingAdvance lease 予約 ---
    const reserved = await reserveFreshLeaseAndReturn(projectId, notebook, event, turn, generationId);
    return { reservation: reserved.reservation, acceptResult };
  });

  // NOTE: 暗黙採用の派生処理（story state更新・要約・maintenance継続・trace解析）を
  // ロックを離してから起動する（レビュー指摘: 起動しないと story state が pending の
  // まま残る）。通常採用の acceptGeneration と同じ処理を共有する。
  if (locked.acceptResult) {
    void generationService.runAcceptanceDerivedProcessing(projectId, locked.acceptResult);
  }
  return { reservation: locked.reservation };
}

function normalizeAnchorEquality(
  clientAnchor: AmplifierAnchor,
  serverAnchor: AmplifierAnchor
): AmplifierAnchor | null {
  if (clientAnchor.kind !== serverAnchor.kind) return null;
  if (clientAnchor.kind === 'novel') {
    // NOTE: clientAnchor.kind の絞り込みは serverAnchor へ伝播しないため、
    // 同じ kind である事実（上の一致チェック）を明示的なキャストで反映する。
    const client = clientAnchor;
    const server = serverAnchor as Extract<AmplifierAnchor, { kind: 'novel' }>;
    if (
      client.generationId === server.generationId &&
      client.textRevisionNumber === server.textRevisionNumber
    ) {
      return { kind: 'novel', generationId: server.generationId, textRevisionNumber: server.textRevisionNumber };
    }
    return null;
  }
  const client = clientAnchor;
  const server = serverAnchor as Extract<AmplifierAnchor, { kind: 'roleplay' }>;
  if (
    client.sessionId === server.sessionId &&
    client.messageId === server.messageId &&
    client.contentRevision === server.contentRevision
  ) {
    return {
      kind: 'roleplay',
      sessionId: server.sessionId,
      messageId: server.messageId,
      contentRevision: server.contentRevision,
    };
  }
  return null;
}

async function reserveFreshLeaseAndReturn(
  projectId: string,
  notebook: AmplifierProjectNotebook,
  event: { eventId: string; contextKey: string; anchor: AmplifierAnchor },
  turn: { turnId: string },
  acceptedGenerationId: string
): Promise<{ reservation: NovelAdvanceReservation }> {
  const operationId = generateTimestampId('amp-op');
  await amplifier.reserveNovelAdvanceUnlocked({
    projectId,
    operationId,
    interactionEventId: event.eventId,
    sourceTurnId: turn.turnId,
    acceptedGenerationId,
    notebook,
  });
  const direction = await resolveDirectionText(projectId, event.eventId);
  return {
    reservation: {
      operationId,
      interactionEventId: event.eventId,
      sourceTurnId: turn.turnId,
      acceptedGenerationId,
      anchor: event.anchor,
      direction,
      contextKey: event.contextKey,
    },
  };
}

// NOTE: 方向テキストの解決。choice はサーバー保存値から（モデル・クライアント入力を
// 信用しない）。プロジェクトロック内で読むので accept 後の state と整合する。
async function resolveDirectionText(projectId: string, eventId: string): Promise<string> {
  const event = await amplifier.findEventById(projectId, eventId);
  if (!event) return '';
  return amplifier.resolveAmplifierDirection(projectId, event);
}

// --- 生成完了後の派生処理（設計書 4.4 step 6） ---
// NOTE: lease の complete 遷移は generateSceneStreamForAdvance の commit が行う。
// ここは新しい選択肢の非同期生成と解釈予約だけを担当する。

export async function afterAdvanceGeneration(input: {
  projectId: string;
  resultGenerationId: string;
}): Promise<void> {
  // NOTE: 次場面の保存後、新しい選択肢を非同期生成する（設計書 4.4 step 6）。
  // 生成中に作品が削除された場合、削除済みディレクトリを再作成しないよう入口で確認する。
  void (async () => {
    if (!(await storage.projectExists(input.projectId))) return;
    await createTurnForAnchor(input.projectId, {
      kind: 'novel',
      generationId: input.resultGenerationId,
      textRevisionNumber: 0,
    }).catch((error) => {
      console.warn('Failed to create amplifier turn after advance generation', {
        projectId: input.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  })();
  void requestProjectInterpretation(input.projectId);
}

export async function failNovelAdvance(input: {
  projectId: string;
  operationId: string;
  errorCode?: string;
}): Promise<void> {
  await withProjectWriteLock(input.projectId, async () => {
    const notebook = await amplifier.readNotebook(input.projectId);
    const lease = amplifier.normalizeExpiredLease(notebook.pendingAdvance);
    if (!lease || lease.operationId !== input.operationId) return;
    if (lease.status === 'complete') return;
    await amplifier.updateAdvanceLeaseUnlocked(input.projectId, notebook, {
      status: 'failed',
      errorCode: input.errorCode ?? 'advance_failed',
    });
  });
  // NOTE: 失敗しても選択済みの現在場面は採用状態のまま残す（設計書 4.4）。
}

export async function cancelNovelAdvance(input: {
  projectId: string;
  operationId: string;
}): Promise<void> {
  await withProjectWriteLock(input.projectId, async () => {
    const notebook = await amplifier.readNotebook(input.projectId);
    const lease = amplifier.normalizeExpiredLease(notebook.pendingAdvance);
    if (!lease || lease.operationId !== input.operationId) return;
    if (lease.status === 'complete') return;
    await amplifier.updateAdvanceLeaseUnlocked(input.projectId, notebook, {
      status: 'cancelled',
      errorCode: 'advance_cancelled',
    });
  });
}
