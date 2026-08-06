import { afterEach, describe, expect, it, vi } from 'vitest';
import * as storage from '../../src/server/services/storageService';
import {
  mergeKnowledgeList,
  mergeStoryState,
  replaceStoryState,
  updateStoryStateFromAcceptedScene,
} from '../../src/server/services/storyStateService';
import type {
  AdapterGenerateResult,
  Character,
  GenerationRecord,
  ModelAdapter,
  Project,
  StoryState,
} from '../../src/server/types/index';

const projectId = 'proj-story-state-test';
const now = '2026-07-04T00:00:00.000Z';

afterEach(async () => {
  await storage.deleteProjectDir(projectId);
});

describe('mergeStoryState', () => {
  it('uses the shared normalized matcher and leaves ambiguous aliases without a character id', () => {
    const characters: Character[] = [
      {
        characterId: 'char-alice',
        name: 'Ａｌｉｃｅ　Smith',
        role: 'protagonist',
        description: '',
      },
      {
        characterId: 'char-a',
        name: 'アキ',
        role: 'supporting',
        description: '',
        aliases: ['共通名'],
      },
      {
        characterId: 'char-mina',
        name: 'ミナ',
        role: 'supporting',
        description: '',
        aliases: ['旧　Ｍｉｎａ'],
      },
      {
        characterId: 'char-b',
        name: 'ユイ',
        role: 'supporting',
        description: '',
        aliases: ['共通名'],
      },
    ];

    const merged = mergeStoryState(
      storyState(),
      {
        characterStates: [
          { name: 'alice smith', currentState: '王都にいる' },
          { name: '旧 Mina', currentState: '別名で照合する' },
          { name: '共通名', currentState: '照合しない' },
        ],
      },
      now,
      characters
    );

    expect(merged.characterStates).toMatchObject([
      { characterId: 'char-alice', name: 'Ａｌｉｃｅ　Smith', currentState: '王都にいる' },
      { characterId: 'char-mina', name: 'ミナ', currentState: '別名で照合する' },
      { characterId: null, name: '共通名', currentState: '照合しない' },
    ]);
  });

  it('keeps existing important events and threads when the model omits them', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-keep',
          sceneId: 'scene-old',
          summary: '主人公は秘密の約束をした',
          characters: ['主人公'],
          visibility: '主人公だけが知っている',
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
      openThreads: [
        {
          threadId: 'thread-keep',
          summary: '鍵の持ち主がまだ不明',
          relatedCharacters: ['主人公'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    const merged = mergeStoryState(
      previous,
      {
        currentSituation: ['翌朝、主人公は駅にいる'],
        importantEvents: [
          {
            eventId: '',
            sceneId: 'scene-new',
            summary: '相手役が駅で主人公を待っていた',
            characters: ['相手役'],
            visibility: '読者には明示',
            importance: 'medium',
            status: 'active',
          },
        ],
        openThreads: [],
      },
      now
    );

    expect(merged.currentSituation).toEqual(['翌朝、主人公は駅にいる']);
    expect(merged.importantEvents.map((event) => event.summary)).toEqual([
      '主人公は秘密の約束をした',
      '相手役が駅で主人公を待っていた',
    ]);
    expect(merged.importantEvents[0].eventId).toBe('evt-keep');
    expect(merged.openThreads.map((thread) => thread.threadId)).toEqual(['thread-keep']);
  });

  it('archives existing events and threads only when explicitly requested', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-archive',
          sceneId: 'scene-old',
          summary: '古い誤解が残っている',
          characters: [],
          visibility: '',
          importance: 'medium',
          status: 'active',
          updatedAt: now,
        },
      ],
      openThreads: [
        {
          threadId: 'thread-archive',
          summary: '誰が手紙を書いたのか',
          relatedCharacters: [],
          importance: 'medium',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    const merged = mergeStoryState(
      previous,
      {
        archiveEventIds: ['evt-archive'],
        archiveThreadIds: ['thread-archive'],
      },
      now
    );

    expect(merged.importantEvents[0].status).toBe('archived');
    expect(merged.openThreads[0].status).toBe('archived');
  });

  it('updates existing records by id without duplicating them', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-update',
          sceneId: 'scene-old',
          summary: '古い要約',
          characters: ['A'],
          visibility: '',
          importance: 'medium',
          status: 'active',
          updatedAt: now,
        },
      ],
      openThreads: [
        {
          threadId: 'thread-update',
          summary: '古い疑問',
          relatedCharacters: ['A'],
          importance: 'medium',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [
          {
            eventId: 'evt-update',
            summary: '約束の内容が読者に明かされた',
            importance: 'high',
          },
        ],
        openThreads: [
          {
            threadId: 'thread-update',
            summary: '古い疑問',
            status: 'resolved',
          },
        ],
      },
      now
    );

    expect(merged.importantEvents).toHaveLength(1);
    expect(merged.importantEvents[0]).toMatchObject({
      eventId: 'evt-update',
      sceneId: 'scene-old',
      summary: '約束の内容が読者に明かされた',
      characters: ['A'],
      importance: 'high',
    });
    expect(merged.openThreads).toHaveLength(1);
    expect(merged.openThreads[0].status).toBe('resolved');
  });
});

