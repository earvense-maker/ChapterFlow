import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineChatService from '../../src/server/services/refineChatService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
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

    expect(migrated.schemaVersion).toBe(2);
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

    const result = await refineChatService.sendRefineMessage(
      projectId,
      '秋葉の年齢を30歳に変えて'
    );
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

    const result = await refineChatService.sendRefineMessage(projectId, '何か変えて');
    expect(result.newPatches).toEqual([]);
  });

  it('falls back gracefully on non-JSON response', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, 'これはJSONではありません。');

    const result = await refineChatService.sendRefineMessage(projectId, '相談');
    expect(result.newPatches).toEqual([]);
    expect(result.session.lastError).toContain('解釈できません');
  });

  it('surfaces an empty-response failure with a targeted hint', async () => {
    const projectId = await createTrackedProject();
    mockAssistantResponse(null, '');

    const result = await refineChatService.sendRefineMessage(projectId, 'テスト');
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

    const result = await refineChatService.sendRefineMessage(projectId, 'x');
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

    await refineChatService.sendRefineMessage(projectId, '雑談');
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
    const first = await refineChatService.sendRefineMessage(projectId, '長崎を追加');
    expect(first.newPatches[0].status).toBe('pending');

    mockAssistantResponse({ visibleReply: '別の話題', patches: [] });
    const second = await refineChatService.sendRefineMessage(projectId, '別の話');
    const stalePatch = second.session.patches.find(
      (p) => p.patchId === first.newPatches[0].patchId
    );
    expect(stalePatch?.status).toBe('stale');
  });

  it('rejects overly long messages before calling the model', async () => {
    const projectId = await createTrackedProject();
    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText');

    await expect(
      refineChatService.sendRefineMessage(projectId, 'あ'.repeat(4001))
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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');
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

    const send = await refineChatService.sendRefineMessage(projectId, 'x');
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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');
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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');

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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');

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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');

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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');
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
    const send = await refineChatService.sendRefineMessage(projectId, 'x');
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
}

function mockAssistantResponse(payload: AssistantPayload | null, rawText?: string) {
  const text = rawText ?? '```json\n' + JSON.stringify(payload) + '\n```';
  vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
    text,
    finishReason: 'stop',
    retryable: false,
  });
}
