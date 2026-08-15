// 妄想増幅器のAPI統合テスト（設計書 18.2）
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app';
import { adapterMap } from '../../src/server/adapters/index';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import type {
  AdapterGenerateRequest,
  AdapterGenerateResult,
  AmplifierChoice,
  AmplifierTurn,
  GenerationRecord,
  Project,
} from '@shared/types';

let server: Server;
let baseUrl = '';
const amplifierChoiceRequests: AdapterGenerateRequest[] = [];
let amplifierChoiceOverride:
  | ((request: AdapterGenerateRequest) => Promise<AdapterGenerateResult>)
  | undefined;

function choicePromptResponse(): { text: string; finishReason: 'stop'; retryable: boolean } {
  const make = (strategy: 'exploit' | 'variation' | 'explore', label: string, description: string): AmplifierChoice => ({
    choiceId: `x-${strategy}`,
    strategy,
    label,
    description,
  });
  return {
    text: JSON.stringify({
      exploit: [make('exploit', 'もう少し近づく', '相手の本音が行動から少しだけ漏れる。')],
      variation: [make('variation', '別の表情を見る', '同じ距離感のまま、意外な弱さを覗かせる。')],
      explore: [make('explore', '空気を少し崩す', '小さな予想外で二人の反応を試す。')],
    }),
    finishReason: 'stop',
    retryable: false,
  };
}

beforeAll(async () => {
  vi.spyOn(adapterMap.gemini, 'generateText').mockImplementation(async (request) => {
    if (request.debugLabel === 'amplifier.choices') {
      amplifierChoiceRequests.push(request);
      if (amplifierChoiceOverride) return amplifierChoiceOverride(request);
      return choicePromptResponse();
    }
    return {
      text:
        request.responseMimeType === 'application/json'
          ? '{}'
          : `統合テスト用の本文: ${request.debugLabel ?? 'novel'}`,
      finishReason: 'stop',
      retryable: false,
    };
  });
  // NOTE: 本編・ロールプレイのストリーム経路も実ネットワークへ行かないようモックする。
  vi.spyOn(adapterMap.gemini, 'generateTextStream').mockImplementation(
    async function* generateTextStream(request) {
      yield { type: 'chunk', text: `ストリーム本文: ${request.debugLabel ?? 'novel'}` };
      yield { type: 'done', finishReason: 'stop' };
    }
  );
  const app = createApp({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('テストサーバーを起動できませんでした');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  vi.restoreAllMocks();
});

afterEach(() => {
  amplifierChoiceOverride = undefined;
});

async function createProject(body: Record<string, unknown>): Promise<Project> {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Project;
}

async function generateScene(projectId: string): Promise<GenerationRecord> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wish: '続きを書いて', mode: 'continue' }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as GenerationRecord;
}

async function createTurn(
  projectId: string,
  anchor: { kind: 'novel'; generationId: string; textRevisionNumber: number } | {
    kind: 'roleplay';
    sessionId: string;
    messageId: string;
    contentRevision: number;
  }
): Promise<AmplifierTurn> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/amplifier/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ anchor }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { turn: AmplifierTurn };
  return body.turn;
}

async function readSseBody(response: Response): Promise<string> {
  return response.text();
}

// NOTE: advance や応答保存の後にサーバーが非同期で走らせる解釈・選択肢生成・story state
// refresh 等が、テストの後片付け（プロジェクト削除）と競合しないよう完了を待つ
// （設計書 10.2 非阻害）。
async function waitForBackgroundSettled(projectId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const notebook = await storage.readAmplifierNotebook(projectId);
      expect(notebook?.interpreter.state).not.toBe('pending');
    },
    { timeout: 10_000 }
  );
}