describe('mergeStoryState clock', () => {
  it('preserves time and note when a clock patch only advances the day', () => {
    const merged = mergeStoryState(
      storyState({
        clock: {
          day: 2,
          timeOfDay: 'night',
          note: 'before the festival',
        },
      }),
      {
        clock: {
          day: 3,
        },
      },
      now
    );

    expect(merged.clock).toEqual({
      day: 3,
      timeOfDay: 'night',
      note: 'before the festival',
    });
  });
});

describe('updateStoryStateFromAcceptedScene', () => {
  it('merges model output with the latest stored state before writing', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(
      projectId,
      storyState({
        importantEvents: [
          {
            eventId: 'evt-existing',
            sceneId: 'scene-old',
            summary: '消えてはいけない出来事',
            characters: [],
            visibility: '',
            importance: 'high',
            status: 'active',
            updatedAt: now,
          },
        ],
      })
    );

    const adapter = fakeAdapter({
      text: JSON.stringify({
        currentSituation: ['新しい現在状況'],
        importantEvents: [
          {
            eventId: '',
            sceneId: 'scene-new',
            summary: '新しく採用された出来事',
            characters: [],
            visibility: '',
            importance: 'medium',
            status: 'active',
          },
        ],
      }),
      finishReason: 'stop',
      retryable: false,
    });

    const updated = await updateStoryStateFromAcceptedScene({
      project: project(),
      adapter,
      generation: generation(),
      characters: [],
      worldText: '',
      timeoutMs: 1000,
    });

    expect(updated?.importantEvents.map((event) => event.summary)).toEqual([
      '消えてはいけない出来事',
      '新しく採用された出来事',
    ]);
    await expect(storage.readStoryState(projectId)).resolves.toMatchObject({
      currentSituation: ['新しい現在状況'],
    });
    const [diff] = await storage.readStoryStateDiffs(projectId);
    expect(diff.previousUpdatedAt).toBe(now);
  });

  // NOTE: initialState は「まだ現在状態が無い人物」の足場。既存 characterStates に
  // 現在状態がある人物へ重ねて渡すと、同じ prompt 内の新しい状態と競合する。
  it('sends initialState only for characters without a tracked current state', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(
      projectId,
      storyState({
        characterStates: [
          {
            characterId: 'char-tracked',
            name: '追跡済み',
            currentState: '負傷して街道を離れた',
            knowledge: [],
            relationships: [],
            updatedAt: now,
          },
        ],
      })
    );
    const characters: Character[] = [
      {
        characterId: 'char-tracked',
        name: '追跡済み',
        role: 'protagonist',
        description: '',
        currentState: '街道の宿で朝を迎えた',
      },
      {
        characterId: 'char-untouched',
        name: '未登場',
        role: 'supporting',
        description: '',
        currentState: '遠い港町で船を待っている',
      },
    ];
    let capturedUserPrompt = '';
    const adapter: ModelAdapter = {
      providerName: 'fake',
      generateText: vi.fn(async (request) => {
        capturedUserPrompt = request.userPrompt;
        return { text: JSON.stringify({}), finishReason: 'stop', retryable: false };
      }),
      validateConnection: vi.fn(),
    };

    await updateStoryStateFromAcceptedScene({
      project: project(),
      adapter,
      generation: generation(),
      characters,
      worldText: '',
      timeoutMs: 1000,
    });

    // 現在状態が既にある人物の初期状態は渡さない。現在状態は既存JSON側に載っている。
    expect(capturedUserPrompt).not.toContain('街道の宿で朝を迎えた');
    expect(capturedUserPrompt).toContain('負傷して街道を離れた');
    // まだ状態の無い人物は従来どおり初期状態を足場として渡す。
    expect(capturedUserPrompt).toContain('遠い港町で船を待っている');
  });

  it('requests JSON and retries once after an output-limit finish, even when the JSON is valid', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(projectId, storyState());
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ currentSituation: ['構文上は読めるが出力上限に達した状態'] }),
        finishReason: 'length',
        retryable: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ currentSituation: ['再試行で抽出できた状態'] }),
        finishReason: 'stop',
        retryable: false,
      });
    const adapter: ModelAdapter = {
      providerName: 'fake',
      generateText,
      validateConnection: vi.fn(),
    };

    const updated = await updateStoryStateFromAcceptedScene({
      project: project(),
      adapter,
      generation: generation(),
      characters: [],
      worldText: '',
      timeoutMs: 1000,
    });

    expect(updated?.currentSituation).toEqual(['再試行で抽出できた状態']);
    expect(generateText).toHaveBeenCalledTimes(2);
    // NOTE: Track 2A: initial 4000 → 6000, retry 6000 → 9000 に引き上げた。
    // レビュー #3: OpenAI 系のハードキャップ 16384 に張り付いて retry の
    // headroom が消える問題があったため、明示的な maxOutputTokens も渡す
    // （initial 8192、retry 15000）。
    expect(generateText.mock.calls[0][0]).toMatchObject({
      outputLength: 6000,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    });
    expect(generateText.mock.calls[1][0]).toMatchObject({
      outputLength: 9000,
      maxOutputTokens: 15000,
      responseMimeType: 'application/json',
    });
  });

  it('does not mark a generation as processed when both responses hit the output limit', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(projectId, storyState());
    const adapter = fakeAdapter({
      text: JSON.stringify({ currentSituation: ['不完全な可能性がある状態'] }),
      finishReason: 'length',
      retryable: false,
    });

    await expect(
      updateStoryStateFromAcceptedScene({
        project: project(),
        adapter,
        generation: generation(),
        characters: [],
        worldText: '',
        timeoutMs: 1000,
      })
    ).rejects.toThrow('出力上限');
    expect((await storage.readStoryState(projectId))?.processedGenerationIds ?? []).toEqual([]);
  });
});

