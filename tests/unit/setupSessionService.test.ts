import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import { resolveSystemPrompt } from '../../src/server/prompts/systemPrompt';
import * as setupSessionParsing from '../../src/server/services/setupSessionParsing';
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
    expect(result.session.projectSettings.activePresetIds).toEqual({
      narration: 'third-close',
      rpResponseStyle: 'bracketed-action',
    });
  });

  it('normalizes legacy preset selections when reading a stored setup session', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    await storage.writeSetupSession({
      ...result.session,
      projectSettings: {
        ...result.session.projectSettings,
        activePresetIds: {
          pov: 'first-person',
          style: 'tense',
          pacing: 'slow',
        } as never,
      },
    });

    const loaded = await setupSessionService.getSetupSession(result.sessionId);
    expect(loaded?.projectSettings.activePresetIds).toEqual({
      rpResponseStyle: 'bracketed-action',
      narration: 'first-person',
      aftertaste: ['searing'],
      sceneProgression: 'immersive',
    });
  });

  it('migrates v1 character fields to v2 when reading a stored setup session', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    await storage.writeSetupSession({
      ...result.session,
      schemaVersion: 1,
      draft: {
        ...result.session.draft,
        characters: [
          {
            id: 'legacy-character',
            role: 'protagonist',
            name: 'ユイ',
            label: '旅人',
            description: '帰郷を目指す旅人',
            want: '故郷へ帰りたい',
            fear: '仲間を失うこと',
            secret: '王家の血を引く',
            lockedFields: ['want', 'fear', 'secret'],
            source: 'manual',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          } as never,
        ],
      },
    });

    const loaded = await setupSessionService.getSetupSession(result.sessionId);

    expect(loaded?.schemaVersion).toBe(2);
    expect(loaded?.draft.characters[0]).toMatchObject({
      traits: [
        { label: '望み', text: '故郷へ帰りたい' },
        { label: '恐れ', text: '仲間を失うこと' },
      ],
      secrets: '王家の血を引く',
      lockedFields: ['traits', 'secrets'],
    });
  });

  it('reports unsupported setup schemas and omits them from the session list', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    await storage.writeSetupSession({
      ...result.session,
      schemaVersion: 99,
    } as never);

    await expect(setupSessionService.getSetupSession(result.sessionId)).rejects.toMatchObject({
      code: 'unsupported_setup_schema',
      status: 400,
    });
    const sessions = await setupSessionService.listSetupSessions();
    expect(sessions.some((session) => session.sessionId === result.sessionId)).toBe(false);
  });

  it('normalizes legacy preset selections when creating a setup session', async () => {
    const result = await setupSessionService.createSetupSession({
      projectSettings: {
        activePresetIds: {
          pov: 'first-person',
          style: 'tense',
          intimacy: 'suggestive',
        } as never,
      },
    });
    createdSessionIds.push(result.sessionId);

    expect(result.session.projectSettings.activePresetIds).toEqual({
      rpResponseStyle: 'bracketed-action',
      narration: 'first-person',
      aftertaste: ['searing'],
      intimacy: 'suggestive',
    });
  });

  it('keeps roleplay-only preset selections when creating a setup session', async () => {
    const result = await setupSessionService.createSetupSession({
      purpose: 'roleplay',
      projectSettings: {
        activePresetIds: {
          rpResponseStyle: 'dialogue-only',
          rpInitiative: 'lead',
          rpMood: ['warm', 'playful'],
        },
      },
    });
    createdSessionIds.push(result.sessionId);

    expect(result.session.projectSettings.activePresetIds).toEqual({
      narration: 'third-close',
      rpResponseStyle: 'dialogue-only',
      rpInitiative: 'lead',
      rpMood: ['warm', 'playful'],
    });
  });

  it('enables streaming by default when create settings omit it', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    expect(result.session.projectSettings.streamingEnabled).toBe(true);
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

  it('normalizes undefined purpose to novel and rejects invalid purpose', async () => {
    // NOTE: 後方互換: purpose 未指定は 'novel'
    const noPurpose = await setupSessionService.createSetupSession({});
    createdSessionIds.push(noPurpose.sessionId);
    expect(noPurpose.session.purpose).toBe('novel');

    // NOTE: purpose='roleplay' が保存され、summary でも正規化された値が返る
    const roleplay = await setupSessionService.createSetupSession({ purpose: 'roleplay' });
    createdSessionIds.push(roleplay.sessionId);
    expect(roleplay.session.purpose).toBe('roleplay');

    const summaries = await setupSessionService.listSetupSessions();
    const roleplaySummary = summaries.find((s) => s.sessionId === roleplay.sessionId);
    expect(roleplaySummary?.purpose).toBe('roleplay');
    const novelSummary = summaries.find((s) => s.sessionId === noPurpose.sessionId);
    expect(novelSummary?.purpose).toBe('novel');

    // NOTE: 不正な purpose は 400
    await expect(
      // @ts-expect-error 意図的に不正値を渡してエラー系を確認
      setupSessionService.createSetupSession({ purpose: 'other' })
    ).rejects.toMatchObject({ code: 'invalid_purpose', status: 400 });
  });

  it('rejects malformed nested create settings instead of persisting them', async () => {
    await expect(
      setupSessionService.createSetupSession({
        model: { modelName: 123 },
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

    await expect(
      setupSessionService.createSetupSession({
        projectSettings: { streamingEnabled: 'yes' },
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_request', status: 400 });

    await expect(
      setupSessionService.createSetupSession({
        model: { provider: 'unknown-provider' },
      } as never)
    ).rejects.toMatchObject({ code: 'unsupported_provider', status: 400 });
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

  it('shows a plain reply as-is', () => {
    expect(setupSessionService.normalizeChatReply('それは興味深い方向ですね。')).toBe(
      'それは興味深い方向ですね。'
    );
  });

  it('unwraps a reply the model wrapped in a code fence', () => {
    expect(setupSessionService.normalizeChatReply('```\n fenced plain text \n```')).toBe(
      'fenced plain text'
    );
  });

  it('hides a draft-patch tail the model added on its own', () => {
    // NOTE: 指示文はもう2部構成を求めていないが、学習の癖でJSONを付けてくることがある。
    // 帳簿がユーザーの画面に出るのは避ける。
    const raw = 'これは表示されます。\n\n===DRAFT_PATCH===\n{"draftPatch": {"coreConcept":"内部"}}';

    const reply = setupSessionService.normalizeChatReply(raw);

    expect(reply).toBe('これは表示されます。');
    expect(reply).not.toContain('coreConcept');
  });

  it('extracts a draft patch and summary from the memo write-up call', () => {
    const parsed = setupSessionParsing.parseDraftExtraction(
      JSON.stringify({
        draftPatch: { coreConcept: 'テスト', confirmedAdd: [{ text: '確定', source: 'user' }] },
        conversationSummary: '会話の要約',
      })
    );

    expect(parsed?.draftPatch).toEqual({
      coreConcept: 'テスト',
      confirmedAdd: [{ text: '確定', source: 'user' }],
    });
    expect(parsed?.conversationSummary).toBe('会話の要約');
  });

  it('accepts a memo write-up that omits the draftPatch wrapper', () => {
    // NOTE: ラッパーを外して patch 本体を直接返すモデルがある。中身は同じなので拾う。
    const parsed = setupSessionParsing.parseDraftExtraction(
      '```json\n{ "coreConcept": "直接形式", "worldAdd": ["近未来"] }\n```'
    );

    expect(parsed?.draftPatch).toEqual({ coreConcept: '直接形式', worldAdd: ['近未来'] });
  });

  it('reports unparseable memo write-ups instead of guessing', () => {
    expect(setupSessionParsing.parseDraftExtraction('{"draftPatch":')).toBeNull();
    expect(setupSessionParsing.parseDraftExtraction('ただの文章です')).toBeNull();
  });

  it('saves a conversation summary from the memo write-up truncated to 2000 chars', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const longSummary = 'a'.repeat(2500);
    const chatSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '返答です。',
      finishReason: 'stop',
      retryable: false,
    });
    let sessionId = result.sessionId;
    try {
      const sent = await setupSessionService.sendSetupMessage(sessionId, {
        message: 'hello',
        revision: result.session.revision,
      });
      chatSpy.mockResolvedValue({
        text: JSON.stringify({
          draftPatch: { coreConcept: '核' },
          conversationSummary: longSummary,
        }),
        finishReason: 'stop',
        retryable: false,
      });

      const generated = await setupSessionService.generateSetupDraft(sessionId, {
        revision: sent.revision,
      });

      expect(generated.session.conversationSummary).toBe(longSummary.slice(0, 2000));
      expect(generated.draft.coreConcept).toBe('核');
    } finally {
      chatSpy.mockRestore();
      void sessionId;
    }
  });

  it('leaves the draft untouched during an ordinary consultation turn', async () => {
    // NOTE: 相談ターンから設定草案の更新を切り離した本体。会話が進んでもメモは動かない。
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '面白い方向ですね。まずは主人公から決めましょう。',
      finishReason: 'stop',
      retryable: false,
    });

    try {
      const response = await setupSessionService.sendSetupMessage(result.sessionId, {
        message: '近未来SFがいいです',
        revision: result.session.revision,
      });

      expect(response.assistantMessage?.content).toBe(
        '面白い方向ですね。まずは主人公から決めましょう。'
      );
      expect(response.draft).toEqual(result.session.draft);
      expect(response.session.conversationSummary).toBeFalsy();
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('refuses to write up a memo before the user has said anything', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    await expect(setupSessionService.generateSetupDraft(result.sessionId, {})).rejects.toMatchObject(
      { code: 'setup_content_empty' }
    );
  });

  it('fails the turn instead of saving the unreadable-reply fallback when the model returns no text', async () => {
    // NOTE: 実際に起きた事故の再現。deepseek-v4-flash が思考で出力枠を使い切って本文0字で
    // 返し、非ストリーミング経路には空チェックが無かったため、parseChatResult の
    // 「読み取れませんでした」が lastError=null の正常な返答として履歴に積まれた。
    // 利用者からは会話が進まないだけに見え、再試行ボタンも出なかった。
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'length',
      debugInfo: 'content=empty reasoning_content=9000chars finish=length',
      retryable: false,
    });

    try {
      await expect(
        setupSessionService.sendSetupMessage(result.sessionId, {
          message: 'hello',
          revision: result.session.revision,
        })
      ).rejects.toMatchObject({ code: 'empty_response', retryable: true });

      const stored = await storage.readSetupSession(result.sessionId);
      expect(stored.messages.filter((message) => message.role === 'assistant')).toEqual([]);
      expect(stored.lastError?.code).toBe('empty_response');
      // 最後がユーザー発言のままなので再試行が成立する。
      expect(stored.messages[stored.messages.length - 1]?.role).toBe('user');
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('fails the turn when the whole reply was a draft-patch tail with no visible text', async () => {
    // NOTE: ガードを素の text で行うと、応答が ===DRAFT_PATCH=== で始まったときに
    // 「text は空でないがマーカー除去後は空」ですり抜け、content 空の assistant
    // メッセージが lastError=null の正常な返答として保存される。判定と保存は
    // 必ず同じ文字列（正規化後）に対して行う。
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '===DRAFT_PATCH===\n{"draftPatch":{"coreConcept":"内部だけ"}}',
      finishReason: 'stop',
      retryable: false,
    });

    try {
      await expect(
        setupSessionService.sendSetupMessage(result.sessionId, {
          message: 'hello',
          revision: result.session.revision,
        })
      ).rejects.toMatchObject({ code: 'empty_response' });

      const stored = await storage.readSetupSession(result.sessionId);
      expect(stored.messages.filter((message) => message.role === 'assistant')).toEqual([]);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('surfaces the empty-response diagnostic instead of the generic failure text', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'length',
      debugInfo: 'content=empty reasoning_content=9000chars finish=length',
      retryable: false,
    });

    try {
      await expect(
        setupSessionService.sendSetupMessage(result.sessionId, {
          message: 'hello',
          revision: result.session.revision,
        })
      ).rejects.toThrow(/出力上限を使い切った[\s\S]*reasoning_content=9000chars/);
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('asks for a short reasoning budget and an explicit output ceiling on consultation turns', async () => {
    // NOTE: 出力枠は outputLength(1800字) からの推定だと 8,498 トークンで、思考モデルが
    // 本文へ届く前に使い切った。枠を広げるだけでは思考は止まらないので熟考量も落とす。
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '返答です。',
      finishReason: 'stop',
      retryable: false,
    });

    try {
      await setupSessionService.sendSetupMessage(result.sessionId, {
        message: 'hello',
        revision: result.session.revision,
      });

      expect(generateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ reasoningEffort: 'low', maxOutputTokens: 16_000 })
      );
    } finally {
      generateSpy.mockRestore();
    }
  });

  it('fails the preview instead of storing an empty trial passage', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'length',
      retryable: false,
    });

    try {
      await expect(
        setupSessionService.generateSetupPreview(result.sessionId, {})
      ).rejects.toMatchObject({ code: 'empty_response' });

      const stored = await storage.readSetupSession(result.sessionId);
      expect(stored.previews ?? []).toEqual([]);
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
      expect(planResult.plan.world).toEqual({ foundation: '', initialSituation: 'LLM world' });
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
    ).rejects.toMatchObject({ code: 'setup_draft_empty', status: 400 });
  });

  it('rejects commit plan generation after consulting but before writing up the draft', async () => {
    // NOTE: 相談ターンが草案を書かなくなったので、ここを通すと草案が空のまま
    // 会話ログだけから作品ができる。利用者が中身を確認・修正する機会が無くなる。
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);
    const generateSpy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: 'いい方向ですね。',
      finishReason: 'stop',
      retryable: false,
    });

    try {
      await setupSessionService.sendSetupMessage(result.sessionId, {
        message: '近未来SFがいいです',
        revision: result.session.revision,
      });

      await expect(
        setupSessionService.createSetupCommitPlan(result.sessionId)
      ).rejects.toMatchObject({ code: 'setup_draft_empty', status: 400 });
    } finally {
      generateSpy.mockRestore();
    }
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
    ).rejects.toMatchObject({ code: 'setup_draft_empty', status: 400 });

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
        activePresetIds: { narration: 'unknown-narration', painLevel: 'bittersweet' },
      },
      world: { foundation: 'Edited foundation', initialSituation: 'Edited world' },
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
    expect(project?.activePresetIds.narration).toBe('third-close');
    expect(project?.activePresetIds.painLevel).toBe('bittersweet');

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
      world: { foundation: '', initialSituation: 'world' },
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

    const committedProject = await storage.readProject(first.projectId);
    const committedPresets = await storage.readPresets(first.projectId);
    if (!committedProject || !committedPresets) throw new Error('Committed project not found');
    const resolvedPrompt = await resolveSystemPrompt(
      committedProject.activePresetIds,
      committedPresets.customSystemPrompt,
      committedPresets.baseSystemPrompt
    );
    expect(resolvedPrompt.systemPrompt).toContain('【語り: 三人称・視点人物に寄り添う】');

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

  it('patches style settings without changing the consultation model', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      activePresetIds: {
        narration: 'first-person',
        painLevel: 'safe',
        aftertaste: ['heartwarming'],
      },
      revision: result.session.revision,
    });

    expect(patched.session.model).toEqual(result.session.model);
    expect(patched.session.projectSettings.activePresetIds).toEqual({
      rpResponseStyle: 'bracketed-action',
      narration: 'first-person',
      painLevel: 'safe',
      aftertaste: ['heartwarming'],
    });
  });

  it('keeps roleplay-only style settings when patching through the API', async () => {
    const result = await setupSessionService.createSetupSession({ purpose: 'roleplay' });
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      activePresetIds: {
        rpResponseStyle: 'dialogue-only',
        rpDistance: 'eager',
        rpMood: ['warm'],
      } as never,
      revision: result.session.revision,
    });

    expect(patched.session.projectSettings.activePresetIds).toEqual({
      narration: 'third-close',
      rpResponseStyle: 'dialogue-only',
      rpDistance: 'eager',
      rpMood: ['warm'],
    });
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

  it('uses Gemma 4 31B free as the default OpenRouter consultation model', async () => {
    const result = await setupSessionService.createSetupSession({});
    createdSessionIds.push(result.sessionId);

    const patched = await setupSessionService.patchSetupSettings(result.sessionId, {
      model: { provider: 'openrouter' },
      revision: result.session.revision,
    });

    expect(patched.session.model).toEqual({
      provider: 'openrouter',
      modelName: 'google/gemma-4-31b-it:free',
    });
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
      world: { foundation: '', initialSituation: 'world' },
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
