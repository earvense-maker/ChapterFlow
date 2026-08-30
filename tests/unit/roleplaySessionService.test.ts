import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/server/adapters/deepseekAdapter';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { baseInstruction } from '../../src/server/prompts/baseInstruction';
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
  postprocessingCount: number;
  replacements: string[];
  done?: Extract<roleplayService.RoleplayStreamEvent, { type: 'done' }>['session'];
  errors: Array<Extract<roleplayService.RoleplayStreamEvent, { type: 'error' }>['error']>;
}> {
  const chunks: string[] = [];
  const errors: Array<Extract<roleplayService.RoleplayStreamEvent, { type: 'error' }>['error']> = [];
  let postprocessingCount = 0;
  const replacements: string[] = [];
  let done: Extract<roleplayService.RoleplayStreamEvent, { type: 'done' }>['session'] | undefined;
  try {
    for await (const event of gen) {
      if (event.type === 'chunk') chunks.push(event.text);
      else if (event.type === 'postprocessing') postprocessingCount += 1;
      else if (event.type === 'replace') replacements.push(event.text);
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
  return { chunks, postprocessingCount, replacements, done, errors };
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs = 8_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition was not met within timeout');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function seedMessages(
  projectId: string,
  sessionId: string,
  count: number,
  prefix: string
): Promise<void> {
  const stored = await storage.readRoleplaySession(projectId, sessionId);
  if (!stored) throw new Error('Roleplay session not found');
  const messages = Array.from({ length: count }, (_, i) => ({
    messageId: `${prefix}-${i}`,
    role: (i % 2 === 0 ? 'user' : 'character') as 'user' | 'character',
    content: `${prefix}の会話 ${i}`,
    createdAt: `2026-07-04T00:${String(Math.floor(i / 2)).padStart(2, '0')}:00.000Z`,
  }));
  await storage.writeRoleplaySession({
    ...stored,
    messages: [...stored.messages, ...messages],
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  roleplayService.__resetInFlightForTesting();
});

describe('roleplay message manual editing', () => {
  it('tracks revisions, rejects stale writes, and restores the original message', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const message = created.messages[0];
    expect(message).toBeDefined();

    const edited = await roleplayService.editRoleplayMessage({
      projectId: project.projectId,
      sessionId: created.sessionId,
      messageId: message!.messageId,
      content: 'edited greeting',
      expectedSessionRevision: created.revision,
      expectedMessageRevision: 0,
    });
    expect(edited).toMatchObject({
      memoryRebuildStarted: false,
      session: {
        revision: created.revision + 1,
        messages: [{ content: 'edited greeting', contentRevision: 1 }],
        derivedMemoryStatus: { status: 'fresh' },
      },
    });

    await expect(
      roleplayService.editRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        messageId: message!.messageId,
        content: 'stale write',
        expectedSessionRevision: created.revision,
        expectedMessageRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });

    const history = await roleplayService.getRoleplayMessageRevisions(
      project.projectId,
      created.sessionId,
      message!.messageId
    );
    expect(history).toMatchObject({
      originalContent: message!.content,
      revisions: [{ revisionNumber: 1, source: 'manual-edit', afterContent: 'edited greeting' }],
    });

    const restored = await roleplayService.restoreRoleplayMessageRevision({
      projectId: project.projectId,
      sessionId: created.sessionId,
      messageId: message!.messageId,
      revisionId: `original:${message!.messageId}`,
      expectedSessionRevision: edited.session.revision,
      expectedMessageRevision: 1,
    });
    expect(restored.session.messages[0]).toMatchObject({
      content: message!.content,
      contentRevision: 2,
    });
  });

  it('does not edit messages in an archived session', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const archived = await roleplayService.archiveRoleplaySession(
      project.projectId,
      created.sessionId,
      created.revision
    );
    await expect(
      roleplayService.editRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        messageId: created.messages[0]!.messageId,
        content: 'cannot edit',
        expectedSessionRevision: archived.revision,
        expectedMessageRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'session_archived', status: 409 });
  });

  it('rebuilds summarized memory after editing a folded message', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const greeting = created.messages[0]!;
    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    await storage.writeRoleplaySession({
      ...saved!,
      messages: [
        greeting,
        {
          messageId: 'manual-user-message',
          role: 'user',
          content: 'follow up',
          createdAt: saved!.updatedAt,
        },
      ],
      conversationSummary: 'old summary',
      summaryThroughMessageId: greeting.messageId,
    });

    const edited = await roleplayService.editRoleplayMessage({
      projectId: project.projectId,
      sessionId: created.sessionId,
      messageId: greeting.messageId,
      content: 'edited folded greeting',
      expectedSessionRevision: created.revision,
      expectedMessageRevision: 0,
    });
    expect(edited).toMatchObject({
      memoryRebuildStarted: true,
      session: { derivedMemoryStatus: { status: 'pending' } },
    });

    await vi.waitFor(async () => {
      const rebuilt = await storage.readRoleplaySession(project.projectId, created.sessionId);
      expect(rebuilt).toMatchObject({ derivedMemoryStatus: { status: 'fresh' } });
      expect(rebuilt?.conversationSummary).toBeUndefined();
      expect(rebuilt?.summaryThroughMessageId).toBeUndefined();
    });
  });

  it('does not let a later edit clear a stale derived-memory marker', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    await storage.writeRoleplaySession({
      ...saved!,
      derivedMemoryStatus: {
        status: 'stale',
        sourcePrefixFingerprint: 'stale-prefix',
        updatedAt: saved!.updatedAt,
        errorMessage: 'rebuild failed',
      },
    });

    await expect(
      roleplayService.editRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        messageId: created.messages[0]!.messageId,
        content: 'must remain blocked',
        expectedSessionRevision: created.revision,
        expectedMessageRevision: 0,
      })
    ).rejects.toMatchObject({ code: 'derived_memory_not_fresh', status: 409 });
    await expect(storage.readRoleplaySession(project.projectId, created.sessionId)).resolves.toMatchObject({
      derivedMemoryStatus: { status: 'stale', errorMessage: 'rebuild failed' },
    });
  });

  it('moves stale memory back to pending before a manual rebuild', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    await storage.writeRoleplaySession({
      ...saved!,
      conversationSummary: 'obsolete summary',
      summaryThroughMessageId: saved!.messages[0]!.messageId,
      derivedMemoryStatus: {
        status: 'stale',
        sourcePrefixFingerprint: 'stale-prefix',
        editedMessageId: saved!.messages[0]!.messageId,
        updatedAt: saved!.updatedAt,
        errorMessage: 'rebuild failed',
      },
    });

    const rebuilt = await roleplayService.retryRoleplayMemoryRebuild(
      project.projectId,
      created.sessionId
    );

    expect(rebuilt).toMatchObject({
      derivedMemoryStatus: { status: 'fresh' },
    });
    expect(rebuilt.conversationSummary).toBeUndefined();
    expect(rebuilt.summaryThroughMessageId).toBeUndefined();
  });

  it('repairs the legacy fresh fingerprint after a newer summary before regenerating', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const edited = await roleplayService.editRoleplayMessage({
      projectId: project.projectId,
      sessionId: created.sessionId,
      messageId: created.messages[0]!.messageId,
      content: 'edited greeting',
      expectedSessionRevision: created.revision,
      expectedMessageRevision: 0,
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const memoryUpdatedAt = stored!.derivedMemoryStatus!.updatedAt;
    const summaryUpdatedAt = new Date(Date.parse(memoryUpdatedAt) + 1_000).toISOString();
    await storage.writeRoleplaySession({
      ...stored!,
      messages: [
        ...stored!.messages,
        {
          messageId: 'legacy-user',
          role: 'user',
          content: 'continue',
          createdAt: summaryUpdatedAt,
        },
        {
          messageId: 'legacy-character',
          role: 'character',
          content: 'old response',
          createdAt: summaryUpdatedAt,
        },
      ],
      conversationSummary: 'newer valid summary',
      summaryThroughMessageId: stored!.messages[0]!.messageId,
      summaryUpdatedAt,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['regenerated response'])
    );

    const result = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: edited.session.revision,
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.done?.derivedMemoryStatus).toMatchObject({ status: 'fresh' });
    expect(result.done?.derivedMemoryStatus?.sourcePrefixFingerprint).not.toBe(
      stored!.derivedMemoryStatus!.sourcePrefixFingerprint
    );
  });

  it('does not bless a fresh fingerprint that matches no older conversation prefix', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const markerUpdatedAt = '2026-07-04T00:00:00.000Z';
    const summaryUpdatedAt = '2026-07-04T00:00:01.000Z';
    await storage.writeRoleplaySession({
      ...stored!,
      messages: [
        ...stored!.messages,
        {
          messageId: 'untrusted-user',
          role: 'user',
          content: 'continue',
          createdAt: summaryUpdatedAt,
        },
        {
          messageId: 'untrusted-character',
          role: 'character',
          content: 'old response',
          createdAt: summaryUpdatedAt,
        },
      ],
      conversationSummary: 'summary with unproven provenance',
      summaryThroughMessageId: stored!.messages[0]!.messageId,
      summaryUpdatedAt,
      derivedMemoryStatus: {
        status: 'fresh',
        sourcePrefixFingerprint: 'not-a-conversation-prefix',
        updatedAt: markerUpdatedAt,
      },
    });
    const streamSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateTextStream')
      .mockImplementation(() => streamChunks(['must not run']));

    const result = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: created.revision,
      })
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'derived_memory_not_fresh' }),
    ]);
    expect(streamSpy).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.CHAPTERFLOW_DEV_DIAGNOSTICS;
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

  // NOTE: 夢見るモードの後方互換ケース（設計書 §10）。通常 roleplay は従来どおり動き、
  // 空メッセージは拒否される（AC10）。sessionMode 欠損は 'roleplay' と解釈される。
  it('keeps rejecting an empty message for normal roleplay sessions (AC10)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(created.sessionMode).toBeUndefined();
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '',
        revision: created.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('invalid_message');
    expect(result.done).toBeUndefined();
  });

  it('does not treat a missing sessionMode as dream (design: 欠損は roleplay)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(created.sessionMode).toBeUndefined();
  });

  it('rejects a dream-marked session stored under a normal project before recalling dream memory', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');
    await storage.writeRoleplaySession({ ...stored, sessionMode: 'dream' });
    const streamSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateTextStream')
      .mockImplementation(() => streamChunks(['must not run']));

    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話そう',
        revision: created.revision,
      })
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'session_mode_mismatch' }),
    ]);
    expect(result.done).toBeUndefined();
    expect(streamSpy).not.toHaveBeenCalled();
    const after = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(after?.messages).toEqual(stored.messages);
  });

  it('rejects archiving a dream-marked session under a normal project before recording wake memory', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');
    await storage.writeRoleplaySession({ ...stored, sessionMode: 'dream' });

    await expect(
      roleplayService.archiveRoleplaySession(
        project.projectId,
        created.sessionId,
        created.revision
      )
    ).rejects.toMatchObject({ code: 'session_mode_mismatch' });

    const after = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(after?.status).toBe('active');
    expect(after?.revision).toBe(created.revision);
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

  it('records prompt budget reports in every build regardless of dev diagnostics (AC13)', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['わかったよ。'])
    );

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
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    // セッション作成時（system 縮小結果）と各ターン（結合済み report）の両方が残る。
    expect(stored?.contextSnapshot.appliedSettings?.promptBudgetReport).toBeDefined();
    expect(stored?.contextSnapshot.appliedSettings?.promptBudgetReport?.entries.length).toBeGreaterThan(0);
    expect(
      stored?.messages.some((message) => message.promptBudgetReport !== undefined)
    ).toBe(true);
  });

  it('keeps the per-turn budget report identical between done.session, stored session, and reload (AC13)', async () => {
    const project = await makeRoleplayProject();
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['わかったよ。'])
    );

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話そう',
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    const doneLast = result.done!.messages[result.done!.messages.length - 1];
    expect(doneLast.promptBudgetReport).toBeDefined();

    // 保存済みセッション（ファイル）と再読込（GET 相当）でも同じ report を返す。
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const storedLast = stored!.messages[stored!.messages.length - 1];
    expect(storedLast.promptBudgetReport).toEqual(doneLast.promptBudgetReport);

    const reloaded = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const reloadedLast = reloaded.messages[reloaded.messages.length - 1];
    expect(reloadedLast.promptBudgetReport).toEqual(doneLast.promptBudgetReport);
  });

  it('logs the system budget adjustment once at session creation and not again per turn (AC13)', async () => {
    const project = await makeRoleplayProject();
    // 基本プロンプトを 5,000 字へ長くし、セッション作成時の system report で
    // roleplay.projectSystemPrompt が truncated になる状態を作る。
    const presets = await storage.readPresets(project.projectId);
    if (!presets) throw new Error('Presets not found');
    await storage.writePresets(project.projectId, {
      ...presets,
      baseSystemPrompt: 'あ'.repeat(5_000),
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['わかったよ。'])
    );
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    // セッション作成時に一度だけログが出る。
    const sessionLogs = info.mock.calls.filter(
      (call) => call[0] === 'Roleplay session prompt budget adjusted'
    );
    expect(sessionLogs).toHaveLength(1);
    expect(JSON.stringify(sessionLogs[0])).toContain('roleplay.projectSystemPrompt');

    info.mockClear();
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話そう',
        revision: created.revision,
      })
    );
    // ターンの結合 report には system 側の縮小も含まれるが、ターン固有セクションが
    // full のターンではログを出さない（system 調整の二重ログを防ぐ）。
    const turnLogs = info.mock.calls.filter((call) => call[0] === 'Roleplay prompt budget adjusted');
    expect(turnLogs).toHaveLength(0);
  });

  // NOTE: 初期状態は最初の生成応答だけの足場。以後は履歴を現在状態の正本にする。
  it('stops sending the conversation-start state after the first generated response', async () => {
    const project = await makeRoleplayProject(
      baseCharacter({ currentState: '放課後の教室に一人でいる' })
    );
    let capturedSystemInstructions = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystemInstructions = request.systemInstructions;
      return streamChunks(['わかったよ。']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const first = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話そう',
        revision: created.revision,
      })
    );
    expect(capturedSystemInstructions).toContain('会話開始時点の状態');
    expect(capturedSystemInstructions).toContain('放課後の教室に一人でいる');

    if (!first.done) throw new Error('First turn did not complete');
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'また話そう',
        revision: first.done.revision,
      })
    );
    expect(capturedSystemInstructions).not.toContain('会話開始時点の状態');
    expect(capturedSystemInstructions).not.toContain('放課後の教室に一人でいる');
    // 演じるための他の情報は残り続ける。
    expect(capturedSystemInstructions).toContain('アリス');
    expect(capturedSystemInstructions).toContain('柔らかい丁寧語');
  });

  it('starts empty when the character has no greeting', async () => {
    const project = await makeRoleplayProject(baseCharacter({ greeting: undefined }));
    const view = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(view.messages).toEqual([]);
  });

  it('uses the conversation-start state only for the first response without a greeting', async () => {
    const project = await makeRoleplayProject(
      baseCharacter({ greeting: undefined, currentState: '校門の前で待っている' })
    );
    const capturedSystems: string[] = [];
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystems.push(request.systemInstructions);
      return streamChunks(['わかったよ。']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const first = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '行こう',
        revision: created.revision,
      })
    );
    if (!first.done) throw new Error('First turn did not complete');
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '着いたね',
        revision: first.done.revision,
      })
    );

    expect(capturedSystems).toHaveLength(2);
    expect(capturedSystems[0]).toContain('校門の前で待っている');
    expect(capturedSystems[1]).not.toContain('校門の前で待っている');
  });

  it('persists the user persona and uses it as prompt data with its action policy', async () => {
    const project = await makeRoleplayProject();
    let capturedSystemInstructions = '';
    let capturedUserPrompt = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystemInstructions = request.systemInstructions;
      capturedUserPrompt = request.userPrompt;
      return streamChunks(['覚えているよ。']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
      userPersona: {
        name: 'ユウ',
        relationship: '幼馴染',
        preferredAddress: 'ユウくん',
        knownFacts: '図書委員をしている',
        actionPolicy: 'collaborative',
      },
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '僕のこと、覚えてる？',
        revision: created.revision,
      })
    );

    expect(created.userPersona).toEqual({
      name: 'ユウ',
      relationship: '幼馴染',
      preferredAddress: 'ユウくん',
      knownFacts: '図書委員をしている',
      actionPolicy: 'collaborative',
    });
    expect(result.done?.userPersona).toEqual(created.userPersona);
    expect(capturedSystemInstructions).toContain('図書委員をしている');
    expect(capturedSystemInstructions).toContain('開始から成立までを自然な一連の動作として描写する');
    expect(capturedUserPrompt).toContain('ユウ: 僕のこと、覚えてる？');
  });

  it('falls back to the project default user persona when the request omits one', async () => {
    const project = await makeRoleplayProject();
    await projectService.updateProject(project.projectId, {
      defaultUserPersona: {
        name: '結衣',
        relationship: '同じ図書委員',
        preferredAddress: '結衣',
        knownFacts: '毎週金曜に当番が一緒',
        actionPolicy: 'strict',
      },
    });
    let capturedSystemInstructions = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystemInstructions = request.systemInstructions;
      return streamChunks(['うん、覚えてる。']);
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'こんにちは',
        revision: created.revision,
      })
    );

    expect(created.userPersona).toEqual({
      name: '結衣',
      relationship: '同じ図書委員',
      preferredAddress: '結衣',
      knownFacts: '毎週金曜に当番が一緒',
      actionPolicy: 'strict',
    });
    expect(capturedSystemInstructions).toContain('毎週金曜に当番が一緒');
  });

  it('keeps an explicitly cleared persona and migrates the legacy completion policy', async () => {
    const project = await makeRoleplayProject();
    await projectService.updateProject(project.projectId, {
      defaultUserPersona: { name: '結衣', actionPolicy: 'conservative' },
    });

    // NOTE: 会話開始モーダルで全項目を空にした場合は「名無しで話す」意思表示なので、
    // 既定ペルソナで埋め戻さない。
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
      userPersona: { actionPolicy: 'conservative' },
    });

    expect(created.userPersona?.name).toBeUndefined();
    expect(created.userPersona?.actionPolicy).toBe('collaborative');

    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored?.contextSnapshot.userPersona) throw new Error('User persona not found');
    await storage.writeRoleplaySession({
      ...stored,
      contextSnapshot: {
        ...stored.contextSnapshot,
        userPersona: { ...stored.contextSnapshot.userPersona, actionPolicy: 'conservative' },
      },
    });
    const migratedView = await roleplayService.getRoleplaySession(
      project.projectId,
      created.sessionId
    );
    expect(migratedView.userPersona?.actionPolicy).toBe('collaborative');
  });

  it('exposes captured settings and flags sessions after roleplay settings change', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });

    expect(created.settingsChanged).toBe(false);
    expect(created.appliedSettings?.presets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'rpResponseStyle' }),
      ])
    );

    await projectService.updateProject(project.projectId, {
      activePresetIds: {
        ...project.activePresetIds,
        rpResponseStyle: 'dialogue-only',
      },
    });

    const refreshed = await roleplayService.getRoleplaySession(
      project.projectId,
      created.sessionId
    );
    const summaries = await roleplayService.listRoleplaySessions(project.projectId);
    expect(refreshed.settingsChanged).toBe(true);
    expect(summaries.find((item) => item.sessionId === created.sessionId)?.settingsChanged).toBe(
      true
    );
  });

  it('captures the roleplay intimacy preset id for turn-level scene directions', async () => {
    const project = await makeRoleplayProject();
    await projectService.updateProject(project.projectId, {
      activePresetIds: {
        ...project.activePresetIds,
        rpIntimacy: 'direct-explicit',
      },
    });

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(stored?.contextSnapshot.intimacyPresetId).toBe('direct-explicit');
  });

  it('treats an omitted and explicit default base prompt as the same effective setting', async () => {
    const project = await makeRoleplayProject();
    const presets = await storage.readPresets(project.projectId);
    if (!presets) throw new Error('Presets not found');
    await storage.writePresets(project.projectId, {
      ...presets,
      baseSystemPrompt: undefined,
    });
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });

    const currentPresets = await storage.readPresets(project.projectId);
    if (!currentPresets) throw new Error('Presets not found');
    await storage.writePresets(project.projectId, {
      ...currentPresets,
      baseSystemPrompt: baseInstruction(),
    });

    const refreshed = await roleplayService.getRoleplaySession(
      project.projectId,
      created.sessionId
    );
    expect(refreshed.settingsChanged).toBe(false);
  });

  it('rechecks settings for the streamed done view when presets change during generation', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    let markStreamStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      async function* controlledStream(): AsyncGenerator<AdapterGenerateStreamEvent> {
        markStreamStarted();
        await streamGate;
        yield { type: 'chunk', text: '設定が変わったね。' };
        yield { type: 'done', finishReason: 'stop' };
      }
      return controlledStream();
    });

    const streamResult = collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '少し待って',
        revision: created.revision,
      })
    );
    await streamStarted;
    await projectService.updateProject(project.projectId, {
      activePresetIds: {
        ...project.activePresetIds,
        rpResponseStyle: 'dialogue-only',
      },
    });
    releaseStream();

    const result = await streamResult;
    expect(result.errors).toEqual([]);
    expect(result.done?.settingsChanged).toBe(true);
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

  it('sends roleplay style presets and keeps novel-only categories out of the conversation', async () => {
    const project = await makeRoleplayProject();
    await projectService.updateProject(project.projectId, {
      activePresetIds: {
        // 小説用: 会話には流れてはいけない
        narration: 'first-person',
        chapterEnding: 'hook',
        // ロールプレイ用: 会話に流れる
        rpResponseStyle: 'dialogue-only',
        rpInitiative: 'lead',
        rpMood: ['tense'],
        rpPainLevel: 'unflinching',
      },
    });

    let capturedSystemInstructions = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedSystemInstructions = request.systemInstructions;
      return streamChunks(['……。']);
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

    expect(capturedSystemInstructions).toContain('【会話の作風】');
    expect(capturedSystemInstructions).toContain('【会話の主導権: キャラから動かす】');
    expect(capturedSystemInstructions).toContain('【会話の空気: 張りつめた】');
    expect(capturedSystemInstructions).toContain('【踏み込みの上限: 容赦なくてよい】');

    // 小説用カテゴリは一切流れない（地の文・章立ての指示は応答形式と衝突する）
    expect(capturedSystemInstructions).not.toContain('【選択された設定】');
    expect(capturedSystemInstructions).not.toContain('【語り:');
    expect(capturedSystemInstructions).not.toContain('【章の幕引き:');

    // 応答の形は固定規則へ直接埋め込まれ、プリセット本文としては重複しない
    expect(capturedSystemInstructions).toContain(
      '応答はキャラクターのセリフだけで構成する。'
    );
    expect(capturedSystemInstructions).not.toContain('【応答の形:');
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
    const project = await makeRoleplayProject(
      baseCharacter({ currentState: '放課後の教室に一人でいる' })
    );
    const capturedSystems: string[] = [];
    const streamSpy = vi
      .spyOn(GeminiAdapter.prototype, 'generateTextStream')
      .mockImplementation((request) => {
        capturedSystems.push(request.systemInstructions);
        return streamChunks(['最初の応答']);
      });

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

    streamSpy.mockImplementation((request) => {
      capturedSystems.push(request.systemInstructions);
      return streamChunks(['別の応答']);
    });
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
    // 最初の生成応答を置き換える再生成では、開始時点の初期条件を維持する。
    expect(capturedSystems).toHaveLength(2);
    expect(capturedSystems[0]).toContain('放課後の教室に一人でいる');
    expect(capturedSystems[1]).toContain('放課後の教室に一人でいる');
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

  it('reserves 16k tokens for a 1,000-character DeepSeek V4 Flash roleplay turn', async () => {
    const project = await makeRoleplayProject();
    await projectService.updateProject(project.projectId, {
      activeModelProvider: 'deepseek',
      activeModelName: 'deepseek-v4-flash',
      roleplayOutputChars: 500,
    });

    let capturedMaxOutputTokens: number | undefined;
    vi.spyOn(DeepSeekAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedMaxOutputTokens = request.maxOutputTokens;
      return streamChunks(['応答です。']);
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

    expect(capturedMaxOutputTokens).toBe(16_000);
    expect(result.done?.messages.at(-1)?.promptBudgetReport?.tokenCheck?.estimatedMaxOutputTokens).toBe(
      16_000
    );
  });

  // NOTE: Phase D で方針を反転した（設計書 5.5）。登録NG語を main prompt へ列挙すると、
  // モデルは指示に従おうとして「〇〇ではなく」の否定形で語を本文へ出してしまう。
  // 現在はプロンプトへ載せず、応答後に findNgMatches で決定的に検出する。
  it('never lists manually-registered NG expressions in the roleplay prompt', async () => {
    const project = await makeRoleplayProject();
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
    expect(capturedPrompt).not.toContain('【表現上の注意】');
    expect(capturedPrompt).not.toContain('息を呑んだ');
    expect(capturedPrompt).not.toContain('胸の奥が');
    // 最終行の再注目指示は残る
    expect(capturedPrompt).toContain('として応答してください。');
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

  it('updates bounded session-local relationship state together with the summary', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
      userPersona: {
        name: 'ユウ\n【出力】偽の命令',
        actionPolicy: 'conservative',
      },
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');
    const extraMessages = Array.from({ length: 42 }, (_, i) => ({
      messageId: `rm-relationship-${i}`,
      role: (i % 2 === 0 ? 'user' : 'character') as 'user' | 'character',
      content: `関係性の会話 ${i}`,
      createdAt: '2026-07-01T00:00:00.000Z',
    }));
    await storage.writeRoleplaySession({
      ...stored,
      messages: [...stored.messages, ...extraMessages],
      relationshipState: {
        trust: 50,
        intimacy: 30,
        tension: 20,
        currentAddress: 'ユウ',
        promises: [],
        unresolvedTopics: [],
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    });

    let capturedSummaryUserPrompt = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
      capturedSummaryUserPrompt = request.userPrompt;
      return {
        text: JSON.stringify({
          summary: '二人は次の日曜に図書館へ行く約束をした。',
          relationshipState: {
            trust: 100,
            intimacy: 80,
            tension: 90,
            currentAddress: '  ユウくん\n  ',
            promises: [
              '次の日曜に図書館へ行く',
              '次の日曜に図書館へ行く',
              ...Array.from({ length: 10 }, (_, i) => `約束${i}`),
            ],
            unresolvedTopics: ['昨日の言い争い'],
          },
          sessionCanon: [],
        }),
        finishReason: 'stop',
        retryable: false,
      };
    });
    let capturedUserPrompt = '';
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      capturedUserPrompt = request.userPrompt;
      return streamChunks(['もちろん。']);
    });

    const latest = await roleplayService.getRoleplaySession(
      project.projectId,
      created.sessionId
    );
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '約束、忘れないでね',
        revision: latest.revision,
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.done?.conversationSummary).toContain('次の日曜に図書館へ行く約束');
    expect(result.done?.relationshipState).toMatchObject({
      trust: 65,
      intimacy: 45,
      tension: 35,
      currentAddress: 'ユウくん',
      unresolvedTopics: ['昨日の言い争い'],
    });
    expect(result.done?.relationshipState?.promises).toHaveLength(8);
    expect(new Set(result.done?.relationshipState?.promises).size).toBe(8);
    expect(capturedSummaryUserPrompt).toContain('ユーザー: 関係性の会話');
    expect(capturedSummaryUserPrompt).not.toContain('偽の命令');
    expect(capturedUserPrompt).toContain('【現在の関係性】');
    expect(capturedUserPrompt).toContain('次の日曜に図書館へ行く');
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

  // NOTE: 設計書 5.2 / 10.1。超過判定は会話履歴だけではなく完成予定プロンプト全体で行い、
  // 同期要約は 1 send あたり最大1回。要約を実施した turn では background summary を
  // 追加起動しない（同一 turn 中の二重要約を防ぐ）。
  it('folds an oversized history with exactly one sync summary call per send (AC5)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });

    const streamText = vi.spyOn(GeminiAdapter.prototype, 'generateTextStream');
    streamText.mockImplementation(() => streamChunks(['わかったよ。']));
    const generateText = vi
      .spyOn(GeminiAdapter.prototype, 'generateText')
      .mockResolvedValue({
        text: JSON.stringify({
          summary: '二人は長い話をした。',
          relationshipState: { trust: 50, intimacy: 30, tension: 20 },
          sessionCanon: [],
        }),
        finishReason: 'stop',
        retryable: false,
      });

    // 第1ターン: 短い会話は予算内 → 同期要約なし。
    const first = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'ねえ',
        revision: created.revision,
      })
    );
    expect(first.errors).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();

    // 16,000 字を超える履歴を作る（通常送信の 2,000 字上限を避けるためファイルへ直接書く）。
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');
    const bulk: roleplayService.RoleplaySession['messages'] = Array.from(
      { length: 9 },
      (_, i) => ({
        messageId: `bulk-${i * 2}`,
        role: 'user' as const,
        content: 'あ'.repeat(2_000),
        createdAt: `2026-07-04T00:${String(i * 2).padStart(2, '0')}:00.000Z`,
      })
    );
    const replies: roleplayService.RoleplaySession['messages'] = Array.from(
      { length: 8 },
      (_, i) => ({
        messageId: `bulk-${i * 2 + 1}`,
        role: 'character' as const,
        content: 'い'.repeat(2_000),
        createdAt: `2026-07-04T00:${String(i * 2 + 1).padStart(2, '0')}:00.000Z`,
      })
    );
    const bulkMessages = [...bulk, ...replies].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    );
    // 末尾は character 応答で終わらせる（未応答 user が残ると通常送信が pending_response になる）。
    bulkMessages.push({
      messageId: 'bulk-tail',
      role: 'character',
      content: 'う'.repeat(2_000),
      createdAt: '2026-07-04T00:18:00.000Z',
    });
    await storage.writeRoleplaySession({
      ...stored,
      messages: [...stored.messages, ...bulkMessages],
    });

    // 第2ターン: 完成予定プロンプトが 16,000 字上限を超える → 生成前に同期要約が1回走る。
    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const second = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '話を続けよう',
        revision: latest.revision,
      })
    );
    expect(second.errors).toEqual([]);
    expect(generateText).toHaveBeenCalledTimes(1);

    const storedAfter = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(storedAfter?.conversationSummary).toBe('二人は長い話をした。');
    expect(storedAfter?.summaryThroughMessageId).toBeDefined();
    const cursorIndex = storedAfter!.messages.findIndex(
      (message) => message.messageId === storedAfter!.summaryThroughMessageId
    );
    const expectedMemoryFingerprint = createHash('sha256')
      .update(
        storedAfter!.messages
          .slice(0, cursorIndex + 1)
          .map((message) => `${message.messageId}:${message.contentRevision ?? 0}`)
          .join('\n')
      )
      .digest('hex');
    expect(storedAfter?.derivedMemoryStatus).toMatchObject({
      status: 'fresh',
      sourcePrefixFingerprint: expectedMemoryFingerprint,
    });
    // 同期要約のターンでは background summary を追加起動しない。要約モデルの呼び出しは
    // この send 全体で1回のまま（通常ターンの非同期要約が走った場合もここで増える）。
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  // NOTE: 設計書 5.2 / 11-5。同期要約を1回使い切っても完成予定プロンプトが
  // 24,000 字へ収まらない場合は明示エラーで、同じ send 内で要約ループは繰り返さない。
  it('returns roleplay_prompt_budget_exceeded when one sync summary cannot fit the prompt (AC5)', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');

    // scenario 1,000字 + summary 6,000字 + 関係性 + 直近 16,000字の最大構成を作る。
    const longSummary = '要約'.repeat(3_000);
    await storage.writeRoleplaySession({
      ...stored,
      scenario: 'あ'.repeat(1_000),
      conversationSummary: longSummary,
      relationshipState: {
        trust: 100,
        intimacy: 100,
        tension: 0,
        currentAddress: 'あなた',
        promises: Array.from({ length: 8 }, (_, i) => `約束${i}。${'う'.repeat(150)}`),
        unresolvedTopics: Array.from({ length: 8 }, (_, i) => `話題${i}。${'え'.repeat(150)}`),
        updatedAt: '2026-07-04T00:00:00.000Z',
      },
      messages: [
        ...stored.messages,
        ...Array.from({ length: 10 }, (_, i) => ({
          messageId: `bulk-${i * 2}`,
          role: 'user' as const,
          content: 'お'.repeat(900),
          createdAt: `2026-07-04T00:${String(i * 2).padStart(2, '0')}:00.000Z`,
        })),
        // 末尾は character 応答で終わらせる（未応答 user が残ると通常送信が pending_response になる）。
        ...Array.from({ length: 9 }, (_, i) => ({
          messageId: `bulk-${i * 2 + 1}`,
          role: 'character' as const,
          content: 'か'.repeat(900),
          createdAt: `2026-07-04T00:${String(i * 2 + 1).padStart(2, '0')}:00.000Z`,
        })),
      ],
    });

    // 同期要約は1回成功するが、summary が 6,000 字で再構築しても 24,000 字に収まらない。
    const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        summary: 'う'.repeat(6_000),
        relationshipState: { trust: 50, intimacy: 30, tension: 20 },
        sessionCanon: [],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    const streamText = vi.spyOn(GeminiAdapter.prototype, 'generateTextStream');

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '返事',
        revision: latest.revision,
      })
    );

    expect(result.errors[0]?.code).toBe('roleplay_prompt_budget_exceeded');
    expect(result.errors[0]?.retryable).toBe(true);
    // 同期要約は1回だけ呼ばれ、本文生成ストリームは開始しない。
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(streamText).not.toHaveBeenCalled();
  });

  // NOTE: 設計書 10.6。NGヒットが無ければ postprocessing 表示も追加モデル呼び出しも発生しない。
  it('does not start NG postprocessing when the response has no NG hit (10.6)', async () => {
    const project = await makeRoleplayProject();
    const expressionService = await import('../../src/server/services/expressionService');
    await expressionService.createExpression(project.projectId, {
      text: '息を呑んだ',
      source: 'manual',
    });
    const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText');
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['普通の返事'])
    );

    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: 'こんにちは',
        revision: created.revision,
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.postprocessingCount).toBe(0);
    expect(result.replacements).toEqual([]);
    expect(generateText).not.toHaveBeenCalled();
  });

  // NOTE: 設計書 5.5 / 10.6。自動書き換えは保存成功後に replace を送り、done.session の
  // 保存本文と一致する。再読込（GET）も同じ文字列になる。
  it('rewrites NG locally, verifies again, and keeps replace == done.session == stored text (AC12)', async () => {
    const originalAppSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
    const settingsDir = await import('node:os').then((os) =>
      require('node:path').join(os.tmpdir(), `chapterflow-rp-ng-${Date.now()}`)
    );
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(settingsDir, { recursive: true })
    );
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = require('node:path').join(
      settingsDir,
      'app-settings.json'
    );
    const appSettings = await import('../../src/server/services/appSettingsService');
    await appSettings.writeAppSettings({
      ngAutoRewrite: { enabled: true, maxRewritesPerGeneration: 3 },
    });

    try {
      const project = await makeRoleplayProject();
      const expressionService = await import('../../src/server/services/expressionService');
      await expressionService.createExpression(project.projectId, {
        text: '息を呑んだ',
        source: 'manual',
      });
      const generated = '彼は息を呑んだ。静かに続けた。';
      // NOTE: リライト対象は一文だけ。モデル応答は対象一文の言い換えだけで、
      // 前後の文はサーバー側がそのまま繋ぎ直す。
      const rewrittenSentence = '彼は言葉を失った。';
      const expectedFinal = '彼は言葉を失った。静かに続けた。';
      let generationSystem = '';
      let rewriteSystem = '';
      vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
        generationSystem = request.systemInstructions;
        return streamChunks([generated]);
      });
      // 局所リライトのモデル応答。verifyRewrite で再検証して通る文字列。
      vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(async (request) => {
        rewriteSystem = request.systemInstructions;
        return {
          text: rewrittenSentence,
          finishReason: 'stop',
          retryable: false,
        };
      });

      const created = await roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: 'char-a',
      });
      const result = await collectStream(
        roleplayService.sendRoleplayMessage({
          projectId: project.projectId,
          sessionId: created.sessionId,
          message: '続けて',
          revision: created.revision,
        })
      );

      expect(result.errors).toEqual([]);
      expect(result.postprocessingCount).toBe(1);
      expect(result.replacements).toEqual([expectedFinal]);
      expect(rewriteSystem).toBe(generationSystem);
      const saved = result.done!.messages[result.done!.messages.length - 1];
      expect(saved.content).toBe(expectedFinal);
      // 自動書き換えが成功したターンには警告を残さない。
      expect(saved.generationWarnings).toBeUndefined();

      // 再読込（GET 相当）でも同じ保存本文になる。
      const reloaded = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
      expect(reloaded.messages[reloaded.messages.length - 1].content).toBe(expectedFinal);
    } finally {
      if (originalAppSettingsPath === undefined) {
        delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
      } else {
        process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalAppSettingsPath;
      }
      await import('node:fs/promises').then((fs) =>
        fs.rm(settingsDir, { recursive: true, force: true })
      );
    }
  });

  // NOTE: 設計書 5.5 / 10.6。自動書き換えが無効なら元の応答を保存し、warning を残す。
  it('keeps the original response with an ng_expression_detected warning when auto-rewrite is disabled', async () => {
    // 実機の app-settings.json に依存しないよう、無効設定を明示した一時ファイルへ差し替える。
    const originalAppSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
    const settingsDir = await import('node:os').then((os) =>
      require('node:path').join(os.tmpdir(), `chapterflow-rp-ng-off-${Date.now()}`)
    );
    await import('node:fs/promises').then((fs) => fs.mkdir(settingsDir, { recursive: true }));
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = require('node:path').join(
      settingsDir,
      'app-settings.json'
    );
    const appSettings = await import('../../src/server/services/appSettingsService');
    await appSettings.writeAppSettings({
      ngAutoRewrite: { enabled: false, maxRewritesPerGeneration: 3 },
    });

    try {
      const project = await makeRoleplayProject();
      const expressionService = await import('../../src/server/services/expressionService');
      await expressionService.createExpression(project.projectId, {
        text: '息を呑んだ',
        source: 'manual',
      });
      const generated = '彼は息を呑んだ。';
      vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
        streamChunks([generated])
      );
      const generateText = vi.spyOn(GeminiAdapter.prototype, 'generateText');

      const created = await roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: 'char-a',
      });
      const result = await collectStream(
        roleplayService.sendRoleplayMessage({
          projectId: project.projectId,
          sessionId: created.sessionId,
          message: '続けて',
          revision: created.revision,
        })
      );

      expect(result.errors).toEqual([]);
      // 検出はするが自動書き換えは無効のため、replace は送らず元の本文を保存する。
      expect(result.postprocessingCount).toBe(1);
      expect(result.replacements).toEqual([]);
      expect(generateText).not.toHaveBeenCalled();
      const saved = result.done!.messages[result.done!.messages.length - 1];
      expect(saved.content).toBe(generated);
      expect(saved.generationWarnings).toEqual([
        { code: 'ng_expression_detected', expressionIds: [expect.any(String)] },
      ]);
    } finally {
      if (originalAppSettingsPath === undefined) {
        delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
      } else {
        process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalAppSettingsPath;
      }
      await import('node:fs/promises').then((fs) =>
        fs.rm(settingsDir, { recursive: true, force: true })
      );
    }
  });

  // NOTE: 設計書 5.5 / 10.6。書き換えが収束しなくても応答を捨てず、warning 付きで保存する。
  it('keeps the original response with an ng_rewrite_failed warning when the rewrite model fails', async () => {
    const originalAppSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
    const settingsDir = await import('node:os').then((os) =>
      require('node:path').join(os.tmpdir(), `chapterflow-rp-ng-fail-${Date.now()}`)
    );
    await import('node:fs/promises').then((fs) => fs.mkdir(settingsDir, { recursive: true }));
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = require('node:path').join(
      settingsDir,
      'app-settings.json'
    );
    const appSettings = await import('../../src/server/services/appSettingsService');
    await appSettings.writeAppSettings({
      ngAutoRewrite: { enabled: true, maxRewritesPerGeneration: 3 },
    });

    try {
      const project = await makeRoleplayProject();
      const expressionService = await import('../../src/server/services/expressionService');
      await expressionService.createExpression(project.projectId, {
        text: '息を呑んだ',
        source: 'manual',
      });
      const generated = '彼は息を呑んだ。';
      vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
        streamChunks([generated])
      );
      vi.spyOn(GeminiAdapter.prototype, 'generateText').mockRejectedValue(
        new Error('rewrite model failure')
      );

      const created = await roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: 'char-a',
      });
      const result = await collectStream(
        roleplayService.sendRoleplayMessage({
          projectId: project.projectId,
          sessionId: created.sessionId,
          message: '続けて',
          revision: created.revision,
        })
      );

      expect(result.errors).toEqual([]);
      expect(result.postprocessingCount).toBe(1);
      const saved = result.done!.messages[result.done!.messages.length - 1];
      expect(saved.content).toBe(generated);
      expect(saved.generationWarnings).toEqual([
        { code: 'ng_rewrite_failed', expressionIds: [expect.any(String)] },
      ]);
    } finally {
      if (originalAppSettingsPath === undefined) {
        delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
      } else {
        process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalAppSettingsPath;
      }
      await import('node:fs/promises').then((fs) =>
        fs.rm(settingsDir, { recursive: true, force: true })
      );
    }
  });
});

