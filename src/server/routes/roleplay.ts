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
import type {
  ArchiveRoleplaySessionBody,
  CreateRoleplaySessionBody,
  RegenerateRoleplayBody,
  SendRoleplayMessageBody,
} from '../types/index.js';

const router = Router();

router.post('/projects/:id/roleplay/sessions', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as CreateRoleplaySessionBody;
    if (typeof body.characterId !== 'string' || !body.characterId.trim()) {
      return res.status(400).json({ error: 'characterId is required', code: 'invalid_request' });
    }
    if (body.scenario !== undefined && typeof body.scenario !== 'string') {
      return res.status(400).json({ error: 'scenario must be a string', code: 'invalid_request' });
    }
    const view = await roleplayService.createRoleplaySession({
      projectId: req.params.id,
      characterId: body.characterId,
      scenario: body.scenario,
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

async function runStreamRoute(
  req: import('express').Request,
  res: import('express').Response,
  kind: 'send' | 'regenerate'
): Promise<void> {
  const projectId = req.params.id;
  const sessionId = req.params.sessionId;
  const body = (req.body ?? {}) as SendRoleplayMessageBody | RegenerateRoleplayBody;

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
      generator = roleplayService.sendRoleplayMessage({
        projectId,
        sessionId,
        message: sendBody.message,
        revision: sendBody.revision,
        replacePendingMessageId: sendBody.replacePendingMessageId,
        abortSignal: abortController.signal,
      });
    } else {
      const regenBody = body as RegenerateRoleplayBody;
      generator = roleplayService.regenerateRoleplay({
        projectId,
        sessionId,
        revision: regenBody.revision,
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
