import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineChatService from '../../src/server/services/refineChatService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type { Character } from '../../src/server/types/index';

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
    await storage.writeWorld(projectId, '江戸後期の江戸を舞台にした物語。');

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
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"visibleReply":"ok","patches":[]}',
      finishReason: 'stop',
      retryable: false,
    });

    await refineChatService.sendRefineMessage(projectId, '雑談');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].responseMimeType).toBe('application/json');
  });

  it('marks previous pending patches as stale on the next turn', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, '江戸後期の物語。');

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
              fields: { description: '30歳、蘭学者、長崎帰り' },
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
  });

  it('fails to apply a world-replace whose anchor no longer matches, and records the error', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, '本文');
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

  it('rejects patches change status to rejected without touching files', async () => {
    const projectId = await createTrackedProject();
    await storage.writeWorld(projectId, '元の本文');
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
    expect(world).toBe('元の本文');
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