function storyState(patch: Partial<StoryState> = {}): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    updatedAt: now,
    ...patch,
  };
}

function project(): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: 'Story State Test',
    createdAt: now,
    updatedAt: now,
    activeModelProvider: 'openai',
    activeModelName: 'gpt-test',
    outputLength: 3000,
    streamingEnabled: false,
    activePresetIds: {
      narration: 'third-close',
    },
  };
}

function generation(): GenerationRecord {
  return {
    generationId: 'gen-story-state',
    episodeId: 'ep-story-state',
    sceneId: 'scene-new',
    request: {
      wish: '',
      outputLength: 3000,
      previousContextText: '',
    },
    responseText: '採用された本文',
    usedPresets: project().activePresetIds,
    usedModel: {
      provider: 'openai',
      modelName: 'gpt-test',
    },
    referencedMemoryIds: [],
    status: 'accepted',
    createdAt: now,
    parentGenerationId: null,
  };
}

function fakeAdapter(result: AdapterGenerateResult): ModelAdapter {
  return {
    providerName: 'fake',
    generateText: vi.fn(async () => result),
    validateConnection: vi.fn(),
  };
}

// NOTE: Track 1A: actor / recipient の正規化とマージ挙動。
describe('mergeStoryState - actor / recipient (Track 1A)', () => {
  const characters: Character[] = [
    { characterId: 'char-taro', name: '太郎', role: 'protagonist', description: '' },
    { characterId: 'char-hanako', name: '花子', role: 'deuteragonist', description: '' },
  ];

  it('normalizes actor and recipient to null when the ID is not in the character list', () => {
    const merged = mergeStoryState(
      storyState(),
      {
        importantEvents: [
          {
            eventId: '',
            sceneId: 'scene-1',
            summary: '独白の場面',
            characters: ['太郎'],
            actor: 'char-unknown',
            recipient: 'char-hanako',
            importance: 'medium',
            status: 'active',
          },
        ],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].actor).toBeNull();
    expect(merged.importantEvents[0].recipient).toBe('char-hanako');
  });

  it('preserves existing actor / recipient when the patch omits the keys', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: '太郎が花子に告白した',
          characters: ['太郎', '花子'],
          visibility: '',
          actor: 'char-taro',
          recipient: 'char-hanako',
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });

    // NOTE: パッチに actor / recipient キーが無いため、既存値を保持する。
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [{ eventId: 'evt-1', importance: 'medium' }],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].actor).toBe('char-taro');
    expect(merged.importantEvents[0].recipient).toBe('char-hanako');
    expect(merged.importantEvents[0].importance).toBe('medium');
  });

  it('overwrites existing actor / recipient to null when the patch explicitly sends null', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: '主体不明な出来事',
          characters: [],
          visibility: '',
          actor: 'char-taro',
          recipient: 'char-hanako',
          importance: 'medium',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [{ eventId: 'evt-1', actor: null, recipient: null }],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].actor).toBeNull();
    expect(merged.importantEvents[0].recipient).toBeNull();
  });

  // NOTE: レビュー #2: 人物一覧が空でも LLM 出力の actor/recipient を strict に検証すること。
  // 空の characters で mergeStoryState を呼んでも、任意文字列（"太郎"、"nobody"）は
  // null に落とす（保存も表示もしない）。読み込み経路は preserve が使われるため、
  // ここは書き込み経路の strict 検証のみを対象とする。
  it('strictly rejects actor / recipient values that are not real character IDs even when characters is empty (review #2)', () => {
    const merged = mergeStoryState(
      storyState(),
      {
        importantEvents: [
          {
            eventId: '',
            summary: 'LLM が名前や"nobody"を返してきた',
            characters: ['太郎'],
            actor: '太郎',
            recipient: 'nobody',
            importance: 'medium',
            status: 'active',
          },
        ],
      },
      now,
      []
    );
    expect(merged.importantEvents[0].actor).toBeNull();
    expect(merged.importantEvents[0].recipient).toBeNull();
  });

  it('strictly rejects arbitrary actor / recipient values on full-state replacement with no characters', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(projectId, storyState());

    const replaced = await replaceStoryState({
      projectId,
      characters: [],
      storyState: storyState({
        importantEvents: [
          {
            eventId: 'evt-replace',
            sceneId: null,
            summary: '人物未登録の状態で入力されたイベント',
            characters: ['太郎'],
            visibility: '',
            actor: '太郎',
            recipient: 'nobody',
            importance: 'medium',
            status: 'active',
            updatedAt: now,
          },
        ],
      }),
    });

    expect(replaced.importantEvents[0].actor).toBeNull();
    expect(replaced.importantEvents[0].recipient).toBeNull();
  });

  it('extracts actor / recipient independently from knownBy', () => {
    // NOTE: 背後からの攻撃で actor は入るが recipient は knownBy に入らないケース。
    // 自動包含していないことを検証する。パッチキーは Track 2A の addUnknownBy を使う。
    const merged = mergeStoryState(
      storyState(),
      {
        importantEvents: [
          {
            eventId: '',
            summary: '太郎が背後から花子を襲った',
            characters: ['太郎', '花子'],
            actor: 'char-taro',
            recipient: 'char-hanako',
            knownBy: ['char-taro'],
            addUnknownBy: ['char-hanako'],
            importance: 'high',
            status: 'active',
          },
        ],
      },
      now,
      characters
    );
    const event = merged.importantEvents[0];
    expect(event.actor).toBe('char-taro');
    expect(event.recipient).toBe('char-hanako');
    expect(event.knownBy).toContain('char-taro');
    expect(event.knownBy ?? []).not.toContain('char-hanako');
    expect(event.explicitlyUnknownBy).toContain('char-hanako');
  });
});

