import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineChatService from '../../src/server/services/refineChatService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { DeepSeekAdapter } from '../../src/server/adapters/deepseekAdapter';
import { OpenAIAdapter } from '../../src/server/adapters/openaiAdapter';
import { JSON_TASK_MAX_OUTPUT_TOKENS } from '../../src/server/utils/outputLength';
import type { Character, RefineSession } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Refine Chat Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

describe('refineChatService.applyWorldReplace', () => {
  it('replaces a unique anchor', () => {
    const result = refineChatService.applyWorldReplace(
      '江戸後期の江戸を舞台にした静かな物語。',
      { anchor: '静かな', replacement: '厳かな' }
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('厳かな物語');
  });

  it('rejects an anchor missing from the text', () => {
    const result = refineChatService.applyWorldReplace('世界設定の本文', {
      anchor: '存在しない文字列',
      replacement: '置換',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('特定できませんでした');
  });

  it('rejects an anchor that appears multiple times', () => {
    const result = refineChatService.applyWorldReplace('あああ 中間 あああ', {
      anchor: 'あああ',
      replacement: 'いいい',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('複数箇所');
  });

  it('rejects empty anchors', () => {
    const result = refineChatService.applyWorldReplace('本文', {
      anchor: '   ',
      replacement: 'x',
    });
    expect(result.ok).toBe(false);
  });
});

describe('refineChatService session lifecycle', () => {
  it('creates a session on first read and persists it', async () => {
    const projectId = await createTrackedProject();
    const s1 = await refineChatService.getOrCreateRefineSession(projectId);
    expect(s1.projectId).toBe(projectId);
    expect(s1.messages).toEqual([]);

    const s2 = await refineChatService.getOrCreateRefineSession(projectId);
    expect(s2.sessionId).toBe(s1.sessionId);
  });

  it('migrates v1 pending patches to stale while preserving terminal patches', async () => {
    const projectId = await createTrackedProject();
    const current = await refineChatService.getOrCreateRefineSession(projectId);
    const operation = { kind: 'world-append' as const, op: { text: '追記' } };
    const legacy: RefineSession = {
      ...current,
      schemaVersion: 1,
      patches: [
        {
          patchId: 'pending',
          createdAt: current.createdAt,
          sourceMessageId: 'msg-1',
          summary: 'pending',
          operations: [operation],
          status: 'pending',
        },
        {
          patchId: 'applied',
          createdAt: current.createdAt,
          sourceMessageId: 'msg-1',
          summary: 'applied',
          operations: [operation],
          status: 'applied',
        },
        {
          patchId: 'rejected',
          createdAt: current.createdAt,
          sourceMessageId: 'msg-1',
          summary: 'rejected',
          operations: [operation],
          status: 'rejected',
        },
      ],
    };
    await storage.writeRefineSession(projectId, legacy);

    const migrated = await refineChatService.getOrCreateRefineSession(projectId);

    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.patches.map((patch) => patch.status)).toEqual([
      'stale',
      'applied',
      'rejected',
    ]);
    expect(migrated.patches[0].applyError).toContain('保存形式が更新');
  });

  it('reset returns a fresh session with different sessionId', async () => {
    const projectId = await createTrackedProject();
    const s1 = await refineChatService.getOrCreateRefineSession(projectId);
    const s2 = await refineChatService.resetRefineSession(projectId);
    expect(s2.sessionId).not.toBe(s1.sessionId);
    expect(s2.messages).toEqual([]);
  });
});

describe('refineChatService sendRefineMessage', () => {
  it('parses assistant patches and stores them as pending', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-akiba',
      name: '秋葉',
      role: 'protagonist',
      description: '27歳、蘭学者',
    };
    await storage.writeCharacters(projectId, [character]);
    await storage.writeWorld(projectId, {
      foundation: '江戸後期の江戸を舞台にした物語。',
      initialSituation: '',
    });

    mockAssistantResponse({
      visibleReply: '秋葉の年齢を30歳に更新します。',
      patches: [
        {
          summary: '秋葉の年齢を27歳→30歳に更新',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-akiba',
              fields: { description: '30歳、蘭学者' },
            },
          ],
        },
      ],
    });

    const result = await refineChatService.sendRefineMessage(projectId, { content: '秋葉の年齢を30歳に変えて' });
    expect(result.newPatches).toHaveLength(1);
    expect(result.newPatches[0].status).toBe('pending');
    expect(result.assistantMessage.patchIds).toEqual([result.newPatches[0].patchId]);
    expect(result.session.messages).toHaveLength(2);
  });

  it('drops patches referencing non-existent characterId', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, []);

    mockAssistantResponse({
      visibleReply: '更新します。',
      patches: [
        {
          summary: 'テスト',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-missing',
              fields: { description: 'x' },
            },
          ],
        },
      ],
    });

    const result = await refineChatService.sendRefineMessage(projectId, { content: '何か変えて' });
    expect(result.newPatches).toEqual([]);
  });

  it('shows a plain-text reply as-is without touching state or patches', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, 'これはJSONではありません。');

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });
    expect(result.newPatches).toEqual([]);
    // NOTE: 壊れた JSON 断片ではないと判定できたので、本文としてそのまま見せる。
    expect(result.assistantMessage.content).toBe('これはJSONではありません。');
    expect(result.assistantMessage.suggestedActions).toBeUndefined();
    expect(result.session.consultationState?.notes).toEqual([]);
    expect(result.session.lastError).toBeNull();
  });

  it('persists the plain-text fallback reply to the session', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, '自然文で返った応答。');

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    const stored = await storage.readRefineSession(projectId);
    expect(stored?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored?.messages[1].content).toBe('自然文で返った応答。');
    expect(stored?.revision).toBe(result.session.revision);
  });

  it('reports a parse failure when the reply looks like broken JSON', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, '{"visibleReply": "途中で切れ');

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });
    expect(result.newPatches).toEqual([]);
    expect(result.session.lastError).toContain('解釈できません');
  });

  it('surfaces an empty-response failure with a targeted hint', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, '');

    const result = await refineChatService.sendRefineMessage(projectId, { content: 'テスト' });
    expect(result.newPatches).toEqual([]);
    expect(result.session.lastError).toContain('空の応答');
  });

  it('accepts a raw JSON response without a code fence', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-a',
      name: 'A',
      role: 'protagonist',
      description: 'x',
    };
    await storage.writeCharacters(projectId, [character]);

    // NOTE: Structured Output が効いた想定でフェンス無しの純 JSON を返す。
    mockAssistantResponse(
      null,
      JSON.stringify({
        visibleReply: '更新します。',
        turnIntent: 'direct-edit',
        patches: [
          {
            summary: '更新',
            operations: [
              { kind: 'character-update', characterId: 'char-a', fields: { description: 'y' } },
            ],
          },
        ],
      })
    );

    const result = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    expect(result.newPatches).toHaveLength(1);
    expect(result.session.lastError).toBeNull();
  });

  it('passes responseMimeType=application/json to the adapter', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      {
        characterId: 'char-a',
        name: 'A',
        role: 'protagonist',
        description: 'x',
        currentState: '出発直後',
      },
    ]);
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"visibleReply":"ok","patches":[]}',
      finishReason: 'stop',
      retryable: false,
    });

    await refineChatService.sendRefineMessage(projectId, { content: '雑談' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].responseMimeType).toBe('application/json');
    expect(spy.mock.calls[0][0].userPrompt).toContain(
      'currentState（開始時点の初期状態）: 出発直後'
    );
  });

  it('marks previous pending patches as stale on the next turn', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '江戸後期の物語。', initialSituation: '' });

    mockAssistantResponse({
      visibleReply: '追記します。',
      patches: [
        {
          summary: '追加',
          operations: [
            { kind: 'world-append', text: '長崎の描写を追加。' },
          ],
        },
      ],
    });
    const first = await refineChatService.sendRefineMessage(projectId, { content: '長崎を追加' });
    expect(first.newPatches[0].status).toBe('pending');

    mockAssistantResponse({ visibleReply: '別の話題', patches: [] });
    const second = await refineChatService.sendRefineMessage(projectId, { content: '別の話' });
    const stalePatch = second.session.patches.find(
      (p) => p.patchId === first.newPatches[0].patchId
    );
    expect(stalePatch?.status).toBe('stale');
  });

  it('rejects overly long messages before calling the model', async () => {
    const projectId = await createTrackedProject();
    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText');

    await expect(
      refineChatService.sendRefineMessage(projectId, { content: 'あ'.repeat(4001) })
    ).rejects.toMatchObject({ code: 'message_too_long', status: 400 });
    expect(generateSpy).not.toHaveBeenCalled();
  });
});