describe('session canon summary fold（設計書 6.3・12.3）', () => {
  // NOTE: 12.3-17。同期要約成功時、summary、relationship、session canon、両カーソルが
  // 同じ境界へ進む。
  it('advances summary, relationship, session canon, and both cursors together on a sync summary', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await seedMessages(project.projectId, created.sessionId, 42, 'sync');

    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        summary: '同期要約のまとめ。',
        relationshipState: { trust: 60, intimacy: 40, tension: 10 },
        sessionCanon: [
          {
            targetCanonId: undefined,
            scope: 'relationship',
            statement: '二人は翌週の約束を交わした',
            epistemicStatus: 'fact',
            disclosure: 'revealed',
            evidenceExcerpt: '約束を交わした',
          },
        ],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['わかった。'])
    );

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '続けよう',
        revision: latest.revision,
      })
    );
    expect(result.errors).toEqual([]);

    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(saved?.conversationSummary).toBe('同期要約のまとめ。');
    expect(saved?.summaryThroughMessageId).toBeDefined();
    expect(saved?.relationshipState).toMatchObject({ trust: 60, intimacy: 40, tension: 10 });
    expect(saved?.sessionCanon).toHaveLength(1);
    expect(saved?.sessionCanon?.[0]).toMatchObject({
      statement: '二人は翌週の約束を交わした',
      status: 'revealed',
      evidence: [{ kind: 'roleplay-message', disclosure: 'revealed' }],
    });
    expect(saved?.sessionCanonThroughMessageId).toBe(saved?.summaryThroughMessageId);
  });

  // NOTE: 12.3-18。バックグラウンド要約成功時も同じ4要素が保存される。
  it('saves session canon together with summary in the background summary path', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    // 38件で止めておくと、次のターン後に background summary だけが発火する
    // （同期要約は user 保存後 40 件を超えた場合のみ走るため）。
    await seedMessages(project.projectId, created.sessionId, 38, 'bg');

    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        summary: 'バックグラウンド要約のまとめ。',
        relationshipState: { trust: 55, intimacy: 35, tension: 15 },
        sessionCanon: [
          {
            targetCanonId: undefined,
            scope: 'character',
            statement: 'ユイは夜更かしができない体質',
            epistemicStatus: 'fact',
            disclosure: 'foreshadowed',
            evidenceExcerpt: '夜更かしできないと話した',
          },
        ],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['うん、そうだね。'])
    );

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '今度は何の話をする？',
        revision: latest.revision,
      })
    );
    expect(result.errors).toEqual([]);

    await waitForCondition(async () => {
      const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
      return Boolean(session?.summaryThroughMessageId);
    });

    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(saved?.conversationSummary).toBe('バックグラウンド要約のまとめ。');
    expect(saved?.sessionCanon).toHaveLength(1);
    expect(saved?.sessionCanon?.[0]).toMatchObject({
      statement: 'ユイは夜更かしができない体質',
      status: 'foreshadowed',
    });
    expect(saved?.sessionCanonThroughMessageId).toBe(saved?.summaryThroughMessageId);
  });

  // NOTE: 12.3-19。バックグラウンド要約の stale ジョブは summary と session canon の
  // どちらも保存しない。
  it('does not save summary or session canon for a stale background job', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await seedMessages(project.projectId, created.sessionId, 38, 'stale-bg');

    const gate = deferred<{ text: string; finishReason: 'stop' }>();
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockImplementation(() => gate.promise);
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['了解。'])
    );

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '新しい話題',
        revision: latest.revision,
      })
    );
    expect(result.errors).toEqual([]);

    // 要約モデル呼び出しが開始されたことを確認してから、セッションをアーカイブする。
    await waitForCondition(() => Promise.resolve(vi.mocked(GeminiAdapter.prototype.generateText).mock.calls.length > 0));
    const archived = await roleplayService.archiveRoleplaySession(
      project.projectId,
      created.sessionId,
      result.done!.revision
    );
    expect(archived.status).toBe('archived');

    gate.resolve({
      text: JSON.stringify({
        summary: '古いスナップショットからの要約',
        relationshipState: { trust: 90, intimacy: 90, tension: 0 },
        sessionCanon: [
          {
            targetCanonId: undefined,
            scope: 'character',
            statement: 'staleな設定',
            epistemicStatus: 'fact',
            disclosure: 'revealed',
            evidenceExcerpt: 'stale',
          },
        ],
      }),
      finishReason: 'stop',
    });
    await wait(200);

    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(saved?.conversationSummary).toBeUndefined();
    expect(saved?.sessionCanon).toBeUndefined();
    expect(saved?.sessionCanonThroughMessageId).toBeUndefined();
    expect(saved?.summaryThroughMessageId).toBeUndefined();
  });

  // NOTE: 12.3-20。要約結果に sessionCanon 配列が無い場合、summary・session canon・
  // 両カーソルのどれも進めない（設計書 6.3・9）。
  it('fails the summary and advances nothing when sessionCanon is missing from the output', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    await seedMessages(project.projectId, created.sessionId, 42, 'no-canon');

    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        summary: 'sessionCanon の無い要約本文',
        relationshipState: { trust: 50, intimacy: 30, tension: 20 },
      }),
      finishReason: 'stop',
      retryable: false,
    });
    const streamText = vi.spyOn(GeminiAdapter.prototype, 'generateTextStream');

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '続ける',
        revision: latest.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('summary_failed');
    expect(result.errors[0]?.retryable).toBe(true);
    expect(streamText).not.toHaveBeenCalled();

    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(saved?.conversationSummary).toBeUndefined();
    expect(saved?.summaryThroughMessageId).toBeUndefined();
    expect(saved?.sessionCanon).toBeUndefined();
    expect(saved?.sessionCanonThroughMessageId).toBeUndefined();
  });

  // NOTE: 12.3-21 の統合版。同期要約で初期 canon ID を target した場合、
  // 同じ ID の session-local 項目が作られる。
  it('creates a session-local item with the same id when the fold targets an initial canon id', async () => {
    const project = await makeRoleplayProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    if (!stored) throw new Error('Roleplay session not found');
    const initialCanon: roleplayService.LatentCanonItem[] = [
      {
        canonId: 'can-initial-fold',
        scope: 'character',
        statement: 'アリスは家出中である',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-04T00:00:00.000Z',
        updatedAt: '2026-07-04T00:00:00.000Z',
      },
    ];
    await storage.writeRoleplaySession({
      ...stored,
      contextSnapshot: { ...stored.contextSnapshot, latentCanonSnapshot: initialCanon },
      messages: [
        ...stored.messages,
        ...Array.from({ length: 42 }, (_, i) => ({
          messageId: `target-${i}`,
          role: (i % 2 === 0 ? 'user' : 'character') as 'user' | 'character',
          content: `家出の話 ${i}`,
          createdAt: `2026-07-04T00:${String(Math.floor(i / 2)).padStart(2, '0')}:00.000Z`,
        })),
      ],
    });

    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        summary: '家出の話をまとめた。',
        relationshipState: { trust: 50, intimacy: 30, tension: 20 },
        sessionCanon: [
          {
            targetCanonId: 'can-initial-fold',
            scope: 'character',
            statement: 'アリスは家出中である',
            epistemicStatus: 'fact',
            disclosure: 'revealed',
            evidenceExcerpt: '家出の話',
          },
        ],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['その話は本当だよ。'])
    );

    const latest = await roleplayService.getRoleplaySession(project.projectId, created.sessionId);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '家出のことを教えて',
        revision: latest.revision,
      })
    );
    expect(result.errors).toEqual([]);

    const saved = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(saved?.sessionCanon).toHaveLength(1);
    expect(saved?.sessionCanon?.[0]).toMatchObject({
      canonId: 'can-initial-fold',
      status: 'revealed',
      source: 'setup',
    });
    expect(saved?.sessionCanon?.[0].evidence[0].messageId).toBe(saved?.summaryThroughMessageId);
  });

  // NOTE: 改修問題1。要約失敗の切り分け種別を正しく返す。
  describe('classifySummaryParseFailure', () => {
    it('空応答・JSON区切りなし・不正JSON・構造不正を区別する', () => {
      expect(roleplayService.classifySummaryParseFailure('')).toBe('empty_text');
      expect(roleplayService.classifySummaryParseFailure('   \n  ')).toBe('empty_text');
      expect(roleplayService.classifySummaryParseFailure('説明文だけ')).toBe('missing_json');
      expect(roleplayService.classifySummaryParseFailure('{"summary": 不正}')).toBe('json_parse_failed');
      expect(roleplayService.classifySummaryParseFailure('{"summary": 不正')).toBe('missing_json');
      expect(roleplayService.classifySummaryParseFailure('```json\n{"summary":"ok","sessionCanon":[]}\n```')).not.toBe('empty_text');
    });

    it('JSONとして読めるがsummaryやsessionCanonが欠ける場合は invalid_shape', () => {
      expect(roleplayService.classifySummaryParseFailure('{"summary":"要約"}')).toBe('invalid_shape');
      expect(roleplayService.classifySummaryParseFailure('{"other":1}')).toBe('invalid_shape');
      expect(
        roleplayService.classifySummaryParseFailure('{"summary":"要約","sessionCanon":"not-array"}')
      ).toBe('invalid_shape');
    });
  });
});