// NOTE: Track 2A: explicitlyUnknownBy の additive 化と反転運用の検証。
describe('mergeStoryState - addUnknownBy / removeUnknownBy (Track 2A)', () => {
  const characters: Character[] = [
    { characterId: 'char-a', name: 'A', role: 'protagonist', description: '' },
    { characterId: 'char-b', name: 'B', role: 'deuteragonist', description: '' },
    { characterId: 'char-c', name: 'C', role: 'supporting', description: '' },
    { characterId: 'char-d', name: 'D', role: 'supporting', description: '' },
  ];

  it('adds unknown IDs to the existing explicitlyUnknownBy via addUnknownBy', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: 'A と B の秘密',
          characters: ['A', 'B'],
          visibility: '',
          knownBy: ['char-a', 'char-b'],
          explicitlyUnknownBy: ['char-c'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [
          { eventId: 'evt-1', addUnknownBy: ['char-d'] },
        ],
      },
      now,
      characters
    );
    // 既存の char-c は保持されつつ char-d が追加される
    expect(merged.importantEvents[0].explicitlyUnknownBy).toEqual(['char-c', 'char-d']);
  });

  it('removes IDs from explicitlyUnknownBy via removeUnknownBy', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: 'A と B の秘密',
          characters: ['A', 'B'],
          visibility: '',
          knownBy: ['char-a', 'char-b'],
          explicitlyUnknownBy: ['char-c', 'char-d'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [
          { eventId: 'evt-1', removeUnknownBy: ['char-c'] },
        ],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].explicitlyUnknownBy).toEqual(['char-d']);
  });

  it('applies removeUnknownBy after addUnknownBy in the same patch', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: 'A と B の秘密',
          characters: ['A', 'B'],
          visibility: '',
          knownBy: ['char-a', 'char-b'],
          explicitlyUnknownBy: ['char-c'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [
          {
            eventId: 'evt-1',
            addUnknownBy: ['char-d'],
            removeUnknownBy: ['char-d'],
          },
        ],
      },
      now,
      characters
    );
    // 同一パッチで add + remove が競合すると remove が勝つ
    expect(merged.importantEvents[0].explicitlyUnknownBy).toEqual(['char-c']);
  });

  it('auto-removes IDs from explicitlyUnknownBy when they are in knownBy', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: 'A と B の秘密',
          characters: [],
          visibility: '',
          knownBy: ['char-a', 'char-b'],
          explicitlyUnknownBy: ['char-c'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    // learnedBy 経由で char-c が knownBy に移る
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [{ eventId: 'evt-1', learnedBy: ['char-c'] }],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].knownBy).toContain('char-c');
    expect(merged.importantEvents[0].explicitlyUnknownBy ?? []).not.toContain('char-c');
  });

  it('ignores legacy explicitlyUnknownBy patch key without destroying existing values', () => {
    const previous = storyState({
      importantEvents: [
        {
          eventId: 'evt-1',
          sceneId: 'scene-1',
          summary: 'A と B の秘密',
          characters: [],
          visibility: '',
          knownBy: ['char-a', 'char-b'],
          explicitlyUnknownBy: ['char-c', 'char-d'],
          importance: 'high',
          status: 'active',
          updatedAt: now,
        },
      ],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const merged = mergeStoryState(
      previous,
      {
        importantEvents: [
          // 旧形式で空配列を渡した場合、既存を破壊せず維持し warn を出す
          { eventId: 'evt-1', explicitlyUnknownBy: [] },
        ],
      },
      now,
      characters
    );
    expect(merged.importantEvents[0].explicitlyUnknownBy).toEqual(['char-c', 'char-d']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('caps explicitlyUnknownBy at MAX_EXPLICITLY_UNKNOWN (12) after add', () => {
    // 12 人ぶんの character 一覧を用意し、上限を検証
    const wideCharacters: Character[] = Array.from({ length: 14 }, (_, i) => ({
      characterId: `char-x${i}`,
      name: `x${i}`,
      role: 'supporting',
      description: '',
    }));
    const merged = mergeStoryState(
      storyState(),
      {
        importantEvents: [
          {
            eventId: '',
            summary: '大規模な秘密',
            characters: [],
            knownBy: [],
            addUnknownBy: wideCharacters.slice(0, 14).map((c) => c.characterId),
            importance: 'medium',
            status: 'active',
          },
        ],
      },
      now,
      wideCharacters
    );
    expect(merged.importantEvents[0].explicitlyUnknownBy?.length).toBe(12);
  });
});

// NOTE: Track 2B: characterStates.knowledge の自動更新（追加・削除）。
describe('mergeStoryState - knowledge / removeKnowledge (Track 2B)', () => {
  const characters: Character[] = [
    { characterId: 'char-a', name: 'A', role: 'protagonist', description: '' },
  ];

  it('appends knowledge entries to the existing list', () => {
    const previous = storyState({
      characterStates: [
        {
          characterId: 'char-a',
          name: 'A',
          currentState: '通常',
          knowledge: ['既存の知識1'],
          relationships: [],
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            knowledge: ['新規の知識1', '新規の知識2'],
          },
        ],
      },
      now,
      characters
    );
    expect(merged.characterStates[0].knowledge).toEqual([
      '既存の知識1',
      '新規の知識1',
      '新規の知識2',
    ]);
  });

  it('caps additions per patch at 3 items', () => {
    const merged = mergeStoryState(
      storyState({
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            currentState: '',
            knowledge: [],
            relationships: [],
            updatedAt: now,
          },
        ],
      }),
      {
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            knowledge: ['a', 'b', 'c', 'd', 'e'],
          },
        ],
      },
      now,
      characters
    );
    expect(merged.characterStates[0].knowledge).toEqual(['a', 'b', 'c']);
  });

  it('removes entries via removeKnowledge with width/case normalization but preserves space-position differences', () => {
    const previous = storyState({
      characterStates: [
        {
          characterId: 'char-a',
          name: 'A',
          currentState: '',
          knowledge: ['Ａは気づいた', 'Foo', 'A は知っている', 'Bは覚えている'],
          relationships: [],
          updatedAt: now,
        },
      ],
    });
    // 全角/半角差と大小文字差は吸収されるが、空白の有無は別文字列として扱う。
    const merged = mergeStoryState(
      previous,
      {
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            removeKnowledge: ['Aは気づいた', 'foo', 'Aは知っている'],
          },
        ],
      },
      now,
      characters
    );
    expect(merged.characterStates[0].knowledge).toEqual(['A は知っている', 'Bは覚えている']);
  });

  it('applies remove before add in the same patch', () => {
    const previous = storyState({
      characterStates: [
        {
          characterId: 'char-a',
          name: 'A',
          currentState: '',
          knowledge: ['旧知識'],
          relationships: [],
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            knowledge: ['旧知識'],
            removeKnowledge: ['旧知識'],
          },
        ],
      },
      now,
      characters
    );
    // remove が先に適用され、その後 add で復元される
    expect(merged.characterStates[0].knowledge).toEqual(['旧知識']);
  });

  it('trims from the head when total exceeds 12 items', () => {
    const previous = storyState({
      characterStates: [
        {
          characterId: 'char-a',
          name: 'A',
          currentState: '',
          knowledge: Array.from({ length: 12 }, (_, i) => `old${i}`),
          relationships: [],
          updatedAt: now,
        },
      ],
    });
    const merged = mergeStoryState(
      previous,
      {
        characterStates: [
          {
            characterId: 'char-a',
            name: 'A',
            knowledge: ['new1', 'new2', 'new3'],
          },
        ],
      },
      now,
      characters
    );
    // 12 + 3 = 15 のうち、末尾12件が残る（先頭3件が捨てられる）
    expect(merged.characterStates[0].knowledge).toEqual([
      'old3',
      'old4',
      'old5',
      'old6',
      'old7',
      'old8',
      'old9',
      'old10',
      'old11',
      'new1',
      'new2',
      'new3',
    ]);
  });
});

