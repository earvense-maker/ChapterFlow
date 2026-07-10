import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import * as setupSessionService from '../../src/server/services/setupSessionService';
import * as storage from '../../src/server/services/storageService';
import type { MemoryImportance, SetupCommitPlan, SetupDraft } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';
const createdSessionIds: string[] = [];

async function prepareSessionForCommit(
  session: Awaited<ReturnType<typeof setupSessionService.createSetupSession>>['session'],
  plan: SetupCommitPlan
) {
  const prepared = {
    ...session,
    revision: session.revision + 1,
    draft: { ...session.draft, coreConcept: 'Prepared story seed' },
    commitPlan: { plan, createdAt: now },
  };
  await storage.writeSetupSession(prepared);
  return prepared;
}

afterEach(async () => {
  await Promise.all(
    createdSessionIds.map((sessionId) =>
      fs.unlink(storage.setupSessionJsonPath(sessionId)).catch(() => undefined)
    )
  );
  createdSessionIds.length = 0;
});

describe('setupSessionService', () => {
  it('creates a setup session without calling a model when initial message is empty', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    expect(result.session.status).toBe('active');
    expect(result.session.revision).toBe(1);
    expect(result.session.draft.confirmed).toEqual([]);
  });

  it('lists setup sessions with the latest session first', async () => {
    const first = await setupSessionService.createSetupSession({});
    const second = await setupSessionService.createSetupSession({});
    createdSessionIds.push(first.sessionId, second.sessionId);

    const sessions = await setupSessionService.listSetupSessions();

    expect(sessions.map((session) => session.sessionId)).toEqual(
      expect.arrayContaining([first.sessionId, second.sessionId])
    );
    expect(sessions.find((session) => session.sessionId === first.sessionId)).toMatchObject({
      status: 'active',
      messageCount: 0,
    });
  });

  it('rejects stale draft revisions', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.updateSetupDraft(result.sessionId, {
        draft: result.session.draft,
        revision: 0,
      })
    ).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
    });
  });

  it('records manual edit locks when updating a setup draft', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const updated = await setupSessionService.updateSetupDraft(result.sessionId, {
      draft: {
        ...result.session.draft,
        coreConcept: '手動で直した核',
      },
      revision: result.session.revision,
      manualEditPaths: ['draft.coreConcept'],
    });

    expect(updated.session.locks).toContainEqual(
      expect.objectContaining({
        path: 'draft.coreConcept',
        reason: 'manual_edit',
      })
    );
  });

  it('normalizes invalid setup session ids to a 400 service error', async () => {
    await expect(setupSessionService.getSetupSession('../escape')).rejects.toMatchObject({
      code: 'invalid_setup_id',
      status: 400,
    });
  });

  it('does not expose raw model output when setup chat JSON cannot be parsed', () => {
    const rawOutput = '{"visibleReply":"読めてはいけない", "draftPatch":';
    const parsed = setupSessionService.parseChatResult(rawOutput);

    expect(parsed.visibleReply).not.toContain(rawOutput);
    expect(parsed.visibleReply).not.toContain('読めてはいけない');
    expect(parsed.draftPatch).toBeNull();
    expect(parsed.suggestedActions).toEqual([
      {
        label: 'もう一度整理',
        message: '直前の相談内容をもう一度整理してください。',
      },
    ]);
  });

  it('treats plain text replies as visible replies without draft changes', () => {
    const parsed = setupSessionService.parseChatResult('それは興味深い方向ですね。');

    expect(parsed.visibleReply).toBe('それは興味深い方向ですね。');
    expect(parsed.draftPatch).toBeNull();
    expect(parsed.suggestedActions).toEqual([]);
  });

  it('treats fenced plain text as a visible reply', () => {
    const parsed = setupSessionService.parseChatResult('```\n fenced plain text \n```');

    expect(parsed.visibleReply).toBe('fenced plain text');
  });

  it('falls back to a safe message on empty replies', () => {
    const parsed = setupSessionService.parseChatResult('   ```json   ');

    expect(parsed.visibleReply).toContain('読み取れません');
    expect(parsed.draftPatch).toBeNull();
  });

  it('parses marker format with visible reply, patch, summary and suggested actions', () => {
    const raw = `これは表示される返答です。

===DRAFT_PATCH===
{
  "draftPatch": { "coreConcept": "テスト" },
  "suggestedActions": [{ "label": "次へ", "message": "次の候補を見せて" }],
  "conversationSummary": "会話の要約"
}`;
    const parsed = setupSessionService.parseChatResult(raw);

    expect(parsed.visibleReply).toBe('これは表示される返答です。');
    expect(parsed.draftPatch).toEqual({ coreConcept: 'テスト' });
    expect(parsed.suggestedActions).toEqual([{ label: '次へ', message: '次の候補を見せて' }]);
    expect(parsed.conversationSummary).toBe('会話の要約');
  });

  it('keeps visible reply and drops patch when JSON after marker is broken', () => {
    const raw = 'これは表示されます。\n\n===DRAFT_PATCH===\n{"draftPatch": ';
    const parsed = setupSessionService.parseChatResult(raw);

    expect(parsed.visibleReply).toBe('これは表示されます。');
    expect(parsed.draftPatch).toBeNull();
    expect(parsed.suggestedActions).toEqual([]);
    expect(parsed.conversationSummary).toBeNull();
  });

  it('still parses old JSON-only format without marker', () => {
    const raw = JSON.stringify({
      visibleReply: '旧形式の返答',
      draftPatch: { coreConcept: '旧' },
      suggestedActions: [{ label: 'OK', message: 'OK' }],
      conversationSummary: '旧要約',
    });
    const parsed = setupSessionService.parseChatResult(raw);

    expect(parsed.visibleReply).toBe('旧形式の返答');
    expect(parsed.draftPatch).toEqual({ coreConcept: '旧' });
    expect(parsed.suggestedActions).toEqual([{ label: 'OK', message: 'OK' }]);
    expect(parsed.conversationSummary).toBe('旧要約');
  });

  it('treats plain text without marker as a visible reply', () => {
    const parsed = setupSessionService.parseChatResult('素の日本語返答です。');

    expect(parsed.visibleReply).toBe('素の日本語返答です。');
    expect(parsed.draftPatch).toBeNull();
    expect(parsed.conversationSummary).toBeNull();
  });

  it('saves a returned conversation summary truncated to 2000 chars', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const longSummary = 'a'.repeat(2500);
    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: `返答です。

===DRAFT_PATCH===
{ "conversationSummary": "${longSummary}" }`,
      finishReason: 'stop',
      retryable: false,
    });

    try {
      const response = await setupSessionService.sendSetupMessage(result.sessionId, {
        message: 'hello',
        revision: result.session.revision,
      });

      expect(response.session.conversationSummary).toBe(longSummary.slice(0, 2000));
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('rejects missing messages with a 400 error', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.sendSetupMessage(result.sessionId, {
        message: undefined as unknown as string,
        revision: result.session.revision,
      })
    ).rejects.toMatchObject({ code: 'invalid_message', status: 400 });
  });

  it('rejects non-string messages with a 400 error', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.sendSetupMessage(result.sessionId, {
        message: 123 as unknown as string,
        revision: result.session.revision,
      })
    ).rejects.toMatchObject({ code: 'invalid_message', status: 400 });
  });

  it('rejects non-integer revisions with a 400 error', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.sendSetupMessage(result.sessionId, {
        message: 'hello',
        revision: '1' as unknown as number,
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('rejects non-object drafts with a 400 error', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.updateSetupDraft(result.sessionId, {
        draft: 'bad' as unknown as SetupDraft,
        revision: result.session.revision,
      })
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
  });

  it('atomically locks a draft item and adds a lock entry', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const updated = await setupSessionService.updateSetupDraft(result.sessionId, {
      draft: {
        ...result.session.draft,
        confirmed: [
          {
            id: 'fact-1',
            text: '確定事項',
            source: 'manual',
            status: 'active',
            createdAt: result.session.createdAt,
            updatedAt: result.session.createdAt,
          },
        ],
      },
      revision: result.session.revision,
    });

    const locked = await setupSessionService.setLockState(result.sessionId, {
      path: 'fact-1',
      locked: true,
      revision: updated.revision,
    });

    expect(locked.session.draft.confirmed[0].locked).toBe(true);
    expect(locked.session.locks.some((lock) => lock.path === 'fact-1')).toBe(true);
  });

  it('atomically unlocks a draft item and removes lock entries', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const updated = await setupSessionService.updateSetupDraft(result.sessionId, {
      draft: {
        ...result.session.draft,
        confirmed: [
          {
            id: 'fact-1',
            text: '確定事項',
            source: 'manual',
            status: 'active',
            createdAt: result.session.createdAt,
            updatedAt: result.session.createdAt,
          },
        ],
      },
      revision: result.session.revision,
    });

    const locked = await setupSessionService.setLockState(result.sessionId, {
      path: 'fact-1',
      locked: true,
      revision: updated.revision,
    });
    const unlocked = await setupSessionService.setLockState(result.sessionId, {
      path: 'fact-1',
      locked: false,
      revision: locked.revision,
    });

    expect(unlocked.session.draft.confirmed[0].locked).toBe(false);
    expect(unlocked.session.locks.some((lock) => lock.path === 'fact-1')).toBe(false);
  });

  it('rejects lock-state updates with stale revision', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.setLockState(result.sessionId, {
        path: 'draft.world',
        locked: true,
        revision: 0,
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
  });

  it('refuses retry when the last message is not from the user', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.retrySetupMessage(result.sessionId, {})
    ).rejects.toMatchObject({ code: 'nothing_to_retry', status: 400 });
  });

  it('creates commit plan from LLM output and saves it to session', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    const prepared = await setupSessionService.updateSetupDraft(result.sessionId, {
      draft: { ...result.session.draft, coreConcept: 'A story seed' },
      revision: result.session.revision,
    });

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        project: {
          title: 'LLM title',
          outputLength: 3000,
          activePresetIds: result.session.projectSettings.activePresetIds,
        },
        worldText: 'LLM world',
        characters: [],
        memories: [{ type: 'preference', content: 'LLM memory', importance: 'medium' }],
        storyState: {
          schemaVersion: 1,
          currentSituation: ['situation'],
          characterStates: [],
          importantEvents: [],
          openThreads: [{ summary: 'thread', relatedCharacters: [], importance: 'medium', status: 'active' }],
        },
        customSystemPrompt: '',
      }),
      finishReason: 'stop',
      retryable: false,
    });

    try {
      const planResult = await setupSessionService.createSetupCommitPlan(result.sessionId);

      expect(planResult.plan.project.title).toBe('LLM title');
      expect(planResult.plan.worldText).toBe('LLM world');
      expect(planResult.session.commitPlan?.plan.project.title).toBe('LLM title');
      expect(planResult.revision).toBeGreaterThan(prepared.revision);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('rejects commit plan generation before any story seed exists', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.createSetupCommitPlan(result.sessionId)
    ).rejects.toMatchObject({ code: 'setup_content_empty', status: 400 });
  });

  it('rejects direct commit before a story seed and reviewed plan exist', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    const emptyPlan = { project: {}, characters: [], memories: [], storyState: {} } as unknown as SetupCommitPlan;

    await expect(
      setupSessionService.commitSetupSession(result.sessionId, {
        plan: emptyPlan,
        revision: result.session.revision,
      })
    ).rejects.toMatchObject({ code: 'setup_content_empty', status: 400 });

    const seeded = {
      ...result.session,
      revision: result.session.revision + 1,
      draft: { ...result.session.draft, coreConcept: 'Seed only' },
    };
    await storage.writeSetupSession(seeded);
    await expect(
      setupSessionService.commitSetupSession(result.sessionId, {
        plan: emptyPlan,
        revision: seeded.revision,
      })
    ).rejects.toMatchObject({ code: 'setup_plan_missing', status: 400 });
  });

  it('commits using user-edited plan and applies normalization', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const editedPlan: SetupCommitPlan = {
      project: {
        title: 'Edited title',
        outputLength: 12000,
        activePresetIds: { genre: 'unknown-genre', density: 'balanced' },
      },
      worldText: 'Edited world',
      characters: [{ characterId: '../bad', name: 'Edited char', role: 'protagonist', description: 'desc' }],
      memories: [{ memoryId: 'bad id', type: 'preference', content: 'Edited memory', importance: 'high', relatedCharacters: [], relatedEpisodes: [], createdAt: now, updatedAt: now, sourceSceneId: null, status: 'active', source: 'manual' }],
      storyState: {
        schemaVersion: 1,
        currentSituation: ['situation'],
        characterStates: [],
        importantEvents: [],
        openThreads: [{ threadId: 'bad thread', summary: 'thread', relatedCharacters: [], importance: 'invalid' as MemoryImportance, status: 'active', updatedAt: now }],
        updatedAt: now,
      },
      customSystemPrompt: 'Edited system',
    };
    const prepared = await prepareSessionForCommit(result.session, editedPlan);

    const commitResult = await setupSessionService.commitSetupSession(result.sessionId, {
      plan: editedPlan,
      revision: prepared.revision,
    });

    expect(commitResult.projectId).toBeTruthy();
    expect(commitResult.session.status).toBe('committed');

    const project = await storage.readProject(commitResult.projectId);
    expect(project?.title).toBe('Edited title');
    expect(project?.activePresetIds.genre).toBe('modern-drama');

    const characters = await storage.readCharacters(commitResult.projectId);
    expect(characters[0].characterId).toMatch(/^char-/);

    const memories = await storage.readMemories(commitResult.projectId);
    expect(memories.some((memory) => memory.content === 'Edited memory')).toBe(true);

    const storyState = await storage.readStoryState(commitResult.projectId);
    expect(storyState?.openThreads[0].importance).toBe('medium');

    createdSessionIds.push(commitResult.projectId);
  });

  it('returns existing projectId when session is already committed', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const editedPlan: SetupCommitPlan = {
      project: { title: 'Once', outputLength: 3000, activePresetIds: {} },
      worldText: 'world',
      characters: [],
      memories: [],
      storyState: { schemaVersion: 1, currentSituation: [], characterStates: [], importantEvents: [], openThreads: [], updatedAt: now },
      customSystemPrompt: '',
    };
    const prepared = await prepareSessionForCommit(result.session, editedPlan);

    const first = await setupSessionService.commitSetupSession(result.sessionId, {
      plan: editedPlan,
      revision: prepared.revision,
    });
    createdSessionIds.push(first.projectId);

    const second = await setupSessionService.commitSetupSession(result.sessionId, {
      plan: editedPlan,
      revision: first.session.revision,
    });

    expect(second.projectId).toBe(first.projectId);
  });

  it('abandons an active setup session and blocks further updates', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const abandoned = await setupSessionService.abandonSetupSession(result.sessionId);

    expect(abandoned.status).toBe('abandoned');
    expect(abandoned.revision).toBe(result.session.revision + 1);

    await expect(
      setupSessionService.sendSetupMessage(result.sessionId, {
        message: 'hello',
        revision: abandoned.revision,
      })
    ).rejects.toMatchObject({ code: 'setup_not_active', status: 400 });

    await expect(
      setupSessionService.updateSetupDraft(result.sessionId, {
        draft: abandoned.draft,
        revision: abandoned.revision,
      })
    ).rejects.toMatchObject({ code: 'setup_not_active', status: 400 });
  });

  it('rejects abandoning a non-active session', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await setupSessionService.abandonSetupSession(result.sessionId);

    await expect(setupSessionService.abandonSetupSession(result.sessionId)).rejects.toMatchObject({
      code: 'setup_not_active',
      status: 400,
    });
  });

  it('deletes a setup session regardless of status', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await setupSessionService.abandonSetupSession(result.sessionId);

    const deleted = await setupSessionService.deleteSetupSession(result.sessionId);
    expect(deleted).toEqual({ ok: true });

    const afterDelete = await setupSessionService.getSetupSession(result.sessionId);
    expect(afterDelete).toBeNull();
  });

  it('returns 404 when deleting a missing setup session', async () => {
    await expect(setupSessionService.deleteSetupSession('missing-session-id')).rejects.toMatchObject({
      code: 'setup_not_found',
      status: 404,
    });
  });

  it('patches model settings with default model name', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      model: { provider: 'openai' },
      revision: result.session.revision,
    });

    expect(patched.session.model.provider).toBe('openai');
    expect(patched.session.model.modelName).toBe('gpt-4o-mini');
    expect(patched.revision).toBe(result.session.revision + 1);
  });

  it('uses Grok 4.3 as the default xAI consultation model', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      model: { provider: 'xai' },
      revision: result.session.revision,
    });

    expect(patched.session.model).toEqual({ provider: 'xai', modelName: 'grok-4.3' });
  });

  it('patches model settings with explicit model name', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      model: { provider: 'openai', modelName: 'gpt-4o' },
      revision: result.session.revision,
    });

    expect(patched.session.model.modelName).toBe('gpt-4o');
  });

  it('rejects patching settings on an abandoned session', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const abandoned = await setupSessionService.abandonSetupSession(result.sessionId);

    await expect(
      setupSessionService.patchSetupSettings(result.sessionId, {
        model: { provider: 'openai' },
        revision: abandoned.revision,
      })
    ).rejects.toMatchObject({ code: 'setup_not_active', status: 400 });
  });

  it('rejects patching settings with unsupported provider', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.patchSetupSettings(result.sessionId, {
        model: { provider: 'unknown-provider' },
        revision: result.session.revision,
      })
    ).rejects.toMatchObject({ code: 'unsupported_provider', status: 400 });
  });

  it('rejects stale revisions when patching settings', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(
      setupSessionService.patchSetupSettings(result.sessionId, {
        model: { provider: 'openai' },
        revision: 0,
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });
  });

  it('deletes project dir when commit fails after project creation', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const editedPlan: SetupCommitPlan = {
      project: { title: 'Fail', outputLength: 3000, activePresetIds: {} },
      worldText: 'world',
      characters: [],
      memories: [],
      storyState: { schemaVersion: 1, currentSituation: [], characterStates: [], importantEvents: [], openThreads: [], updatedAt: now },
      customSystemPrompt: '',
    };
    const prepared = await prepareSessionForCommit(result.session, editedPlan);

    const deleteSpy = vi.spyOn(storage, 'deleteProjectDir').mockResolvedValue(undefined);
    const writeMemoriesSpy = vi.spyOn(storage, 'writeMemories').mockRejectedValue(new Error('write failed'));

    try {
      await expect(
        setupSessionService.commitSetupSession(result.sessionId, {
          plan: editedPlan,
          revision: prepared.revision,
        })
      ).rejects.toThrow('write failed');

      expect(deleteSpy).toHaveBeenCalled();
    } finally {
      deleteSpy.mockRestore();
      writeMemoriesSpy.mockRestore();
    }
  });
});
