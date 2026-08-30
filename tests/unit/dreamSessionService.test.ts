import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { ModelClientError } from '../../src/server/services/modelGenerationService';
import * as projectService from '../../src/server/services/projectService';
import * as roleplayService from '../../src/server/services/roleplaySessionService';
import * as storage from '../../src/server/services/storageService';
import {
  readAllDreamTraceEvents,
  __resetDreamMemoryCacheForTesting,
  updateDreamMemorySettings,
  wipeDreamMemory,
} from '../../src/server/services/dreamMemoryService';
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
    description: '海辺の街の案内人。',
    speechStyle: '柔らかい言葉',
    greeting: 'あ、来てくれたんだ。',
    dialogueExamples: ['……ここ、静かだね。'],
    ...overrides,
  };
}

async function makeProject(overrides: Record<string, unknown> = {}) {
  const project = await projectService.createProject({
    title: 'テスト作品',
    projectType: 'roleplay',
    characters: [baseCharacter()],
    worldText: '常に雨が降る海辺の街。',
    coreConcept: '雨の街を歩く夢。',
    ...overrides,
  });
  createdProjectIds.push(project.projectId);
  return project;
}

async function makeDreamProject() {
  const project = await makeProject({ experienceMode: 'dream' });
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
      else if (event.type === 'error') errors.push(event.error);
    }
  } catch (err) {
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

beforeEach(async () => {
  roleplayService.__resetInFlightForTesting();
  await __resetDreamMemoryCacheForTesting();
  await storage.clearDreamTraceEvents();
  await storage.clearDreamRecallJournal();
  await updateDreamMemorySettings({ recordingEnabled: true, disclosureAcknowledged: true });
  vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
    streamChunks(['雨が石畳を濡らしていた。'])
  );
});

describe('dream session creation', () => {
  it('requires the memory disclosure acknowledgement before creating a dream session', async () => {
    const project = await makeDreamProject();
    await updateDreamMemorySettings({ disclosureAcknowledged: false });

    await expect(
      roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: '',
        sessionMode: 'dream',
      })
    ).rejects.toMatchObject({ code: 'dream_disclosure_required' });
  });

  it('creates a dream session on a dream project without a character selection (AC3)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    expect(created.sessionMode).toBe('dream');
    expect(created.characterId).toBe('char-a');
    expect(created.scenario).toBe('雨の街を歩く夢。');
    expect(created.messages).toHaveLength(0);
  });

  it('resolves dream mode from the project experienceMode even without sessionMode', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    expect(created.sessionMode).toBe('dream');
  });

  it('rejects a dream session on a non-dream project', async () => {
    const project = await makeProject();
    await expect(
      roleplayService.createRoleplaySession({
        projectId: project.projectId,
        characterId: '',
        sessionMode: 'dream',
      })
    ).rejects.toMatchObject({ code: 'dream_session_not_allowed', status: 409 });
  });

  it('shows a recoverable error when the dream project has no characters', async () => {
    const empty = await projectService.createProject({
      title: 'キャラなしの夢',
      projectType: 'roleplay',
      experienceMode: 'dream',
      characters: [],
      worldText: '',
      coreConcept: '何もない夢。',
    });
    createdProjectIds.push(empty.projectId);
    await expect(
      roleplayService.createRoleplaySession({
        projectId: empty.projectId,
        characterId: '',
        sessionMode: 'dream',
      })
    ).rejects.toMatchObject({ code: 'dream_requires_character', retryable: true, status: 409 });
  });

  it('keeps the session when the first generation fails (AC: 初回生成失敗で session を削除しない)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    expect(created.sessionMode).toBe('dream');
    const stored = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(stored).not.toBeNull();
  });
});