describe('mergeKnowledgeList (Track 2B helper)', () => {
  it('returns the trimmed union when neither add nor remove overlap', () => {
    expect(mergeKnowledgeList(['a'], ['b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates via normalizeComparableText', () => {
    // 大小文字差 / 全角半角差は吸収される
    expect(mergeKnowledgeList(['Foo'], ['ｆｏｏ'], [])).toEqual(['Foo']);
  });

  it('does not treat space-position differences as duplicates (space presence not absorbed)', () => {
    // 「A は」と「Aは」は別物として扱う
    expect(mergeKnowledgeList(['A は気づいた'], ['Aは気づいた'], [])).toEqual([
      'A は気づいた',
      'Aは気づいた',
    ]);
  });
});

// NOTE: 抽出プロンプトの文言固定（設計書 トラック 1A / 2A / 2B）。
// 文言はマージロジックの契約の一部（addUnknownBy / removeUnknownBy / actor / recipient /
// knowledge / removeKnowledge）なので、改訂時はここを意図的に書き換える。
describe('updateStoryStateFromAcceptedScene の抽出プロンプト文言', () => {
  async function capturePrompt(): Promise<string> {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(projectId, storyState());
    let capturedUserPrompt = '';
    const adapter: ModelAdapter = {
      providerName: 'fake',
      generateText: vi.fn(async (request) => {
        capturedUserPrompt = request.userPrompt;
        return { text: JSON.stringify({}), finishReason: 'stop', retryable: false };
      }),
      validateConnection: vi.fn(),
    };
    await updateStoryStateFromAcceptedScene({
      project: project(),
      adapter,
      generation: generation(),
      characters: [],
      worldText: '',
      timeoutMs: 1000,
    });
    return capturedUserPrompt;
  }

  it('actor / recipient の指示と差分JSONキーを固定する（Track 1A）', async () => {
    const prompt = await capturePrompt();

    expect(prompt).toContain('actor は「その出来事の主体（発話者・行為者・宣言者）」のcharacterId。単独行為なら recipient は null。');
    expect(prompt).toContain('recipient は「その出来事の受け手・宛先（宣告された相手、告白された相手など）」のcharacterId。宛先が特定できない出来事（独白・情景・自然現象）では null にする。');
    expect(prompt).toContain('actor / recipient は当事者性が明確な場合にのみ埋める。誰が主体か本文から読み取れない場合は null にする（推測しない）。');
    expect(prompt).toContain('actor / recipient は「主客の構造」を残すためのものであり、知識状態（knownBy / explicitlyUnknownBy）とは独立に扱う。');
    // 差分JSON形式の例にキーが並ぶ（JSON.stringify の整形のため空白を許容する）。
    const diffForm = prompt.slice(prompt.indexOf('【差分JSON形式】'));
    expect(diffForm).toMatch(/"actor":\s*"主体のcharacterIdまたはnull"/);
    expect(diffForm).toMatch(/"recipient":\s*"受け手のcharacterIdまたはnull"/);
  });

  it('addUnknownBy / removeUnknownBy の指示と差分JSONキーを固定し、旧キーを含めない（Track 2A）', async () => {
    const prompt = await capturePrompt();

    expect(prompt).toContain('explicitlyUnknownBy はパッチキーとしては使わない。代わりに addUnknownBy / removeUnknownBy を使う。');
    expect(prompt).toContain('addUnknownBy には、この場面終了時点で、その場に居合わせず、伝聞・立ち聞き・観察・記録の閲覧などによっても知り得ない人物のcharacterIdを入れる。');
    expect(prompt).toContain('判定は「この場面が終わった瞬間」で切る。');
    expect(prompt).toContain('removeUnknownBy は、以前の抽出で誤って explicitlyUnknownBy に入れた人物を取り消したいときにcharacterIdを列挙する。');
    expect(prompt).toContain('主要人物とは、人物ヒントの role が protagonist / deuteragonist の人物、および当該場面直前の characterStates に登場する人物とする。');
    const diffForm = prompt.slice(prompt.indexOf('【差分JSON形式】'));
    expect(diffForm).toMatch(/"addUnknownBy":\s*\[\s*"char-id"/);
    expect(diffForm).toMatch(/"removeUnknownBy":\s*\[\s*"char-id"/);
    // 旧形式キーは差分JSON例に載せない（載せるとLLMがそのまま返して破壊的な全置換になる）。
    expect(diffForm).not.toContain('explicitlyUnknownBy');
  });

  it('characterStates.knowledge / removeKnowledge の指示と差分JSONキーを固定する（Track 2B）', async () => {
    const prompt = await capturePrompt();

    expect(prompt).toContain('characterStates.knowledge には、今回の場面で当該人物が新たに得た小さな知識・観察・仮説を短文で追加する（1件30字以内推奨、1人物あたり今回追加は最大3件）。');
    expect(prompt).toContain('characterStates.removeKnowledge に完全一致する文字列を並べる。誤抽出の巻き戻し用。');
    expect(prompt).toContain('重複する内容や、importantEvents に既に載せた事件そのものは knowledge に書かない。');
    const diffForm = prompt.slice(prompt.indexOf('【差分JSON形式】'));
    expect(diffForm).toMatch(/"knowledge":\s*\[\s*"今回追加する知識・観察（各30字以内、最大3件）"/);
    expect(diffForm).toMatch(/"removeKnowledge":\s*\[\s*"既存knowledgeから削除する完全一致文字列"/);
  });
});
