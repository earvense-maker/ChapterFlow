// NOTE: ロールプレイセッションの HTTP ルート（設計書 3.6）。
//
// SSE のコミット境界:
//  - 開始トランザクション（入力・project/session・revision 検査、user 保存）は
//    JSON エラーで返す。ヘッダー送信前に失敗判定を済ませてから SSE を張る。
//  - SSE ヘッダー送信後の失敗は error event として流す。error は最新 revision を
//    含み、クライアントは GET で再同期してから再試行する。
//  - 保存成功で `done` を送る。切断や error では character メッセージは非保存で残る。

import { Router } from 'express';
import * as roleplayService from '../services/roleplaySessionService.js';
import { AmplifierServiceError, normalizeAnchor } from '../services/amplifierService.js';
import type {
  AmplifierRoleplayAdvanceBody,
  ArchiveRoleplaySessionBody,
  CreateRoleplaySessionBody,
  EditRoleplayMessageBody,
  RegenerateRoleplayBody,
  SendRoleplayMessageBody,
  RestoreRoleplayMessageBody,
} from '../types/index.js';

const router = Router();

router.post('/projects/:id/roleplay/sessions', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as CreateRoleplaySessionBody;
    if (body.sessionMode !== undefined && body.sessionMode !== 'roleplay' && body.sessionMode !== 'dream') {
      return res
        .status(400)
        .json({ error: "sessionMode must be 'roleplay' or 'dream'", code: 'invalid_request' });
    }
    // NOTE: 夢見るモードはキャラクター選択を出さないため characterId 省略を許し、サーバー
    // 側で先頭キャラクターを視点アンカーとして解決する（設計書 §5）。通常 roleplay は
    // 従来どおり必須。
    const isDream = body.sessionMode === 'dream';
    if (
      (!isDream && (typeof body.characterId !== 'string' || !body.characterId.trim())) ||
      (isDream && body.characterId !== undefined && typeof body.characterId !== 'string')
    ) {
      return res.status(400).json({ error: 'characterId is required', code: 'invalid_request' });
    }
    if (body.scenario !== undefined && typeof body.scenario !== 'string') {
      return res.status(400).json({ error: 'scenario must be a string', code: 'invalid_request' });
    }
    const view = await roleplayService.createRoleplaySession({
      projectId: req.params.id,
      characterId: body.characterId ?? '',
      scenario: body.scenario,
      userPersona: body.userPersona,
      excludeFromGlobalLearning: body.excludeFromGlobalLearning === true,
      sessionMode: body.sessionMode,
    });
    res.status(201).json({ session: view });
  } catch (err) {
    if (err instanceof roleplayService.RoleplayServiceError) {
      return handleRoleplayError(err, res);
    }
    next(err);
  }
});

router.get('/projects/:id/roleplay/sessions', async (req, res, next) => {
  try {
    const sessions = await roleplayService.listRoleplaySessions(req.params.id);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

router.get('/projects/:id/roleplay/sessions/:sessionId', async (req, res, next) => {
  try {
    const view = await roleplayService.getRoleplaySession(req.params.id, req.params.sessionId);
    res.json({ session: view });
  } catch (err) {
    if (err instanceof roleplayService.RoleplayServiceError) {
      return handleRoleplayError(err, res);
    }
    next(err);
  }
});

router.delete('/projects/:id/roleplay/sessions/:sessionId', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as ArchiveRoleplaySessionBody;
    const view = await roleplayService.archiveRoleplaySession(
      req.params.id,
      req.params.sessionId,
      body.revision
    );
    res.json({ session: view });
  } catch (err) {
    if (err instanceof roleplayService.RoleplayServiceError) {
      return handleRoleplayError(err, res);
    }
    next(err);
  }
});

router.patch(
  '/projects/:id/roleplay/sessions/:sessionId/messages/:messageId',
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as EditRoleplayMessageBody;
      const result = await roleplayService.editRoleplayMessage({
        projectId: req.params.id,
        sessionId: req.params.sessionId,
        messageId: req.params.messageId,
        content: body.content,
        expectedSessionRevision: body.expectedSessionRevision,
        expectedMessageRevision: body.expectedMessageRevision,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof roleplayService.RoleplayServiceError) return handleRoleplayError(err, res);
      next(err);
    }
  }
);