// NOTE: Windows ではバックグラウンド書き込み（safeWrite の一時ファイル等）が削除と競合し、
// ENOTEMPTY / EPERM になり得る。短い遅延を挟んで再試行し、確実に後片付けする。
async function deleteProjectDirResilient(projectId: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await storage.deleteProjectDir(projectId);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT') return;
      if (attempt === 9) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describe('妄想増幅器 novel の選択ループ', () => {
  it('生成 → 選択肢 → advance → 次場面 → 新選択肢 の一連が動く', async () => {
    let projectId: string | undefined;
    try {
      const project = await createProject({
        title: 'Amplifier Novel',
        projectType: 'novel',
        experienceMode: 'amplifier',
      });
      projectId = project.projectId;
      expect(project.experienceMode).toBe('amplifier');

      const first = await generateScene(projectId);
      const turn = await createTurn(projectId, {
        kind: 'novel',
        generationId: first.generationId,
        textRevisionNumber: 0,
      });
      expect(turn.status).toBe('ready');
      expect(turn.choices.length).toBe(3);
      const choiceRequest = amplifierChoiceRequests.at(-1);
      expect(choiceRequest?.responseMimeType).toBe('application/json');
      expect(choiceRequest?.maxOutputTokens).toBeGreaterThanOrEqual(16_384);
      // choiceId はサーバー採番（モデル入力を信用しない・設計書 5.4）
      expect(turn.choices[0].choiceId).toMatch(/^amp-choice-/);

      const stateBefore = await fetch(
        `${baseUrl}/api/projects/${projectId}/amplifier/state?kind=novel`
      );
      expect(stateBefore.status).toBe(200);
      const stateBody = (await stateBefore.json()) as { turn: AmplifierTurn };
      expect(stateBody.turn.turnId).toBe(turn.turnId);

      // advance（選択を送ると暗黙採用 → 次場面生成・設計書 4.4）
      const advanceResponse = await fetch(
        `${baseUrl}/api/projects/${projectId}/amplifier/novel/advance-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'advance-1',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor: { kind: 'novel', generationId: first.generationId, textRevisionNumber: 0 },
            selectedChoiceId: turn.choices[0].choiceId,
          }),
        }
      );
      expect(advanceResponse.status).toBe(200);
      const sse = await readSseBody(advanceResponse);
      expect(sse).toContain('event: done');
      expect(sse).toContain('generationId');
      // 採用済み・次場面が1つ進んでいる
      const projectState = await storage.readState(projectId);
      expect(projectState?.lastAcceptedGenerationId).toBe(first.generationId);
      const generations = (await storage.readAmplifierInteractions(projectId)).filter(
        (event) => event.type === 'choice_selected'
      );
      expect(generations).toHaveLength(1);

      // 同じ clientEventId の再送は二重進行しない（冪等リプレイ・設計書 12.3）
      const replayResponse = await fetch(
        `${baseUrl}/api/projects/${projectId}/amplifier/novel/advance-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'advance-1',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor: { kind: 'novel', generationId: first.generationId, textRevisionNumber: 0 },
            selectedChoiceId: turn.choices[0].choiceId,
          }),
        }
      );
      const replaySse = await readSseBody(replayResponse);
      expect(replaySse).toContain('event: done');
      const events = await storage.readAmplifierInteractions(projectId);
      expect(events.filter((event) => event.type === 'choice_selected')).toHaveLength(1);

      // 古いターン（consumed）は押せない
      const staleAdvance = await fetch(
        `${baseUrl}/api/projects/${projectId}/amplifier/novel/advance-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'advance-2',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor: { kind: 'novel', generationId: first.generationId, textRevisionNumber: 0 },
            selectedChoiceId: turn.choices[0].choiceId,
          }),
        }
      );
      expect(staleAdvance.status).toBe(409);
      const staleBody = (await staleAdvance.json()) as { code?: string };
      expect(staleBody.code).toBe('amplifier_turn_not_ready');

      // NOTE: 次場面の保存後、サーバーが新しい選択肢を非同期生成する（設計書 4.4 step 6）。
      // テストの後片付け（プロジェクト削除）が非同期生成と競合しないよう完了を待つ。
      await vi.waitFor(
        async () => {
          const turns = await storage.readAmplifierTurns(projectId);
          const nextTurn = turns.find(
            (t) =>
              t.anchor.kind === 'novel' &&
              t.anchor.generationId !== first.generationId &&
              t.status === 'ready'
          );
          expect(nextTurn).toBeTruthy();
        },
        { timeout: 10_000 }
      );
      await waitForBackgroundSettled(projectId);
    } finally {
      if (projectId)       await storage.deleteProjectDir(projectId);
    }
  });
});

describe('妄想増幅器 failed ターンの再取得', () => {
  it('同じ failed ターンへの同時リトライを1回のモデル呼び出しにまとめる', async () => {
    let projectId: string | undefined;
    let releaseRetry!: () => void;
    let markRetryStarted!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    try {
      const project = await createProject({
        title: 'Amplifier Retry Concurrency',
        projectType: 'novel',
        experienceMode: 'amplifier',
      });
      projectId = project.projectId;
      const generation = await generateScene(projectId);
      const anchor = {
        kind: 'novel' as const,
        generationId: generation.generationId,
        textRevisionNumber: 0,
      };

      amplifierChoiceOverride = async () => ({
        text: '{}',
        finishReason: 'stop',
        retryable: false,
      });
      const failed = await createTurn(projectId, anchor);
      expect(failed.status).toBe('failed');

      let retryCalls = 0;
      amplifierChoiceOverride = async () => {
        retryCalls += 1;
        markRetryStarted();
        await retryGate;
        return choicePromptResponse();
      };
      const retry = fetch(`${baseUrl}/api/projects/${projectId}/amplifier/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor }),
      });
      await retryStarted;

      const duplicate = await fetch(`${baseUrl}/api/projects/${projectId}/amplifier/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor }),
      });
      expect(duplicate.status).toBe(409);
      expect((await duplicate.json()) as { code?: string }).toMatchObject({
        code: 'amplifier_turn_in_progress',
      });

      releaseRetry();
      const retried = await retry;
      expect(retried.status).toBe(201);
      expect(((await retried.json()) as { turn: AmplifierTurn }).turn.status).toBe('ready');
      expect(retryCalls).toBe(1);
      await waitForBackgroundSettled(projectId);
    } finally {
      releaseRetry?.();
      if (projectId) await deleteProjectDirResilient(projectId);
    }
  });

  it('再取得中に本文が改訂されたら古い選択肢を superseded にする', async () => {
    let projectId: string | undefined;
    let releaseRetry!: () => void;
    let markRetryStarted!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    try {
      const project = await createProject({
        title: 'Amplifier Retry Stale Anchor',
        projectType: 'novel',
        experienceMode: 'amplifier',
      });
      projectId = project.projectId;
      const generation = await generateScene(projectId);
      const anchor = {
        kind: 'novel' as const,
        generationId: generation.generationId,
        textRevisionNumber: 0,
      };

      amplifierChoiceOverride = async () => ({
        text: '{}',
        finishReason: 'stop',
        retryable: false,
      });
      expect((await createTurn(projectId, anchor)).status).toBe('failed');

      amplifierChoiceOverride = async () => {
        markRetryStarted();
        await retryGate;
        return choicePromptResponse();
      };
      const retry = fetch(`${baseUrl}/api/projects/${projectId}/amplifier/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor }),
      });
      await retryStarted;
      const editedText = `${generation.responseText}\n本文改訂`;
      await storage.appendGenerationTextRevisionLog(projectId, generation.generationId, editedText, {
        reason: 'retry-stale-test',
        before: generation.responseText,
        after: editedText,
        source: 'manual-edit',
        revisionNumber: 1,
      });
      releaseRetry();

      const response = await retry;
      expect(response.status).toBe(201);
      const body = (await response.json()) as { turn: AmplifierTurn };
      expect(body.turn.status).toBe('superseded');
      expect(body.turn.errorCode).toBe('stale_anchor');
      await waitForBackgroundSettled(projectId);
    } finally {
      releaseRetry?.();
      if (projectId) await deleteProjectDirResilient(projectId);
    }
  });
});

