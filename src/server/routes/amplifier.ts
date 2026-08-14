// 妄想増幅器のプロジェクト内 API（設計書 13.1 / 13.2）
//
// NOTE: POST /turns はクライアントから本文を受け取らない。アンカーIDと期待改訂だけを
// 受け、サーバーが保存済み本文を読む（設計書 13.1）。選択肢のラベル・本文はクライアント
// から信用せず、turnId からサーバー保存値を解決する。
//
// novel/advance-stream の SSE は、InteractionEvent の冪等保存・アンカー再検証・暗黙採用・
// pendingAdvance 予約・次場面生成を1リクエストでオーケストレーションする。本文のモデル
// 呼び出し中はプロジェクトロックを保持しない（設計書 12.1）。

import { Router } from 'express';
import * as amplifierService from '../services/amplifierService.js';
import * as amplifierChoiceService from '../services/amplifierChoiceService.js';
import * as amplifierNovelAdvanceService from '../services/amplifierNovelAdvanceService.js';
import { retryProjectInterpretation } from '../services/desireInterpreterService.js';
import * as generationService from '../services/generationService.js';
import type {
  AmplifierDirectionInput,
  AmplifierNovelAdvanceBody,
  CreateAmplifierTurnBody,
  RecordDirectionRejectionBody,
  RequestAmplifierTurnAlternativesBody,
} from '../types/index.js';

const router = Router();

function handleAmplifierError(
  err: unknown,
  res: import('express').Response,
  next: (err: unknown) => void
): void {
  if (
    err instanceof amplifierService.AmplifierServiceError ||
    err instanceof amplifierChoiceService.AmplifierChoiceError ||
    err instanceof amplifierNovelAdvanceService.NovelAdvanceError
  ) {
    res.status(err.status).json({ error: err.message, code: err.code, retryable: err.retryable });
    return;
  }
  next(err);
}

// --- 状態取得 ---