describe('refineChatService applyRefinePatch', () => {
  it('applies a character-update and reflects it in characters.json', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-akiba',
      name: '秋葉',
      role: 'protagonist',
      description: '27歳、蘭学者',
    };
    await storage.writeCharacters(projectId, [character]);

    mockAssistantResponse({
      visibleReply: 'ok',
      patches: [
        {
          summary: '更新',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-akiba',
              fields: {
                description: '30歳、蘭学者、長崎帰り',
                traits: [{ label: 'こだわり', text: '記録は必ず日付順に並べる' }],
              },
            },
          ],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    const patchId = send.newPatches[0].patchId;
    const applied = await refineChatService.applyRefinePatch(projectId, patchId);
    expect(applied.patch.status).toBe('applied');
    const stored = await storage.readCharacters(projectId);
    expect(stored[0].description).toContain('長崎帰り');
    expect(stored[0].traits).toEqual([
      { label: 'こだわり', text: '記録は必ず日付順に並べる' },
    ]);
  });

  it('treats an array-shaped malformed traits update as a normalized full replacement', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      {
        characterId: 'char-akiba',
        name: '秋葉',
        role: 'protagonist',
        description: '蘭学者',
        traits: [{ label: 'こだわり', text: '記録を日付順に並べる' }],
      },
    ]);
    mockAssistantResponse({
      visibleReply: 'ok',
      patches: [
        {
          summary: '不完全な軸を正規化',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-akiba',
              fields: { traits: ['broken'] },
            },
          ],
        },
      ],
    });

    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    await refineChatService.applyRefinePatch(projectId, send.newPatches[0].patchId);

    const stored = await storage.readCharacters(projectId);
    expect(stored[0]).not.toHaveProperty('traits');
  });

  it('fails to apply a world-replace whose anchor no longer matches, and records the error', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '本文', initialSituation: '' });
    mockAssistantResponse({
      visibleReply: '書き換えます',
      patches: [
        {
          summary: '存在しない anchor',
          operations: [
            {
              kind: 'world-replace',
              anchor: '存在しない文字列',
              replacement: '置換',
            },
          ],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    const patchId = send.newPatches[0].patchId;

    await expect(
      refineChatService.applyRefinePatch(projectId, patchId)
    ).rejects.toMatchObject({ code: 'patch_apply_failed' });

    const session = await storage.readRefineSession(projectId);
    const patch = session!.patches.find((p) => p.patchId === patchId);
    expect(patch?.applyError).toContain('特定できませんでした');
    expect(patch?.status).toBe('pending');
  });

  it('applies a new v2 patch against the original ordering of a legacy world document', async () => {
    const projectId = await createTrackedProject();
    await storage.restoreWorldText(
      projectId,
      '法則A\n## 開始時点の状況\n王国は平和\n## 地理\n北に山脈'
    );
    mockAssistantResponse({
      visibleReply: '緊張状態へ更新します',
      patches: [
        {
          summary: '旧形式の境界をまたぐ置換',
          operations: [
            {
              kind: 'world-replace',
              anchor: '王国は平和\n## 地理\n北に山脈',
              replacement: '王国は緊張状態\n## 地理\n北に山脈',
            },
          ],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });

    await refineChatService.applyRefinePatch(projectId, send.newPatches[0].patchId);

    await expect(storage.readWorld(projectId)).resolves.toEqual({
      foundation: '法則A\n## 地理\n北に山脈',
      initialSituation: '王国は緊張状態',
    });
  });

  it('rejects a world-replace that removes a canonical heading', async () => {
    const projectId = await createTrackedProject();
    const original = { foundation: '法則', initialSituation: '停戦中' };
    await storage.writeWorld(projectId, original);
    mockAssistantResponse({
      visibleReply: '見出しを書き換えます',
      patches: [
        {
          summary: '見出し破損',
          operations: [
            {
              kind: 'world-replace',
              anchor: '## 開始時点の状況',
              replacement: '## 現在',
            },
          ],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });

    await expect(
      refineChatService.applyRefinePatch(projectId, send.newPatches[0].patchId)
    ).rejects.toMatchObject({ code: 'patch_apply_failed' });
    await expect(storage.readWorld(projectId)).resolves.toEqual(original);
  });

  it('appends world text to the initial situation', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '法則', initialSituation: '停戦中' });
    mockAssistantResponse({
      visibleReply: '追記します',
      patches: [
        {
          summary: '開始状況へ追記',
          operations: [{ kind: 'world-append', text: '王都では祭りの準備中。' }],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });

    await refineChatService.applyRefinePatch(projectId, send.newPatches[0].patchId);
    await expect(storage.readWorld(projectId)).resolves.toEqual({
      foundation: '法則',
      initialSituation: '停戦中\n\n王都では祭りの準備中。',
    });
  });

  it('rolls world and characters back when a later file write fails', async () => {
    const projectId = await createTrackedProject();
    const originalWorld = { foundation: '法則', initialSituation: '停戦中' };
    const originalCharacter: Character = {
      characterId: 'char-rollback',
      name: 'リナ',
      role: 'protagonist',
      description: '旅人',
    };
    await storage.writeWorld(projectId, originalWorld);
    await storage.writeCharacters(projectId, [originalCharacter]);
    mockAssistantResponse({
      visibleReply: 'まとめて更新します',
      patches: [
        {
          summary: '世界と人物を更新',
          operations: [
            { kind: 'world-append', text: '祭り前夜。' },
            {
              kind: 'character-update',
              characterId: originalCharacter.characterId,
              fields: { description: '王都の旅人' },
            },
          ],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    const patchId = send.newPatches[0].patchId;
    vi.spyOn(storage, 'writeCharacters').mockRejectedValueOnce(new Error('disk full'));

    await expect(refineChatService.applyRefinePatch(projectId, patchId)).rejects.toThrow(
      'disk full'
    );
    await expect(storage.readWorld(projectId)).resolves.toEqual(originalWorld);
    await expect(storage.readCharacters(projectId)).resolves.toEqual([originalCharacter]);
    const session = await storage.readRefineSession(projectId);
    expect(session?.patches.find((item) => item.patchId === patchId)?.status).toBe('pending');
  });

  it('rejects patches change status to rejected without touching files', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, { foundation: '元の本文', initialSituation: '' });
    mockAssistantResponse({
      visibleReply: 'ok',
      patches: [
        {
          summary: '追記',
          operations: [{ kind: 'world-append', text: '追記文' }],
        },
      ],
    });
    const send = await refineChatService.sendRefineMessage(projectId, { content: 'x' });
    const patchId = send.newPatches[0].patchId;

    const rejected = await refineChatService.rejectRefinePatch(projectId, patchId);
    expect(rejected.patch.status).toBe('rejected');
    const world = await storage.readWorld(projectId);
    expect(world).toEqual({ foundation: '元の本文', initialSituation: '' });
  });
});

describe('refineChatService.resetRefineSession preserves auto-scan audit trail', () => {
  it('drops manual-chat history but keeps auto-scan patches and their system messages', async () => {
    const projectId = await createTrackedProject();
    const session = await refineChatService.getOrCreateRefineSession(projectId);
    await storage.writeRefineSession(projectId, {
      ...session,
      messages: [
        { messageId: 'msg-user', role: 'user', content: '手動チャット', createdAt: '2026-07-22T00:00:00.000Z' },
        {
          messageId: 'msg-auto-sys',
          role: 'system',
          content: '自動レビュー結果',
          createdAt: '2026-07-22T00:01:00.000Z',
          automationRunId: 'autorun-preserve',
        },
      ],
      patches: [
        {
          patchId: 'patch-manual',
          createdAt: '2026-07-22T00:00:30.000Z',
          sourceMessageId: 'msg-user',
          summary: '手動 patch',
          operations: [],
          status: 'pending',
        },
        {
          patchId: 'patch-auto',
          createdAt: '2026-07-22T00:01:00.000Z',
          sourceMessageId: 'msg-auto-sys',
          summary: '自動 patch',
          operations: [],
          status: 'applied',
          origin: 'auto-scan',
          automationRunId: 'autorun-preserve',
        },
      ],
    });

    const reset = await refineChatService.resetRefineSession(projectId);
    // 手動 patch と手動 message は消え、auto-scan の patch と対応 system message は残る。
    expect(reset.patches.map((p) => p.patchId)).toEqual(['patch-auto']);
    expect(reset.messages.map((m) => m.messageId)).toEqual(['msg-auto-sys']);
  });

  it('keeps the previous session intact when the replacement write fails', async () => {
    const projectId = await createTrackedProject();
    const session = await refineChatService.getOrCreateRefineSession(projectId);
    const existing = {
      ...session,
      messages: [
        {
          messageId: 'msg-existing',
          role: 'user' as const,
          content: '保存しておく相談',
          createdAt: '2026-07-22T00:00:00.000Z',
        },
      ],
    };
    await storage.writeRefineSession(projectId, existing);
    const writeSpy = vi
      .spyOn(storage, 'writeRefineSession')
      .mockRejectedValueOnce(new Error('simulated write failure'));

    await expect(refineChatService.resetRefineSession(projectId)).rejects.toThrow(
      'simulated write failure'
    );
    writeSpy.mockRestore();

    const after = await storage.readRefineSession(projectId);
    expect(after?.sessionId).toBe(existing.sessionId);
    expect(after?.messages.map((message) => message.messageId)).toEqual(['msg-existing']);
  });
});

describe('refineChatService applyRefinePatch — draft-only auto-scan guard', () => {
  it('rejects manual apply when the source generation is not accepted', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-draft',
      name: 'D',
      role: 'protagonist',
      description: 'desc',
    };
    await storage.writeCharacters(projectId, [character]);
    // draft-only auto-scan patch を直接 session へ埋め込み、source generation を
    // draft のまま置く（accept していない）。
    const draftGen = {
      generationId: 'gen-still-draft',
      sceneId: 'sc',
      episodeId: 'ep',
      request: { wish: '', outputLength: 0, previousContextText: '' },
      responseText: '未採用の下書き。',
      usedPresets: {} as never,
      usedModel: { provider: 'gemini', modelName: 'test' },
      referencedMemoryIds: [],
      status: 'draft' as const,
      createdAt: '2026-07-22T00:00:00.000Z',
      parentGenerationId: null,
    };
    await storage.appendGenerationLog(projectId, draftGen);
    const session = await refineChatService.getOrCreateRefineSession(projectId);
    await storage.writeRefineSession(projectId, {
      ...session,
      patches: [
        {
          patchId: 'patch-draft-1',
          createdAt: '2026-07-22T00:01:00.000Z',
          sourceMessageId: 'msg-x',
          summary: '下書き根拠の補完',
          operations: [
            { kind: 'character-update', characterId: 'char-draft', fields: { speechStyle: '静か' } },
          ],
          status: 'pending',
          origin: 'auto-scan',
          evidenceScope: 'draft',
          sourceGenerationId: 'gen-still-draft',
        },
      ],
    });

    await expect(refineChatService.applyRefinePatch(projectId, 'patch-draft-1')).rejects.toMatchObject({
      code: 'patch_source_generation_not_accepted',
    });
    // 状態は変化していない。
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBeUndefined();
  });

  it('also rejects a mixed auto-scan patch tied to an unaccepted draft', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-mixed-draft', name: 'Mixed', role: 'protagonist', description: 'desc' },
    ]);
    await storage.appendGenerationLog(projectId, {
      generationId: 'gen-mixed-draft',
      sceneId: 'sc',
      episodeId: 'ep',
      request: { wish: '', outputLength: 0, previousContextText: '' },
      responseText: 'An unaccepted draft with mixed evidence.',
      usedPresets: {} as never,
      usedModel: { provider: 'gemini', modelName: 'test' },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-22T00:00:00.000Z',
      parentGenerationId: null,
    });
    const session = await refineChatService.getOrCreateRefineSession(projectId);
    await storage.writeRefineSession(projectId, {
      ...session,
      patches: [
        {
          patchId: 'patch-mixed-draft',
          createdAt: '2026-07-22T00:01:00.000Z',
          sourceMessageId: 'msg-mixed',
          summary: 'Mixed draft evidence must wait for acceptance',
          operations: [
            {
              kind: 'character-update',
              characterId: 'char-mixed-draft',
              fields: { speechStyle: 'quiet' },
            },
          ],
          status: 'pending',
          origin: 'auto-scan',
          evidenceScope: 'mixed',
          sourceGenerationId: 'gen-mixed-draft',
        },
      ],
    });

    await expect(refineChatService.applyRefinePatch(projectId, 'patch-mixed-draft')).rejects.toMatchObject({
      code: 'patch_source_generation_not_accepted',
    });
    expect((await storage.readCharacters(projectId))[0].speechStyle).toBeUndefined();
  });

  it('allows manual apply once the source generation becomes accepted', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, [
      { characterId: 'char-draft2', name: 'D2', role: 'protagonist', description: 'desc' },
    ]);
    await storage.appendGenerationLog(projectId, {
      generationId: 'gen-now-accepted',
      sceneId: 'sc',
      episodeId: 'ep',
      request: { wish: '', outputLength: 0, previousContextText: '' },
      responseText: '採用済みの本文。',
      usedPresets: {} as never,
      usedModel: { provider: 'gemini', modelName: 'test' },
      referencedMemoryIds: [],
      status: 'draft',
      createdAt: '2026-07-22T00:00:00.000Z',
      parentGenerationId: null,
    });
    await storage.appendGenerationStatusLog(projectId, 'gen-now-accepted', 'accepted');
    const session = await refineChatService.getOrCreateRefineSession(projectId);
    await storage.writeRefineSession(projectId, {
      ...session,
      patches: [
        {
          patchId: 'patch-draft-2',
          createdAt: '2026-07-22T00:01:00.000Z',
          sourceMessageId: 'msg-y',
          summary: '採用済み下書き根拠の補完',
          operations: [
            { kind: 'character-update', characterId: 'char-draft2', fields: { speechStyle: '静か' } },
          ],
          status: 'pending',
          origin: 'auto-scan',
          evidenceScope: 'draft',
          sourceGenerationId: 'gen-now-accepted',
        },
      ],
    });

    const result = await refineChatService.applyRefinePatch(projectId, 'patch-draft-2');
    expect(result.patch.status).toBe('applied');
  });
});

