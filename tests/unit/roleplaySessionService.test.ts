import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import * as projectService from '../../src/server/services/projectService';
import * as roleplayService from '../../src/server/services/roleplaySessionService';
import * as storage from '../../src/server/services/storageService';
import type {
  AdapterGenerateStreamEvent,
  Character,
} from '../../src/server/types/index';

const createdProjectIds: string[] = [];

function baseCharacter(overrides: Partial<Character> = {}): Character {
  return {
    characterId: 'char-a',
    name: 'アリス',
    role: 'protagonist',
    description: '穏やかな女子高生。',
    speechStyle: '柔らかい丁寧語',
    greeting: 'あ、来てくれたんだ。',
    dialogueExamples: ['……ここ、隣あいてるよ。'],
    ...overrides,
  };
}

async function makeRoleplayProject(character: Character = baseCharacter()) {
  const project = await projectService.createProject({
    title: 'テスト作品',
    projectType: 'roleplay',
    scenarioSeeds: ['放課後の教室で二人きり'],
    characters: [character],
    worldText: '架空の日本の高校を舞台にした穏やかな日常。',
  });
  createdProjectIds.push(project.projectId);
  return project;
}

async function makeNovelProject() {
  const project = await projectService.createProject({
    title: 'ノベル作品',
    characters: [baseCharacter()],
    worldText: '',
  });
  createdProjectIds.push(project.projectId);
  return project;
}

function streamChunks(chunks: string[]): AsyncGenerator<AdapterGenerateStreamEvent> {
  async function* gen() {
    for (const text of chunks) {
      yield { type: 'chunk' as const, text };
    }
    yield { type: 'done' as const, finishReason: 'stop' as const };
  }
  return gen();
}

async function collectStream(gen: AsyncGenerator<roleplayService.RoleplayStreamEvent>): Promise<{
  chunks: string[];
  done?: Extract<roleplayService.RoleplayStreamEvent, { type: 'done' }>['session'];
  errors: Array<Extract<roleplayService.RoleplayStreamEvent, { type: 'error' }>['error']>;
}> {
  const chunks: string[] = [];
  const errors: Array<Extract<roleplayService.RoleplayStreamEvent, { type: 'error' }>['error']> = [];
  let done: Extract<roleplayService.RoleplayStreamEvent, { type: 'done' }>['session'] | undefined;
  try {
    for await (const event of gen) {
      if (event.type === 'chunk') chunks.push(event.text);
      else if (event.type === 'done') done = event.session;
      else errors.push(event.error);
    }
  } catch (err) {
    // NOTE: beginTurn の失敗（revision_conflict / not_regeneratable など）は
    // AsyncGenerator の外に throw される。route ハンドラでは .next() で先取りして
    // JSON 応答に変換するので、テスト側では errors 配列に集約する。
    if (err instanceof roleplayService.RoleplayServiceError) {
      errors.push({
        error: err.message,
        code: err.code,
        retryable: err.retryable,
        revision: err.revision,
      });
    } else {
      throw err;
    }
  }
  return { chunks, done, errors };
}

beforeEach(() => {
  roleplayService.__resetInFlightForTesting();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
  createdProjectIds.length = 0;
  roleplayService.__resetInFlightForTesting();
});