router.get('/projects/:id/amplifier/state', async (req, res, next) => {
  try {
    const kind = req.query.kind === 'roleplay' ? 'roleplay' : 'novel';
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
    const state = await amplifierService.getAmplifierState(req.params.id, { kind, sessionId });
    res.json(state);
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

// --- ターン作成（選択肢生成・設計書 12.2） ---

router.post('/projects/:id/amplifier/turns', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as CreateAmplifierTurnBody;
    const anchor = amplifierService.normalizeAnchor(body.anchor);
    const result = await amplifierChoiceService.createTurnForAnchor(req.params.id, anchor);
    res.status(201).json({ turn: result.turn });
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

router.post(
  '/projects/:id/amplifier/turns/:turnId/alternatives',
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as RequestAmplifierTurnAlternativesBody;
      if (typeof body.clientEventId !== 'string' || !body.clientEventId.trim()) {
        return res.status(400).json({ error: 'clientEventId is required', code: 'invalid_request' });
      }
      if (typeof body.expectedTurnRevision !== 'number') {
        return res.status(400).json({ error: 'expectedTurnRevision is required', code: 'invalid_request' });
      }
      const result = await amplifierChoiceService.createTurnAlternatives({
        projectId: req.params.id,
        turnId: req.params.turnId,
        clientEventId: body.clientEventId,
        expectedTurnRevision: body.expectedTurnRevision,
      });
      res.status(201).json({ turn: result.turn });
    } catch (err) {
      handleAmplifierError(err, res, next);
    }
  }
);

// NOTE: 汎用 POST /interactions は、生成を開始しない direction_rejected の記録だけに
// 使う（設計書 13.1）。クライアントが任意の event type を直接指定できるAPIにはしない。
router.post(
  '/projects/:id/amplifier/turns/:turnId/interactions',
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as RecordDirectionRejectionBody;
      if (typeof body.clientEventId !== 'string' || !body.clientEventId.trim()) {
        return res.status(400).json({ error: 'clientEventId is required', code: 'invalid_request' });
      }
      if (typeof body.expectedTurnRevision !== 'number') {
        return res.status(400).json({ error: 'expectedTurnRevision is required', code: 'invalid_request' });
      }
      await amplifierChoiceService.recordDirectionRejection({
        projectId: req.params.id,
        turnId: req.params.turnId,
        clientEventId: body.clientEventId,
        expectedTurnRevision: body.expectedTurnRevision,
        reason: typeof body.reason === 'string' ? body.reason : undefined,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      handleAmplifierError(err, res, next);
    }
  }
);

// --- お気に入り（設計書 7.4） ---

router.post('/projects/:id/amplifier/favorites', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      clientEventId?: unknown;
      scope?: unknown;
      anchor?: unknown;
      excerpt?: unknown;
    };
    if (typeof body.clientEventId !== 'string' || !body.clientEventId.trim()) {
      return res.status(400).json({ error: 'clientEventId is required', code: 'invalid_request' });
    }
    if (body.scope !== 'whole' && body.scope !== 'selection') {
      return res.status(400).json({ error: 'scope must be whole or selection', code: 'invalid_request' });
    }
    const anchor = amplifierService.normalizeAnchor(body.anchor);
    const event = await amplifierService.recordFavorite({
      projectId: req.params.id,
      clientEventId: body.clientEventId,
      scope: body.scope,
      anchor,
      excerpt: typeof body.excerpt === 'string' ? body.excerpt : undefined,
    });
    res.status(201).json({ event });
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

// --- 小説 advance（設計書 4.4 / 13.2） ---

router.post('/projects/:id/amplifier/novel/advance-stream', async (req, res) => {
  const projectId = req.params.id;
  const body = (req.body ?? {}) as AmplifierNovelAdvanceBody;

  const abortController = new AbortController();
  let headersSent = false;
  let completed = false;

  const handleClose = () => {
    if (!completed) abortController.abort();
  };
  req.on('aborted', handleClose);
  res.on('close', handleClose);

  const send = (event: string, data: unknown) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // NOTE: 失敗時は lease を failed にして同じ方向で再試行できるようにする（設計書 4.4）。
  const failAdvance = async (operationId: string | undefined, code: string) => {
    if (!operationId) return;
    try {
      await amplifierNovelAdvanceService.failNovelAdvance({ projectId, operationId, errorCode: code });
    } catch (error) {
      console.warn('Failed to persist amplifier advance failure', {
        projectId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  let reservation: Awaited<ReturnType<typeof amplifierNovelAdvanceService.beginNovelAdvance>>['reservation'] | null = null;
  try {
    if (
      typeof body.clientEventId !== 'string' ||
      !body.clientEventId.trim() ||
      typeof body.turnId !== 'string' ||
      !body.turnId ||
      typeof body.turnRevision !== 'number' ||
      typeof body.anchor !== 'object' ||
      body.anchor === null
    ) {
      return res.status(400).json({ error: 'Invalid advance request', code: 'invalid_request' });
    }
    const anchor = amplifierService.normalizeAnchor(body.anchor);
    const direction = body as unknown as AmplifierDirectionInput;
    // NOTE: 開始側（event保存・アンカー再検証・暗黙採用・lease予約）はヘッダー送信前に
    // 完了させる。失敗は JSON エラーで返す（roleplay の beginTurn と同じコミット境界）。
    reservation = (
      await amplifierNovelAdvanceService.beginNovelAdvance({
        projectId,
        clientEventId: body.clientEventId,
        turnId: body.turnId,
        turnRevision: body.turnRevision,
        anchor,
        direction,
      })
    ).reservation;

    // 冪等リプレイ: 保存済み生成があればその本文をそのまま流す
    if (reservation.replay) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      headersSent = true;
      send('chunk', { text: reservation.replay.record.responseText });
      send('done', { record: reservation.replay.record });
      completed = true;
      res.end();
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    headersSent = true;

    // NOTE: 次場面生成を開始。prepare/commit だけが project lock を取り、本文のモデル
    // 呼び出し中はロックを保持しない（設計書 12.2 / 13.2）。commit が lease の検証と
    // complete 遷移まで行うため、ルート側の個別 commit は不要。
    const record = await generationService.generateSceneStreamForAdvance(
      projectId,
      {
        wish: reservation.direction,
        mode: 'continue',
        amplifierInteractionId: reservation.interactionEventId,
        amplifierOperationId: reservation.operationId,
        abortSignal: abortController.signal,
      },
      (chunk) => send('chunk', { text: chunk })
    );
    // NOTE: 新しい選択肢の非同期生成と解釈予約（設計書 4.4 step 6）。失敗しても
    // 本文は失わない。
    void amplifierNovelAdvanceService
      .afterAdvanceGeneration({ projectId, resultGenerationId: record.generationId })
      .catch((error) => {
        console.warn('Failed to start post-advance processing', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    send('done', { record });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'advance_failed';
    // NOTE: 次場面生成に失敗しても、選択済みの現在場面は採用状態のまま残す（設計書 4.4）。
    // error を返す前に failed を確定し、受信直後の再試行が一時的な409にならないようにする。
    await failAdvance(reservation?.operationId, code);
    if (!headersSent) {
      if (
        err instanceof amplifierService.AmplifierServiceError ||
        err instanceof amplifierChoiceService.AmplifierChoiceError ||
        err instanceof amplifierNovelAdvanceService.NovelAdvanceError
      ) {
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code, retryable: err.retryable });
      }
      return res.status(500).json({
        error: err instanceof Error ? err.message : '場面生成に失敗しました。',
        code,
        retryable: true,
      });
    }
    send('error', {
      error: err instanceof Error ? err.message : '場面生成に失敗しました。',
      code,
      retryable: true,
    });
  } finally {
    completed = true;
    req.off('aborted', handleClose);
    res.off('close', handleClose);
    if (headersSent && !res.writableEnded && !res.destroyed) res.end();
  }
});

// --- 嗜好メモ（設計書 14.2） ---

router.get('/projects/:id/amplifier/preferences', async (req, res, next) => {
  try {
    res.json(await amplifierService.getProjectPreferences(req.params.id));
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

router.put('/projects/:id/amplifier/preferences', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      addCorrections?: unknown;
      withdrawCorrectionIds?: unknown;
      deleteMemoIds?: unknown;
      projectBoundary?: unknown;
      resetCurrentContextKeys?: unknown;
      learningEnabled?: unknown;
    };
    res.json(
      await amplifierService.updateProjectPreferences(req.params.id, {
        addCorrections: body.addCorrections as never,
        withdrawCorrectionIds: Array.isArray(body.withdrawCorrectionIds)
          ? (body.withdrawCorrectionIds as string[])
          : undefined,
        deleteMemoIds: Array.isArray(body.deleteMemoIds)
          ? (body.deleteMemoIds as string[])
          : undefined,
        projectBoundary:
          body.projectBoundary === undefined
            ? undefined
            : typeof body.projectBoundary === 'string'
              ? body.projectBoundary
              : null,
        resetCurrentContextKeys: Array.isArray(body.resetCurrentContextKeys)
          ? (body.resetCurrentContextKeys as string[])
          : undefined,
        learningEnabled:
          typeof body.learningEnabled === 'boolean' ? body.learningEnabled : undefined,
      })
    );
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

router.post('/projects/:id/amplifier/preferences/retry', async (req, res, next) => {
  try {
    await retryProjectInterpretation(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleAmplifierError(err, res, next);
  }
});

export default router;