describe('妄想増幅器 roleplay の選択ループ', () => {
  it('キャラ応答 → 選択肢 → 方向送信 → 応答が user 発言なしで追加される', async () => {
    let projectId: string | undefined;
    try {
      const project = await createProject({
        title: 'Amplifier Roleplay',
        projectType: 'roleplay',
        experienceMode: 'amplifier',
        characters: [
          {
            characterId: 'char-1',
            name: '凛',
            role: 'protagonist',
            description: 'クールな先輩',
            greeting: 'やあ、待ってたよ。',
          },
        ],
        scenarioSeeds: ['放課後の教室'],
      });
      projectId = project.projectId;
      expect(project.experienceMode).toBe('amplifier');

      // 会話を開始（greeting が最初のキャラメッセージになる）
      const sessionResponse = await fetch(
        `${baseUrl}/api/projects/${projectId}/roleplay/sessions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ characterId: 'char-1' }),
        }
      );
      expect(sessionResponse.status).toBe(201);
      const sessionBody = (await sessionResponse.json()) as {
        session: { sessionId: string; messages: Array<{ messageId: string; role: string; content: string }> };
      };
      const sessionId = sessionBody.session.sessionId;
      const greeting = sessionBody.session.messages[0];
      expect(greeting.role).toBe('character');

      // greeting へ選択肢を作る（設計書 4.3）
      const turn = await createTurn(projectId, {
        kind: 'roleplay',
        sessionId,
        messageId: greeting.messageId,
        contentRevision: 0,
      });
      expect(turn.status).toBe('ready');

      // 方向送信（amplifier-turn-stream）
      const streamResponse = await fetch(
        `${baseUrl}/api/projects/${projectId}/roleplay/sessions/${sessionId}/amplifier-turn-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'rp-advance-1',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor: {
              kind: 'roleplay',
              sessionId,
              messageId: greeting.messageId,
              contentRevision: 0,
            },
            sessionRevision: 1,
            selectedChoiceId: turn.choices[0].choiceId,
          }),
        }
      );
      expect(streamResponse.status).toBe(200);
      const sse = await readSseBody(streamResponse);
      expect(sse).toContain('event: done');

      const updated = await fetch(
        `${baseUrl}/api/projects/${projectId}/roleplay/sessions/${sessionId}`
      );
      const updatedBody = (await updated.json()) as {
        session: { messages: Array<{ role: string; amplifierInteractionId?: string }>; revision: number };
      };
      const messages = updatedBody.session.messages;
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe('character');
      // メタ方向は通常ユーザー発言として混ざらない（設計書 4.5）
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(0);
      expect(messages[1].amplifierInteractionId).toBeTruthy();

      // イベントが1件だけ記録されている
      const events = await storage.readAmplifierInteractions(projectId);
      expect(events.filter((event) => event.type === 'choice_selected')).toHaveLength(1);

      await waitForBackgroundSettled(projectId);
    } finally {
      if (projectId) await deleteProjectDirResilient(projectId);
    }
  });

  it('別会話のturnと複数方向指定をイベント保存前に拒否する', async () => {
    let projectId: string | undefined;
    try {
      const project = await createProject({
        title: 'Amplifier Roleplay Validation',
        projectType: 'roleplay',
        experienceMode: 'amplifier',
        characters: [
          {
            characterId: 'char-1',
            name: '凛',
            role: 'protagonist',
            description: 'クールな先輩',
            greeting: 'やあ、待ってたよ。',
          },
        ],
      });
      projectId = project.projectId;
      const activeProjectId = project.projectId;

      const createSession = async () => {
        const response = await fetch(
          `${baseUrl}/api/projects/${activeProjectId}/roleplay/sessions`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ characterId: 'char-1' }),
          }
        );
        expect(response.status).toBe(201);
        return (await response.json()) as {
          session: {
            sessionId: string;
            revision: number;
            messages: Array<{ messageId: string }>;
          };
        };
      };

      const first = await createSession();
      const second = await createSession();
      const greeting = first.session.messages[0];
      const anchor = {
        kind: 'roleplay' as const,
        sessionId: first.session.sessionId,
        messageId: greeting.messageId,
        contentRevision: 0,
      };
      const turn = await createTurn(activeProjectId, anchor);

      const crossSession = await fetch(
        `${baseUrl}/api/projects/${activeProjectId}/roleplay/sessions/${second.session.sessionId}/amplifier-turn-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'rp-cross-session',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor,
            sessionRevision: second.session.revision,
            selectedChoiceId: turn.choices[0].choiceId,
          }),
        }
      );
      expect(crossSession.status).toBe(409);

      const multipleDirections = await fetch(
        `${baseUrl}/api/projects/${activeProjectId}/roleplay/sessions/${first.session.sessionId}/amplifier-turn-stream`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientEventId: 'rp-multiple-directions',
            turnId: turn.turnId,
            turnRevision: turn.revision,
            anchor,
            sessionRevision: first.session.revision,
            selectedChoiceId: turn.choices[0].choiceId,
            freeText: '別の方向も同時指定する',
          }),
        }
      );
      expect(multipleDirections.status).toBe(400);

      expect(await storage.readAmplifierInteractions(activeProjectId)).toHaveLength(0);
      expect((await storage.readAmplifierTurn(activeProjectId, turn.turnId))?.status).toBe('ready');
    } finally {
      if (projectId) await deleteProjectDirResilient(projectId);
    }
  });
});