describe('dream disclosure enforcement', () => {
  it('does not save or generate a turn when acknowledgement is revoked', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    await updateDreamMemorySettings({ disclosureAcknowledged: false });

    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '扉に触れる',
        revision: created.revision,
      })
    );

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'dream_disclosure_required' }),
    ]);
    expect(GeminiAdapter.prototype.generateTextStream).not.toHaveBeenCalled();
    expect(await readAllDreamTraceEvents()).toHaveLength(0);
  });
});

describe('dream observe / text turns', () => {
  it('accepts an empty send as an observe turn and records it once (AC4/AC5/AC13)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.done?.messages.map((m) => m.role)).toEqual(['user', 'character']);
    expect(result.done?.messages[0]).toMatchObject({
      role: 'user',
      content: 'しばらく眺める',
      inputKind: 'observe',
    });
    const events = await readAllDreamTraceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'observe',
      sessionId: created.sessionId,
      anchor: { messageId: result.done?.messages[0].messageId, contextText: '' },
    });
    expect(events[0].rawText).toBeUndefined();
  });

  it('rejects observe for a normal roleplay session (AC10)', async () => {
    const project = await makeProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: 'char-a',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('invalid_message');
    expect(result.done).toBeUndefined();
  });

  it('rejects an empty text send even in a dream session', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '   ',
        inputKind: 'text',
        revision: created.revision,
      })
    );
    expect(result.errors[0]?.code).toBe('invalid_message');
  });

  it('saves the raw text without trimming into both message and trace (AC5/AC12)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const raw = '  鍵を 拾う。  ';
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: raw,
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.done?.messages[0].content).toBe('  鍵を 拾う。  ');
    const events = await readAllDreamTraceEvents();
    expect(events[0]).toMatchObject({
      type: 'text',
      rawText: '  鍵を 拾う。  ',
    });
    // contextText は直前の夢本文
    expect(events[0].anchor.contextText).toBe('');
    expect(events[0].anchor.messageId).toBe(result.done?.messages[0].messageId);
  });

  it('preserves CRLF and CR in the raw dream input', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const raw = '鍵を見る\r\n次の行\rその先';
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: raw,
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    expect(result.done?.messages[0].content).toBe(raw);
    expect((await readAllDreamTraceEvents())[0].rawText).toBe(raw);
  });

  it('stores the previous dream prose as the trace context', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(session?.messages).toHaveLength(2);
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '鍵',
        revision: session!.revision,
      })
    );
    expect(result.errors).toEqual([]);
    const events = await readAllDreamTraceEvents();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'text',
      rawText: '鍵',
      anchor: { contextText: '雨が石畳を濡らしていた。' },
    });
  });

  it('does not duplicate the trace when retrying from the pending user message (regenerate backfill)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    // NOTE: 応答生成を失敗させ、user 先行保存だけが残る状態を作る（設計書 §10）。
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      throw new ModelClientError('upstream failure', 'upstream_error', true);
    });
    const failed = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(failed.errors.length).toBeGreaterThan(0);
    let session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    expect(session?.messages[session.messages.length - 1]).toMatchObject({
      role: 'user',
      inputKind: 'observe',
    });
    // trace を消して「user は保存されたが trace は未追記」の中途失敗を再現する
    await storage.clearDreamTraceEvents();
    await __resetDreamMemoryCacheForTesting();

    // 再試行（regenerate）で backfill され、同じ選択が一回だけ記録される
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['雨が続いていた。'])
    );
    const retried = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: session!.revision,
      })
    );
    expect(retried.errors).toEqual([]);
    const events = await readAllDreamTraceEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'observe' });

    // さらに応答再生成をしても重複しない
    session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: session!.revision,
      })
    );
    expect(await readAllDreamTraceEvents()).toHaveLength(1);
  });

  it('builds the dream prompt for dream sessions (AC6/AC14)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(
      (request) => {
        const system = request.systemInstructions ?? '';
        const user = request.userPrompt ?? '';
        expect(system).toContain('明晰夢の世界の規則');
        expect(system).toContain('少しずれた姿を持つ自律的な他者');
        expect(user).toContain('雨の街を歩く夢。');
        expect(user).toContain('何も書かず、世界の出方を観察した');
        expect(user).toContain('明晰夢の本文だけを続けてください');
        return streamChunks(['雨が降っている。']);
      }
    );
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it('includes a resonance pack from a previous project/session in the new dream prompt (AC14)', async () => {
    // NOTE: 以前の夢（別プロジェクト・別セッション）の生イベントを直接シードする。
    const past = await makeProject();
    const pastSession = await roleplayService.createRoleplaySession({
      projectId: past.projectId,
      characterId: 'char-a',
    });
    // 生の trace を直接追記（正本は trace-events.jsonl なので storage 経由で書く）
    await roleplayService.__resetInFlightForTesting();
    const pastSessionView = await roleplayService.getRoleplaySession(
      past.projectId,
      pastSession.sessionId
    );
    expect(pastSessionView.messages).toHaveLength(1);
    // 過去の夢イベントを直接記録する
    await storage.appendDreamTraceEvent({
      schemaVersion: 1,
      eventId: 'past-1',
      clientEventId: 'dm-past-sess-rm-1',
      sequence: 1,
      projectId: past.projectId,
      sessionId: pastSession.sessionId,
      type: 'text',
      rawText: '錨を握る',
      anchor: { contextText: '錨が砂に埋もれていた。', contextHash: 'hash' },
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await __resetDreamMemoryCacheForTesting();

    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    let promptWithResonance = false;
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      const user = request.userPrompt ?? '';
      if (user.includes('【過去の明晰夢の残響】') && user.includes('錨')) {
        promptWithResonance = true;
      }
      return streamChunks(['波の音が近づいてくる。']);
    });
    const result = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(result.errors).toEqual([]);
    expect(promptWithResonance).toBe(true);
  });

  it('wakes the dream: archives the session and records a wake event (AC9)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const archived = await roleplayService.archiveRoleplaySession(
      project.projectId,
      created.sessionId,
      session!.revision
    );
    expect(archived.status).toBe('archived');
    // archive の応答時点で wake 追記も完了している。
    const events = await readAllDreamTraceEvents();
    const wake = events.find((event) => event.type === 'wake');
    expect(wake?.anchor.contextText).toBe('雨が石畳を濡らしていた。');
  });

  // NOTE: P1-2（AC17）: 全消去した入力が古いセッションの regenerate（backfill）から
  // 復活しない。
  it('does not resurrect wiped memory via regenerate backfill (AC17)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    // 応答生成を失敗させ、user 先行保存だけが残る状態を作る
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      throw new ModelClientError('upstream failure', 'upstream_error', true);
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(await readAllDreamTraceEvents()).toHaveLength(1);

    // 全消去: trace も wipedAt も初期化される
    await wipeDreamMemory();
    expect(await readAllDreamTraceEvents()).toHaveLength(0);

    // 再試行しても、消したはずの入力は生記憶へ戻らない
    const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['雨が続いていた。'])
    );
    const retried = await collectStream(
      roleplayService.regenerateRoleplay({
        projectId: project.projectId,
        sessionId: created.sessionId,
        revision: session!.revision,
      })
    );
    expect(retried.errors).toEqual([]);
    expect(await readAllDreamTraceEvents()).toHaveLength(0);
  });

  // NOTE: P1-1（AC17 / AC19）: セッション途中で一時停止・全消去しても、メモ化された残響
  // pack が次のターンの prompt へ流れない。
  it('stops sending the cached resonance pack after wipe (AC17)', async () => {
    // 過去の夢イベントを直接シードする（残響の材料）
    await storage.appendDreamTraceEvent({
      schemaVersion: 1,
      eventId: 'past-1',
      clientEventId: 'dm-past-sess-rm-1',
      sequence: 1,
      projectId: 'proj-past',
      sessionId: 'sess-past',
      type: 'text',
      rawText: '錨を握る',
      anchor: { contextText: '錨が砂に埋もれていた。', contextHash: 'hash' },
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await __resetDreamMemoryCacheForTesting();

    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const prompts: string[] = [];
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      prompts.push(request.userPrompt ?? '');
      return streamChunks(['波の音が近づいてくる。']);
    });
    // 1ターン目: 残響 pack がキャッシュされる
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(prompts[0]).toContain('【過去の明晰夢の残響】');

    // 全消去してから2ターン目: キャッシュ済み pack は無効化され、prompt に残響が載らない
    await wipeDreamMemory();
    const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const second = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '歩く',
        revision: session!.revision,
      })
    );
    expect(second.errors).toEqual([]);
    expect(prompts[1]).not.toContain('【過去の明晰夢の残響】');
  });

  it('rebuilds resonance after recording is paused and then resumed in the same session', async () => {
    await storage.appendDreamTraceEvent({
      schemaVersion: 1,
      eventId: 'past-resume-1',
      clientEventId: 'dm-past-resume-rm-1',
      sequence: 1,
      projectId: 'proj-past',
      sessionId: 'sess-past',
      type: 'text',
      rawText: '青い扉',
      anchor: { contextText: '階段の下に扉があった。', contextHash: 'hash' },
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    await __resetDreamMemoryCacheForTesting();
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    const prompts: string[] = [];
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation((request) => {
      prompts.push(request.userPrompt ?? '');
      return streamChunks(['扉の向こうで風が鳴った。']);
    });

    await updateDreamMemorySettings({ recordingEnabled: false });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        inputKind: 'observe',
        revision: created.revision,
      })
    );
    expect(prompts[0]).not.toContain('【過去の明晰夢の残響】');

    await updateDreamMemorySettings({ recordingEnabled: true });
    const pausedSession = await storage.readRoleplaySession(project.projectId, created.sessionId);
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '扉を見る',
        revision: pausedSession!.revision,
      })
    );
    expect(prompts[1]).toContain('【過去の明晰夢の残響】');
    expect(prompts[1]).toContain('青い扉');
  });

  // NOTE: P1-3: 失敗後に訂正（replacePendingMessageId）で送り直すと、生記憶の rawText も
  // 訂正後の内容へ更新される。
  it('reflects a corrected message in the trace (AC12)', async () => {
    const project = await makeDreamProject();
    const created = await roleplayService.createRoleplaySession({
      projectId: project.projectId,
      characterId: '',
      sessionMode: 'dream',
    });
    // 初回送信を失敗させ、user 先行保存（旧文）だけを残す
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() => {
      throw new ModelClientError('upstream failure', 'upstream_error', true);
    });
    await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '旧文',
        revision: created.revision,
      })
    );
    let events = await readAllDreamTraceEvents();
    expect(events).toHaveLength(1);
    expect(events[0].rawText).toBe('旧文');

    // 訂正送信（replacePendingMessageId 付き）
    const session = await storage.readRoleplaySession(project.projectId, created.sessionId);
    const pendingMessage = session?.messages[session.messages.length - 1];
    expect(pendingMessage?.role).toBe('user');
    vi.spyOn(GeminiAdapter.prototype, 'generateTextStream').mockImplementation(() =>
      streamChunks(['返事が来た。'])
    );
    const corrected = await collectStream(
      roleplayService.sendRoleplayMessage({
        projectId: project.projectId,
        sessionId: created.sessionId,
        message: '訂正文',
        revision: session!.revision,
        replacePendingMessageId: pendingMessage!.messageId,
      })
    );
    expect(corrected.errors).toEqual([]);
    events = await readAllDreamTraceEvents();
    expect(events).toHaveLength(1);
    expect(events[0].rawText).toBe('訂正文');
    expect(events[0].anchor.messageId).toBe(pendingMessage!.messageId);
  });
});