router.get(
  '/projects/:id/roleplay/sessions/:sessionId/messages/:messageId/revisions',
  async (req, res, next) => {
    try {
      const result = await roleplayService.getRoleplayMessageRevisions(
        req.params.id,
        req.params.sessionId,
        req.params.messageId
      );
      res.json(result);
    } catch (err) {
      if (err instanceof roleplayService.RoleplayServiceError) return handleRoleplayError(err, res);
      next(err);
    }
  }
);

router.post(
  '/projects/:id/roleplay/sessions/:sessionId/messages/:messageId/revisions/:revisionId/restore',
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as RestoreRoleplayMessageBody;
      const result = await roleplayService.restoreRoleplayMessageRevision({
        projectId: req.params.id,
        sessionId: req.params.sessionId,
        messageId: req.params.messageId,
        revisionId: req.params.revisionId,
        expectedSessionRevision: body.expectedSessionRevision,
        expectedMessageRevision: body.expectedMessageRevision,
      });
      res.json(result);
    } catch (err) {
      if (err instanceof roleplayService.RoleplayServiceError) return handleRoleplayError(err, res);
      next(err);
    }
  }
);

router.post(
  '/projects/:id/roleplay/sessions/:sessionId/memory-rebuild',
  async (req, res, next) => {
    try {
      const session = await roleplayService.retryRoleplayMemoryRebuild(
        req.params.id,
        req.params.sessionId
      );
      res.json({ session });
    } catch (err) {
      if (err instanceof roleplayService.RoleplayServiceError) return handleRoleplayError(err, res);
      next(err);
    }
  }
);

router.post(
  '/projects/:id/roleplay/sessions/:sessionId/messages-stream',
  async (req, res) => {
    await runStreamRoute(req, res, 'send');
  }
);

router.post(
  '/projects/:id/roleplay/sessions/:sessionId/regenerate-stream',
  async (req, res) => {
    await runStreamRoute(req, res, 'regenerate');
  }
);

// NOTE: 妄想増幅器のロールプレイ進行（設計書 13.3）。turn、選択内容、clientEventId を
// 受け、InteractionEvent 保存からキャラクター応答までを扱う専用ストリーム経路。
// メタ方向は通常ユーザー発言として保存しない（設計書 4.5）。
router.post(
  '/projects/:id/roleplay/sessions/:sessionId/amplifier-turn-stream',
  async (req, res) => {
    await runStreamRoute(req, res, 'amplifier');
  }
);