interface AssistantPayload {
  visibleReply: string;
  patches: Array<Record<string, unknown>>;
  turnIntent?: string;
  suggestedActions?: Array<Record<string, unknown>>;
  consultationStatePatch?: Record<string, unknown>;
  conversationSummary?: string;
}

function mockAssistantResponse(payload: AssistantPayload | null, rawText?: string) {
  // NOTE: 既定の responseMode は 'auto'。auto でパッチが通るのは turnIntent が
  // 'direct-edit' のときだけなので、パッチを含むケースでは既定で direct-edit を補う。
  // turnIntent を明示したケースはそのまま尊重する。
  const normalized =
    payload && payload.patches.length > 0 && payload.turnIntent === undefined
      ? { ...payload, turnIntent: 'direct-edit' }
      : payload;
  const text = rawText ?? '```json\n' + JSON.stringify(normalized) + '\n```';
  vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
    text,
    finishReason: 'stop',
    retryable: false,
  });
}

// ---------- DeepSeek V4 の thinking 有効化と再試行（設計書 5.3 / 5.5 / 5.7） ----------

interface MockDeepSeekTurn {
  text: string;
  finishReason?: 'stop' | 'length' | 'timeout' | 'error' | 'content_filter';
  debugInfo?: string;
  errorMessage?: string;
  retryable?: boolean;
}