describe('roleplaySessionService', () => {
  it('rejects creation on a novel-type project', async () => {
    const project = await makeNovelProject();
    await expect(
      roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: 'char-a',
      })
    ).rejects.toMatchObject({ code: 'project_type_mismatch', status: 409 });
  });

  it('inserts greeting as the first character message without calling the model', async () => {
    const project = await makeRoleplayProject();
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText');
    const streamSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateTextStream')
      .mockImplementation(() => streamChunks(['unused']));

    const view = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0].role).toBe('character');
    expect(view.messages[0].content).toBe('あ、来てくれたんだ。');
    expect(spy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
    expect(view.characterName).toBe('アリス');
  });

  it('starts empty when the character has no greeting', async () => {
    const project = await makeRoleplayProject(baseCharacter({ greeting: undefined }));
    const view = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(view.messages).toEqual([]);
  });

  it('applies the edited project base prompt to roleplay generation', async () => {
    const project = await makeRoleplayProject();
    const presets = await storage.readPresets(project.projectId);
    if (!presets) throw new Error('Presets not found');
    await storage.writePresets(project.projectId, {
      ...presets,
      baseSystemPrompt: 'ロールプレイでも守る作品固有の基本指示。',
    });

    let capturedSystemInstructions = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystemInstructions = request.systemInstructions;
      return streamChunks(['わかったよ。']);
    });
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });

    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話そう',
        revision: created.revision,
      })
    );

    expect(capturedSystemInstructions).toContain(
      'ロールプレイでも守る作品固有の基本指示。'
    );
  });

  it('runs the send→character commit and revision transitions R → R+1 → R+2', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['……ここ、', '隣あいてるよ。'])
    );

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(created.revision).toBe(1);

    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'こんにちは',
        revision: created.revision,
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.chunks.join('')).toBe('……ここ、隣あいてるよ。');
    expect(result.done?.revision).toBe(3); // 1 → 2 (user save) → 3 (character commit)
    expect(result.done?.messages).toHaveLength(3);
    expect(result.done?.messages[0].content).toBe('あ、来てくれたんだ。');
    expect(result.done?.messages[1]).toMatchObject({ role: 'user', content: 'こんにちは' });
    expect(result.done?.messages[2]).toMatchObject({
      role: 'character',
      content: '……ここ、隣あいてるよ。',
    });
  });

  it('classifies an empty Gemini prompt block as a non-retryable content filter error', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        yield {
          type: 'done',
          finishReason: 'stop',
          debugInfo:
            'finishReason=stop candidates=0 parts=none promptBlockReason=PROHIBITED_CONTENT',
        };
      }
      return gen();
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '続きを話して',
        revision: created.revision,
      })
    );

    expect(result.done).toBeUndefined();
    expect(result.errors[0]).toMatchObject({
      code: 'content_filter',
      retryable: false,
    });
    expect(result.errors[0]?.error).toContain('promptBlockReason=PROHIBITED_CONTENT');
  });

  it('keeps a high but non-blocking Gemini safety rating retryable', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        yield {
          type: 'done',
          finishReason: 'stop',
          debugInfo:
            'finishReason=stop candidates=1 parts=none candidateSafety=HARASSMENT=HIGH',
        };
      }
      return gen();
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '続きを話して',
        revision: created.revision,
      })
    );

    expect(result.errors[0]).toMatchObject({
      code: 'empty_response',
      retryable: true,
    });
  });

  it('includes Gemini diagnostics in an explicit roleplay content filter error', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        yield {
          type: 'done',
          finishReason: 'content_filter',
          debugInfo:
            'finishReason=content_filter candidates=1 parts=none candidateSafety=HARASSMENT=HIGH(blocked)',
        };
      }
      return gen();
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '続きを話して',
        revision: created.revision,
      })
    );

    expect(result.errors[0]).toMatchObject({
      code: 'content_filter',
      retryable: false,
    });
    expect(result.errors[0]?.error).toContain('candidateSafety=HARASSMENT=HIGH(blocked)');
  });

  it('regenerates the last character message without incrementing user revision', async () => {
    const project = await makeRoleplayProject();
    const streamSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateTextStream')
      .mockImplementation(() => streamChunks(['最初の応答']));

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const send = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'ねえ',
        revision: created.revision,
      })
    );
    expect(send.done?.messages[send.done!.messages.length - 1].content).toBe('最初の応答');
    const revisionAfterSend = send.done!.revision;

    streamSpy.mockImplementation(() => streamChunks(['別の応答']));
    const regen = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: revisionAfterSend,
      })
    );
    expect(regen.errors).toEqual([]);
    expect(regen.done?.revision).toBe(revisionAfterSend + 1); // regenerate: R → R+1
    // 末尾 character が置き換わる（元は消える）
    const messages = regen.done!.messages;
    expect(messages[messages.length - 1].content).toBe('別の応答');
    expect(messages.find((m) => m.content === '最初の応答')).toBeUndefined();
  });

  it('refuses regenerate when the tail is the greeting (no previous user)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: created.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('not_regeneratable');
  });

  it('applies project.roleplayOutputChars to prompt outputLength and system rules on each turn', async () => {
    const project = await makeRoleplayProject();
    // NOTE: プロジェクト作成後にプロジェクト設定を更新し、次ターンで反映されるかを見る。
    await projectService.updateProject(project.projectId, { roleplayOutputChars: 400 });

    let capturedOutputLength = 0;
    let capturedSystem = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((req: any) => {
      capturedOutputLength = req.outputLength;
      capturedSystem = req.systemInstructions;
      return streamChunks(['ok']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'hi',
        revision: created.revision,
      })
    );
    expect(capturedOutputLength).toBe(400);
    // NOTE: 目安字数がシステム指示にも埋め込まれ、括弧書き動作の例が入っている。
    expect(capturedSystem).toContain('400字程度');
    expect(capturedSystem).toContain('括弧書き');
    expect(capturedSystem).not.toContain('1〜3文');
  });

  it('injects manually-registered NG expressions into the roleplay prompt', async () => {
    const project = await makeRoleplayProject();
    // NOTE: NG 表現を登録してから会話開始。プロンプト末尾に載るかを確認する。
    const expressionService = await import('../../src/server/services/expressionService');
    await expressionService.createExpression(project.projectId, {
      text: '息を呑んだ',
      source: 'manual',
    });
    await expressionService.createExpression(project.projectId, {
      text: '胸の奥が',
      source: 'manual',
    });

    let capturedPrompt = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((req: any) => {
      capturedPrompt = req.userPrompt;
      return streamChunks(['ok']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'hi',
        revision: created.revision,
      })
    );
    expect(capturedPrompt).toContain('【表現上の注意】');
    expect(capturedPrompt).toContain('- 「息を呑んだ」');
    expect(capturedPrompt).toContain('- 「胸の奥が」');
  });

  it('refuses a second send while the first is still in flight', async () => {
    const project = await makeRoleplayProject();
    // NOTE: 生成を意図的に長引かせるため、never-resolving のジェネレータを渡す。
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        yield { type: 'chunk', text: '応答' };
        await firstDone;
        yield { type: 'done', finishReason: 'stop' };
      }
      return gen();
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    // 第1発話（意図的に完了させない）
    const firstStreamPromise = collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'A',
        revision: created.revision,
      })
    );
    // 少し待って in-flight フラグが立つのを確認
    await new Promise((r) => setTimeout(r, 20));

    // NOTE: 第2発話は revision がずれるので generation_in_progress か revision_conflict のいずれかで
    // 弾かれる（どちらも「並行送信を拒否する」設計上の正解）。
    const secondResult = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'B',
        revision: created.revision,
      })
    );
    expect(secondResult.errors[0]?.code).toMatch(
      /^(generation_in_progress|revision_conflict|pending_response)$/
    );

    releaseFirst();
    await firstStreamPromise;
  });

  it('releases in-flight flag after stream errors (regression: review §5.1)', async () => {
    const project = await makeRoleplayProject();
    // NOTE: adapter が最初のチャンク直後にエラーを投げるケース。以前は
    // per-branch delete 依存だったが、finally 集約後は必ず解放されることを保証する。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        throw new Error('simulated adapter failure');
      }
      return gen();
    });
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const first = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'A',
        revision: created.revision,
      })
    );
    expect(first.errors[0]?.code).toBe('roleplay_failed');

    // 次の送信が generation_in_progress で弾かれないことで、in-flight が解放されたと確認。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['second response'])
    );
    // user メッセージが保存されているので、末尾 user からの regenerate で応答を取り直す。
    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const second = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: latest.revision,
      })
    );
    expect(second.errors).toEqual([]);
    expect(second.done?.messages[second.done!.messages.length - 1].content).toBe(
      'second response'
    );
  });

  it('accepts regenerate when tail is a user message (send-fail recovery, review §5.3)', async () => {
    const project = await makeRoleplayProject();
    // NOTE: 最初の送信は adapter エラーで失敗させ、末尾 user のまま残す状態を作る。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementationOnce(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        throw new Error('failed');
      }
      return gen();
    });
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'ねえ',
        revision: created.revision,
      })
    );

    // 末尾が user のはず。regenerate で応答を取り直す。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['遅くなってごめん'])
    );
    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    expect(latest.messages[latest.messages.length - 1].role).toBe('user');

    const regen = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: latest.revision,
      })
    );
    expect(regen.errors).toEqual([]);
    const finalMessages = regen.done!.messages;
    expect(finalMessages[finalMessages.length - 2]).toMatchObject({ role: 'user', content: 'ねえ' });
    expect(finalMessages[finalMessages.length - 1]).toMatchObject({
      role: 'character',
      content: '遅くなってごめん',
    });
  });

  it('atomically replaces the trailing unanswered user message before generating', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementationOnce(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        throw new Error('first response failed');
      }
      return gen();
    });
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });

    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '間違った発言',
        revision: created.revision,
      })
    );
    const pending = await roleplayService.getRoleplaySession(
      project.projectId,
      created.sessionId
    );
    const pendingUser = pending.messages[pending.messages.length - 1];
    expect(pendingUser).toMatchObject({ role: 'user', content: '間違った発言' });

    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementationOnce(() =>
      streamChunks(['訂正文への応答'])
    );
    const corrected = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '訂正した発言',
        revision: pending.revision,
        replacePendingMessageId: pendingUser.messageId,
      })
    );

    expect(corrected.errors).toEqual([]);
    const userMessages = corrected.done?.messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages?.[0]).toMatchObject({
      messageId: pendingUser.messageId,
      content: '訂正した発言',
    });
    expect(corrected.done?.messages.at(-1)?.content).toBe('訂正文への応答');
  });

  it('rejects a stale pending-message replacement instead of appending a new turn', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['通常の応答'])
    );
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const completed = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '元の発言',
        revision: created.revision,
      })
    );
    const userMessage = completed.done?.messages
      .filter((message) => message.role === 'user')
      .at(-1);

    const stale = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '遅れて届いた訂正',
        revision: completed.done!.revision,
        replacePendingMessageId: userMessage!.messageId,
      })
    );

    expect(stale.errors[0]?.code).toBe('pending_message_changed');
    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    expect(latest.messages.at(-1)?.content).toBe('通常の応答');
    expect(latest.messages.some((message) => message.content === '遅れて届いた訂正')).toBe(false);
  });

  it('surfaces summary_failed instead of silently dropping history when summarizer fails (review §追加設計)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    // NOTE: 予算超過を人為的に作る。ROLEPLAY_SUMMARY_THRESHOLD=40 を超える件数を積む
    // ため、user/character を 42 件（+ greeting 1件）保存してから、要約 LLM を
    // 失敗させて summary_failed が明示エラーで返ることを検証する。
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(stored).not.toBeNull();
    const extraMessages = [];
    for (let i = 0; i < 42; i++) {
      extraMessages.push({
        messageId: `rm-hist-${i}`,
        role: (i % 2 === 0 ? 'user' : 'character') as 'user' | 'character',
        content: `msg ${i}`,
        createdAt: '2026-07-01T00:00:00.000Z',
      });
    }
    await storage.writeRoleplaySession({
      ...stored!,
      messages: [...stored!.messages, ...extraMessages],
    });

    // NOTE: 要約は runNonStreaming 経由。generateText を error に落として要約失敗を作る。
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'error',
      retryable: true,
    });
    // 応答本体は使わない（要約失敗で早期エラー）が念のため mock。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['never used'])
    );

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'trigger summary',
        revision: latest.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('summary_failed');
    // NOTE: in-flight も解放されていることを、次の regenerate が通ることで確認。
    vi.restoreAllMocks();
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '会話の要約テキスト',
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['recovery'])
    );
    const recovered = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const recover = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: recovered.revision,
      })
    );
    // 要約が成功すれば送信も通る（summary_failed が固定的にはならない）
    expect(recover.errors.map((e) => e.code)).not.toContain('generation_in_progress');
  });

  it('saves content up to hard cap even when the tail chunk exactly fills it and adapter reports error (review §5.2)', async () => {
    const project = await makeRoleplayProject();
    // NOTE: roleplayOutputChars=100 → hardCap=max(600, 200)=600。
    // 300+300=600 で埋め切り、直後の done が finishReason='error' を返す病的ケース。
    // 修正前は event.text.length > remaining の等号境界で hardCapReached が立たず、
    // 上限到達済み本文をエラー扱いで破棄していた。
    await projectService.updateProject(project.projectId, { roleplayOutputChars: 100 });

    const first = 'あ'.repeat(300);
    const second = 'い'.repeat(300);
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* gen(): AsyncGenerator<AdapterGenerateStreamEvent> {
        yield { type: 'chunk', text: first };
        yield { type: 'chunk', text: second };
        yield { type: 'done', finishReason: 'error' };
      }
      return gen();
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'hi',
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    const saved = result.done!.messages[result.done!.messages.length - 1];
    expect(saved.role).toBe('character');
    // 600字ちょうどで保存されている。
    expect(saved.content.length).toBe(600);
  });
});