async function runStreamRoute(
  req: import('express').Request,
  res: import('express').Response,
  kind: 'send' | 'regenerate' | 'amplifier'
): Promise<void> {
  const projectId = req.params.id;
  const sessionId = req.params.sessionId;
  const body = (req.body ?? {}) as
    | SendRoleplayMessageBody
    | RegenerateRoleplayBody
    | AmplifierRoleplayAdvanceBody;

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

  try {
    // NOTE: 開始側でストリームを取得。beginTurn が同期的に走るので、
    // ここで例外が投げられれば SSE を張らずに JSON エラーで返せる。
    let generator: AsyncGenerator<roleplayService.RoleplayStreamEvent>;
    if (kind === 'send') {
      const sendBody = body as SendRoleplayMessageBody;
      // NOTE: 夢の入力種別（設計書 §5）。欠損は 'text'。'observe' は dream セッションだけで
      // 受理される（service 側で検証）。
      if (
        sendBody.inputKind !== undefined &&
        sendBody.inputKind !== 'text' &&
        sendBody.inputKind !== 'observe'
      ) {
        res
          .status(400)
          .json({ error: "inputKind must be 'text' or 'observe'", code: 'invalid_request' });
        return;
      }
      generator = roleplayService.sendRoleplayMessage({
        projectId,
        sessionId,
        message: sendBody.message,
        inputKind: sendBody.inputKind,
        revision: sendBody.revision,
        replacePendingMessageId: sendBody.replacePendingMessageId,
        abortSignal: abortController.signal,
      });
    } else if (kind === 'regenerate') {
      const regenBody = body as RegenerateRoleplayBody;
      generator = roleplayService.regenerateRoleplay({
        projectId,
        sessionId,
        revision: regenBody.revision,
        abortSignal: abortController.signal,
      });
    } else {
      const amplifierBody = body as AmplifierRoleplayAdvanceBody;
      if (
        typeof amplifierBody.clientEventId !== 'string' ||
        !amplifierBody.clientEventId.trim() ||
        typeof amplifierBody.turnId !== 'string' ||
        !amplifierBody.turnId ||
        typeof amplifierBody.turnRevision !== 'number' ||
        typeof amplifierBody.sessionRevision !== 'number' ||
        typeof amplifierBody.anchor !== 'object' ||
        amplifierBody.anchor === null
      ) {
        res
          .status(400)
          .json({ error: 'Invalid amplifier turn request', code: 'invalid_request' });
        return;
      }
      const anchor = normalizeAnchor(amplifierBody.anchor);
      generator = roleplayService.sendAmplifierTurn({
        projectId,
        sessionId,
        revision: amplifierBody.sessionRevision,
        clientEventId: amplifierBody.clientEventId,
        turnId: amplifierBody.turnId,
        turnRevision: amplifierBody.turnRevision,
        anchor,
        direction: amplifierBody as unknown as import('../types/index.js').AmplifierDirectionInput,
        abortSignal: abortController.signal,
      });
    }

    // NOTE: 最初の event を先に取り出す。beginTurn の失敗はここに例外として現れる。
    const first = await generator.next();

    // beginTurn が成功したのでヘッダーを送る。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.flushHeaders?.();
    headersSent = true;

    const flushEvent = (event: roleplayService.RoleplayStreamEvent) => {
      if (event.type === 'chunk') send('chunk', { text: event.text });
      else if (event.type === 'postprocessing') send('postprocessing', {});
      else if (event.type === 'replace') send('replace', { text: event.text });
      else if (event.type === 'done') send('done', { session: event.session });
      else if (event.type === 'error') send('error', event.error);
    };

    if (!first.done) flushEvent(first.value);
    for await (const event of generator) {
      flushEvent(event);
    }
  } catch (err) {
    if (!headersSent) {
      if (err instanceof roleplayService.RoleplayServiceError) {
        return handleRoleplayError(err, res);
      }
      if (err instanceof AmplifierServiceError) {
        res.status(err.status).json({
          error: err.message,
          code: err.code,
          retryable: err.retryable,
        });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ロールプレイ応答に失敗しました。',
        code: 'roleplay_failed',
        retryable: true,
      });
      return;
    }
    if (err instanceof roleplayService.RoleplayServiceError) {
      send('error', {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        revision: err.revision,
      });
    } else if (err instanceof AmplifierServiceError) {
      send('error', {
        error: err.message,
        code: err.code,
        retryable: err.retryable,
      });
    } else {
      send('error', {
        error: err instanceof Error ? err.message : 'ロールプレイ応答に失敗しました。',
        code: 'roleplay_failed',
        retryable: true,
      });
    }
  } finally {
    completed = true;
    req.off('aborted', handleClose);
    res.off('close', handleClose);
    if (headersSent && !res.writableEnded && !res.destroyed) res.end();
  }
}

function handleRoleplayError(
  err: roleplayService.RoleplayServiceError,
  res: import('express').Response
): void {
  res.status(err.status).json({
    error: err.message,
    code: err.code,
    retryable: err.retryable,
    revision: err.revision,
  });
}

export default router;