function mockDeepSeekTurns(sequence: MockDeepSeekTurn[]) {
  const spy = vi.spyOn(DeepSeekAdapter.prototype, 'generateText');
  for (const turn of sequence) {
    spy.mockResolvedValueOnce({
      text: turn.text,
      finishReason: turn.finishReason ?? 'stop',
      retryable: turn.retryable ?? false,
      ...(turn.debugInfo !== undefined ? { debugInfo: turn.debugInfo } : {}),
      ...(turn.errorMessage !== undefined ? { errorMessage: turn.errorMessage } : {}),
    });
  }
  return spy;
}

function structuredReply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ visibleReply: '返答', patches: [], ...overrides });
}

async function useDeepSeekProject(projectId: string, modelName = 'deepseek-v4-flash') {
  await projectService.updateProject(projectId, {
    activeModelProvider: 'deepseek',
    activeModelName: modelName,
  });
}

describe('refineChatService DeepSeek reasoning retry flow', () => {
  it('sends thinking enabled / high / 40k tokens / JSON on the first consult turn', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([{ text: structuredReply() }]);

    await refineChatService.sendRefineMessage(projectId, {
      content: '相談',
      responseMode: 'consult',
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const request = spy.mock.calls[0][0];
    expect(request.reasoningMode).toBe('enabled');
    expect(request.reasoningEffort).toBe('high');
    expect(request.maxOutputTokens).toBe(JSON_TASK_MAX_OUTPUT_TOKENS);
    expect(request.responseMimeType).toBe('application/json');
  });

  it('applies the same first-request policy to auto and prepare-patch', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ turnIntent: 'explore' }) },
      { text: structuredReply({ turnIntent: 'prepare-patch' }) },
    ]);

    await refineChatService.sendRefineMessage(projectId, { content: '自由入力' });
    await refineChatService.sendRefineMessage(projectId, {
      content: '候補を作って',
      responseMode: 'prepare-patch',
    });

    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect(call[0].reasoningMode).toBe('enabled');
      expect(call[0].reasoningEffort).toBe('high');
      expect(call[0].maxOutputTokens).toBe(JSON_TASK_MAX_OUTPUT_TOKENS);
      expect(call[0].responseMimeType).toBe('application/json');
    }
  });

  it('does not retry when the first turn is a usable structured reply', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([{ text: structuredReply() }]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.assistantMessage.content).toBe('返答');
    expect(result.session.lastError).toBeNull();
  });

  it('retries with thinking disabled when the first turn is empty', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '', finishReason: 'stop', debugInfo: 'content=empty reasoning_content=100chars' },
      { text: structuredReply() },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    const retry = spy.mock.calls[1][0];
    expect(retry.reasoningMode).toBe('disabled');
    expect(retry.reasoningEffort).toBeUndefined();
    expect(retry.maxOutputTokens).toBe(JSON_TASK_MAX_OUTPUT_TOKENS);
    expect(result.assistantMessage.content).toBe('返答');
    expect(result.session.lastError).toBeNull();
  });

  it('retries on finishReason length even when the JSON is parseable', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ conversationSummary: '切れかけの要約' }), finishReason: 'length' },
      { text: structuredReply() },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('返答');
  });

  it('retries when the structured JSON has an empty visibleReply', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ visibleReply: '' }) },
      { text: structuredReply() },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('返答');
    expect(result.session.lastError).toBeNull();
  });

  it('retries when the first turn is broken JSON', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '{"visibleReply": "途中で切れ' },
      { text: structuredReply() },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('返答');
  });

  it('adopts the retry structured reply over the first plain-text turn', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: 'これはJSONではありません。' },
      { text: structuredReply() },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('返答');
    expect(result.session.consultationState?.notes).toEqual([]);
  });

  it('keeps the first plain-text reply when the retry also fails structurally', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '考えた自然文の返答。' },
      { text: '二回目も自然文。' },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    // NOTE: 初回の thinking あり自然文を優先する（設計書 5.7 #3）。
    expect(result.assistantMessage.content).toBe('考えた自然文の返答。');
    expect(result.assistantMessage.suggestedActions).toBeUndefined();
    expect(result.session.consultationState?.notes).toEqual([]);
    expect(result.newPatches).toEqual([]);
    expect(result.session.lastError).toBeNull();
  });

  it('degrades to the first length result when the retry is unusable', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ visibleReply: 'length でも読めた返答' }), finishReason: 'length' },
      { text: '{"visibleReply": "壊れた' },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('length でも読めた返答');
    expect(result.session.lastError).toBeNull();
  });

  it('prefers the retry when both turns are length but structurally usable', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ visibleReply: '初回の切れかけ' }), finishReason: 'length' },
      { text: structuredReply({ visibleReply: '再試行の切れかけ' }), finishReason: 'length' },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('再試行の切れかけ');
  });

  it('does not adopt an empty-visibleReply result when both turns are unusable', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: structuredReply({ visibleReply: '' }) },
      { text: structuredReply({ visibleReply: '' }) },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.assistantMessage.content).toBe('（応答を解釈できませんでした。もう一度お伝えください）');
    expect(result.session.lastError).not.toBeNull();
  });

  it('stores lastError when both turns are empty or broken', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([{ text: '' }, { text: '{"visibleReply": "途中' }]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.session.lastError).toContain('解釈できません');
  });

  it('reports the length limit hint when the retry ends with truncated JSON', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '{"visibleReply": "壊れた' },
      { text: '{"visibleReply": "途中で切れたJSON断片', finishReason: 'length' },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.session.lastError).toContain('解釈できません');
    expect(result.session.lastError).toContain('出力上限に達し、思考なしの再試行でも');
  });

  it('does not fall back on timeout or error results', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '', finishReason: 'timeout', errorMessage: 'model timed out', retryable: true },
    ]);

    await expect(
      refineChatService.sendRefineMessage(projectId, { content: '相談' })
    ).rejects.toMatchObject({ code: 'model_error', status: 503 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('routes content_filter to the existing parse failure path without retry', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([{ text: '', finishReason: 'content_filter' }]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.session.lastError).toContain('安全フィルタ');
  });

  it('keeps Gemini and OpenAI requests and call counts unchanged', async () => {
    const geminiProjectId = await createTrackedProject();
    const geminiSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"visibleReply":"gemini","patches":[]}',
      finishReason: 'stop',
      retryable: false,
    });
    await refineChatService.sendRefineMessage(geminiProjectId, { content: '相談' });
    expect(geminiSpy).toHaveBeenCalledTimes(1);
    expect(geminiSpy.mock.calls[0][0].reasoningMode).toBeUndefined();
    expect(geminiSpy.mock.calls[0][0].maxOutputTokens).toBeUndefined();

    const openaiProjectId = await createTrackedProject();
    await projectService.updateProject(openaiProjectId, {
      activeModelProvider: 'openai',
      activeModelName: 'gpt-4o-mini',
    });
    const openaiSpy = vi.spyOn(OpenAIAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"visibleReply":"openai","patches":[]}',
      finishReason: 'stop',
      retryable: false,
    });
    await refineChatService.sendRefineMessage(openaiProjectId, { content: '相談' });
    expect(openaiSpy).toHaveBeenCalledTimes(1);
    expect(openaiSpy.mock.calls[0][0].reasoningMode).toBeUndefined();
    expect(openaiSpy.mock.calls[0][0].maxOutputTokens).toBeUndefined();
  });

  it('does not duplicate messages, notes, or patches across the retry', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId);
    const spy = mockDeepSeekTurns([
      { text: '{"visibleReply": "壊れた' },
      {
        text: structuredReply({
          visibleReply: '候補を作りました',
          turnIntent: 'direct-edit',
          consultationStatePatch: {
            add: [{ kind: 'confirmed', text: '主人公の年齢を30歳に' }],
          },
          patches: [
            {
              summary: '更新',
              operations: [
                {
                  kind: 'character-update',
                  characterId: 'char-dup',
                  fields: { description: '30歳' },
                },
              ],
            },
          ],
        }),
      },
    ]);
    await storage.writeCharacters(projectId, [
      { characterId: 'char-dup', name: 'D', role: 'protagonist', description: '27歳' },
    ]);

    const result = await refineChatService.sendRefineMessage(projectId, { content: '年齢を変えて' });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.session.messages).toHaveLength(2);
    expect(result.session.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(result.session.consultationState?.notes).toHaveLength(1);
    expect(result.newPatches).toHaveLength(1);
    expect(result.session.patches).toHaveLength(1);
  });

  it('sends no reasoning fields on non-V4 DeepSeek models', async () => {
    const projectId = await createTrackedProject();
    await useDeepSeekProject(projectId, 'deepseek-chat');
    const spy = mockDeepSeekTurns([{ text: structuredReply() }]);

    await refineChatService.sendRefineMessage(projectId, { content: '相談' });

    expect(spy).toHaveBeenCalledTimes(1);
    const request = spy.mock.calls[0][0];
    expect(request.reasoningMode).toBeUndefined();
    expect(request.reasoningEffort).toBeUndefined();
    expect(request.maxOutputTokens).toBeUndefined();
  });
});
