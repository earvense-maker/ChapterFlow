import { describe, expect, it } from 'vitest';
import { normalizeSetupCommitData, normalizeSetupCommitPlan } from '../../src/server/services/setupCommitService';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';
const defaultPresetIdsByCategory = {
  narration: ['first-person', 'third-close', 'third-objective'],
  aftertaste: ['heartwarming', 'poignant', 'searing'],
  emotionDisplay: ['restrained', 'expressive'],
  sceneProgression: ['immersive', 'brisk'],
  chapterEnding: ['hook', 'lingering'],
  painLevel: ['safe', 'bittersweet', 'unflinching'],
  intimacy: ['fade-to-black', 'suggestive'],
};

function session(): SetupSession {
  return {
    schemaVersion: 1,
    sessionId: 'setup-test',
    projectId: null,
    status: 'active',
    revision: 1,
    model: {
      provider: 'gemini',
      modelName: 'gemini-3.5-flash',
    },
    projectSettings: {
      title: '',
      outputLength: 3000,
      streamingEnabled: false,
      activePresetIds: {
        narration: 'third-close',
      },
    },
    messages: [],
    draft: {
      ...createEmptySetupDraft(),
      coreConcept: '気弱な絵師と強気な岡っ引きの事件もの',
      world: ['江戸時代風の町'],
    },
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('setupCommitService', () => {
  it('normalizes commit data into existing project files shape', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        project: {
          title: '臆病絵師と岡っ引き',
          outputLength: 12000,
          activePresetIds: {
            narration: 'unknown-narration',
            aftertaste: ['poignant', 'searing', 'heartwarming'],
          },
        },
        worldText: '江戸時代風の町を舞台にした軽妙な事件もの。',
        characters: [
          {
            characterId: '../bad',
            role: 'protagonist',
            name: '',
            description: '気弱だが観察眼が鋭い絵師。',
          },
        ],
        memories: [
          {
            type: 'preference',
            content: '暗すぎず、少し笑える掛け合いを優先する。',
            importance: 'high',
          },
        ],
        storyState: {
          currentSituation: ['二人は小さな事件をきっかけに関わり始める。'],
          openThreads: [
            {
              summary: '主人公が顔色を読む理由は未確定。',
              importance: 'medium',
            },
          ],
        },
      },
    });

    expect(normalized.projectInput.title).toBe('臆病絵師と岡っ引き');
    expect(normalized.projectInput.outputLength).toBe(10000);
    expect(normalized.projectInput.activePresetIds?.narration).toBe('third-close');
    expect(normalized.projectInput.activePresetIds?.aftertaste).toEqual(['poignant', 'searing']);
    expect(normalized.projectInput.characters?.[0].characterId).toMatch(/^char-/);
    expect(normalized.memories[0]).toMatchObject({
      type: 'preference',
      importance: 'high',
      source: 'manual',
      status: 'active',
    });
    expect(normalized.storyState.schemaVersion).toBe(1);
    expect(normalized.storyState.openThreads[0].threadId).toMatch(/^thread-/);
  });

  it('falls back to draft world text when final conversion omits it', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {},
    });

    expect(normalized.projectInput.world?.initialSituation).toContain('気弱な絵師');
    expect(normalized.projectInput.world?.initialSituation).toContain('江戸時代風の町');
  });

  it('normalizes traits, promotes reserved labels to secrets, and accepts legacy fields', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        characters: [
          {
            characterId: 'char-a',
            role: 'protagonist',
            name: 'アリス',
            description: '主人公',
            traits: [
              { label: '見せない面', text: '実は王女' },
              { label: 'こだわり', text: '紅茶は熱いうちに飲む' },
            ],
            want: '自由になりたい',
            fear: '忘れられること',
          },
        ],
      },
    });

    expect(normalized.projectInput.characters?.[0]).toMatchObject({
      secrets: '実は王女',
      traits: [
        { label: 'こだわり', text: '紅茶は熱いうちに飲む' },
        { label: '望み', text: '自由になりたい' },
        { label: '恐れ', text: '忘れられること' },
      ],
    });
    expect(normalized.projectInput.characters?.[0]).not.toHaveProperty('want');
  });

  it('accepts the new world schema and normalizes invalid fields to empty strings', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {},
      raw: { world: { foundation: '魔法法則', initialSituation: null } },
    });

    expect(normalized.projectInput.world).toEqual({
      foundation: '魔法法則',
      initialSituation: '',
    });
  });

  it('recovers a string-valued world schema slip without discarding model output', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {},
      raw: { world: '魔法法則\n## 開始時点の状況\n王国は停戦中' },
    });

    expect(normalized.projectInput.world).toEqual({
      foundation: '魔法法則',
      initialSituation: '王国は停戦中',
    });
  });

  it('uses draft fallback when the AI returns an entirely empty world record', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {},
      raw: { world: { foundation: ' ', initialSituation: '' } },
    });

    expect(normalized.projectInput.world?.foundation).toBe('');
    expect(normalized.projectInput.world?.initialSituation).toContain('江戸時代風の町');
  });

  it('allows the user-edited commit plan to intentionally clear both world fields', () => {
    const normalized = normalizeSetupCommitPlan({
      session: session(),
      now,
      presetIdsByCategory: {},
      raw: { world: { foundation: '', initialSituation: '' } },
    });

    expect(normalized.projectInput.world).toEqual({ foundation: '', initialSituation: '' });
  });

  it('maps legacy L4 worldText into both world fields', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {},
      raw: {
        worldText: '魔法法則\n## 開始時点の状況\n王国は停戦中',
      },
    });

    expect(normalized.projectInput.world).toEqual({
      foundation: '魔法法則',
      initialSituation: '王国は停戦中',
    });
  });

  it('builds an editable provisional title from the core concept when conversion omits it', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {},
    });

    expect(normalized.projectInput.title).toBe('仮題：気弱な絵師と強気な岡っ引きの事件もの');
  });

  it('does not fall back to opening seeds when the edited first wish is empty', () => {
    const setupSession = session();
    setupSession.draft.openingSeeds = ['Start from the rainy library.'];

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: { title: 'Empty first wish' },
        firstWishSuggestion: '',
      },
    });

    expect(normalized.projectInput.firstWishSuggestion).toBeUndefined();
  });

  it('falls back to the first opening seed only when first wish is omitted', () => {
    const setupSession = session();
    setupSession.draft.openingSeeds = ['Start from the rainy library.'];

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: { title: 'Missing first wish' },
      },
    });

    expect(normalized.projectInput.firstWishSuggestion).toBe('Start from the rainy library.');
  });

  it('fills the required narration default when a setup session has no active presets', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {};

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: { title: 'Default presets' },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({ narration: 'third-close' });
    expect(normalized.projectInput.applyDefaultPresets).toBe(false);
  });

  it('ignores obsolete legacy categories while preserving compatible intimacy', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {
      genre: 'modern-drama',
      style: 'natural-dialogue',
      pov: 'third-person-close',
      pacing: 'standard',
      density: 'balanced',
      conversation: 'standard',
      relationshipPacing: 'standard',
      intimacy: 'suggestive',
    };

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: {
          title: 'Legacy defaults',
          activePresetIds: setupSession.projectSettings.activePresetIds,
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({
      narration: 'third-close',
      intimacy: 'suggestive',
    });
    expect(normalized.projectInput.applyDefaultPresets).toBe(false);
  });

  it('keeps an explicitly selected full default set in a new empty setup session', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {};
    const explicitlySelectedDefaults = {
      narration: 'third-close',
      emotionDisplay: 'restrained',
      intimacy: 'suggestive',
    };

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: {
          title: 'Explicit defaults',
          activePresetIds: explicitlySelectedDefaults,
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual(explicitlySelectedDefaults);
  });

  it('maps legacy setup commit presets through the shared migration rules', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {
      genre: 'modern-drama',
      style: 'afterglow',
      pov: 'first-person',
      pacing: 'slow',
      density: 'balanced',
      conversation: 'standard',
      relationshipPacing: 'standard',
      distance: 'emotional',
      intimacy: 'suggestive',
    };

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        project: {
          title: 'Legacy setup presets',
          activePresetIds: setupSession.projectSettings.activePresetIds,
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({
      narration: 'first-person',
      emotionDisplay: 'expressive',
      sceneProgression: 'immersive',
      chapterEnding: 'lingering',
      intimacy: 'suggestive',
    });
  });

  it('keeps fallback narration when legacy raw presets have no mapped pov', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {
      narration: 'first-person',
      painLevel: 'safe',
    };

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: {
          title: 'Discarded legacy genre',
          activePresetIds: { genre: 'modern-drama' },
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({
      narration: 'first-person',
      painLevel: 'safe',
    });
  });

  it('treats mixed data with narration as current format', () => {
    const normalized = normalizeSetupCommitPlan({
      session: session(),
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        project: {
          title: 'Mixed preset data',
          activePresetIds: {
            narration: 'first-person',
            painLevel: 'safe',
            genre: 'modern-drama',
          },
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({
      narration: 'first-person',
      painLevel: 'safe',
    });
  });

  it('merges draft ng and tone into memories even when LLM returns none', () => {
    const setupSession = session();
    setupSession.draft.ng = ['流血表現', '残酷な死'];
    setupSession.draft.tone = ['軽妙な掛け合い'];

    const normalized = normalizeSetupCommitData({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {},
    });

    const ngMemories = normalized.memories.filter((memory) => memory.type === 'negative');
    expect(ngMemories.map((memory) => memory.content)).toEqual(['流血表現', '残酷な死']);
    expect(ngMemories.every((memory) => memory.importance === 'high')).toBe(true);
    expect(normalized.memories.some((memory) => memory.content === '軽妙な掛け合い' && memory.type === 'preference')).toBe(true);
  });

  it('does not duplicate ng/tone memories when LLM already returns the same content', () => {
    const setupSession = session();
    setupSession.draft.ng = ['流血表現'];

    const normalized = normalizeSetupCommitData({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        memories: [{ type: 'negative', content: '流血表現', importance: 'high' }],
      },
    });

    expect(normalized.memories.filter((memory) => memory.type === 'negative')).toHaveLength(1);
  });

  it('prioritizes ng memories over lower importance LLM memories at the 24 limit', () => {
    const setupSession = session();
    setupSession.draft.ng = ['NG表現'];

    const normalized = normalizeSetupCommitData({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        memories: Array.from({ length: 24 }, (_, index) => ({
          type: 'preference',
          content: `LLMメモ${index}`,
          importance: index < 12 ? 'medium' : 'low',
        })),
      },
    });

    expect(normalized.memories).toHaveLength(24);
    expect(normalized.memories.some((memory) => memory.content === 'NG表現' && memory.type === 'negative')).toBe(true);
  });

  it('falls back to active draft characters when final conversion omits characters', () => {
    const setupSession = session();
    setupSession.draft.characters = [
      {
        id: 'char-draft-protagonist',
        role: 'protagonist',
        name: '',
        label: '気弱な絵師',
        description: '観察眼は鋭いが押しに弱い。',
        speechStyle: '控えめ',
        relationshipNotes: '岡っ引きに振り回される。',
        source: 'manual',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'char-draft-archived',
        role: 'supporting',
        name: '削除済み',
        label: '削除済み',
        description: '使わない。',
        source: 'manual',
        status: 'archived',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const normalized = normalizeSetupCommitData({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {},
    });

    expect(normalized.projectInput.characters).toEqual([
      expect.objectContaining({
        characterId: 'char-draft-protagonist',
        name: '気弱な絵師',
        role: 'protagonist',
        description: '観察眼は鋭いが押しに弱い。',
        speechStyle: '控えめ',
        relationshipNotes: '岡っ引きに振り回される。',
      }),
    ]);
  });

  it('normalizeSetupCommitPlan behaves the same as normalizeSetupCommitData', () => {
    const setupSession = session();
    setupSession.draft.ng = ['流血表現'];

    const planResult = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        project: {
          title: 'plan title',
          outputLength: 5000,
          activePresetIds: { narration: 'third-close' },
        },
        worldText: 'plan world',
        characters: [{ name: 'plan char', role: 'protagonist', description: 'desc' }],
        memories: [{ type: 'preference', content: 'plan memory', importance: 'medium' }],
        storyState: { currentSituation: ['plan situation'], openThreads: [] },
        customSystemPrompt: 'plan system',
      },
    });

    expect(planResult.projectInput.title).toBe('plan title');
    expect(planResult.projectInput.world).toEqual({
      foundation: '',
      initialSituation: 'plan world',
    });
    expect(planResult.memories.some((memory) => memory.content === '流血表現' && memory.type === 'negative')).toBe(true);
    expect(planResult.memories.some((memory) => memory.content === 'plan memory')).toBe(true);
    expect(planResult.storyState.currentSituation).toContain('plan situation');
  });

  it('normalizes unknown preset IDs and broken storyState in edited plan', () => {
    const setupSession = session();

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        project: {
          title: 'edited',
          activePresetIds: { narration: 'unknown-narration', painLevel: 'bittersweet' },
        },
        worldText: 'edited world',
        characters: [],
        memories: [],
        storyState: { currentSituation: ['ok'], openThreads: [{ summary: 'thread', importance: 'invalid' }] },
        customSystemPrompt: '',
      },
    });

    expect(normalized.projectInput.activePresetIds?.narration).toBe('third-close');
    expect(normalized.projectInput.activePresetIds?.painLevel).toBe('bittersweet');
    expect(normalized.storyState.openThreads[0].importance).toBe('medium');
  });

  it('forces projectType and scenarioSeeds for roleplay purpose regardless of model output', () => {
    const roleplaySession: SetupSession = {
      ...session(),
      purpose: 'roleplay',
      draft: {
        ...createEmptySetupDraft(),
        coreConcept: '幼馴染との放課後',
        scenarioSeeds: ['放課後の教室で二人きり', '駅前の書店で偶然会う'],
      },
    };
    const normalized = normalizeSetupCommitData({
      session: roleplaySession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        // NOTE: モデルが projectType='novel' と誤って返しても roleplay に強制する。
        project: { title: '幼馴染', projectType: 'novel' },
        // NOTE: firstWishSuggestion は roleplay では出力側で捨てる。
        firstWishSuggestion: '第1話冒頭の希望',
        // NOTE: storyFact は roleplay では除外される。
        memories: [
          { type: 'preference', content: '穏やか', importance: 'high' },
          { type: 'storyFact', content: '本編用の事実', importance: 'high' },
          { type: 'negative', content: 'これはNG', importance: 'high' },
        ],
        characters: [
          {
            role: 'protagonist',
            name: 'アリス',
            description: '幼馴染',
            greeting: 'あ、来てくれたんだ。',
            dialogueExamples: ['……ここ、隣あいてるよ。', 'また明日、ね。'],
          },
        ],
        scenarioSeeds: ['放課後の教室で二人きり'],
      },
    });

    expect(normalized.projectInput.projectType).toBe('roleplay');
    expect(normalized.projectInput.scenarioSeeds).toEqual(['放課後の教室で二人きり']);
    expect(normalized.projectInput.firstWishSuggestion).toBeUndefined();
    // memories は preference / negative のみ
    expect(normalized.memories.every((m) => m.type === 'preference' || m.type === 'negative')).toBe(true);
    // characters に greeting / dialogueExamples が保持される
    expect(normalized.projectInput.characters?.[0].greeting).toBe('あ、来てくれたんだ。');
    expect(normalized.projectInput.characters?.[0].dialogueExamples).toEqual([
      '……ここ、隣あいてるよ。',
      'また明日、ね。',
    ]);
  });

  it('falls back to draft.scenarioSeeds for roleplay purpose when LLM omits them', () => {
    const roleplaySession: SetupSession = {
      ...session(),
      purpose: 'roleplay',
      draft: {
        ...createEmptySetupDraft(),
        coreConcept: '幼馴染',
        scenarioSeeds: ['ドラフトの舞台1', 'ドラフトの舞台2'],
      },
    };
    const normalized = normalizeSetupCommitData({
      session: roleplaySession,
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: { project: { title: 'x' } },
    });
    expect(normalized.projectInput.scenarioSeeds).toEqual(['ドラフトの舞台1', 'ドラフトの舞台2']);
  });

  it('drops story event visibility IDs that do not match committed characters', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
      },
      raw: {
        characters: [
          {
            characterId: 'char-a',
            name: 'A',
            role: 'protagonist',
            description: 'A protagonist.',
          },
        ],
        storyState: {
          importantEvents: [
            {
              summary: 'A found the sealed letter.',
              knownBy: ['A', 'char-a', 'char-missing'],
              explicitlyUnknownBy: ['char-a', 'char-missing'],
            },
          ],
        },
      },
    });

    expect(normalized.storyState.importantEvents[0].knownBy).toEqual(['char-a']);
    expect(normalized.storyState.importantEvents[0].explicitlyUnknownBy).toEqual([]);
  });

  // NOTE: Track 1A: setup 経路でも LLM 出力の actor / recipient を正規化する。
  it('normalizes actor and recipient in story events (Track 1A)', () => {
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        characters: [
          { characterId: 'char-taro', name: '太郎', role: 'protagonist', description: '' },
          { characterId: 'char-hanako', name: '花子', role: 'deuteragonist', description: '' },
        ],
        storyState: {
          importantEvents: [
            {
              summary: '太郎が花子に告白した',
              actor: 'char-taro',
              recipient: 'char-hanako',
            },
            {
              summary: '独白の場面',
              actor: 'char-taro',
              recipient: null,
            },
            {
              summary: '主体不明で ID が誤っている',
              actor: 'char-missing',
              recipient: 'char-taro',
            },
          ],
        },
      },
    });
    const events = normalized.storyState.importantEvents;
    expect(events[0].actor).toBe('char-taro');
    expect(events[0].recipient).toBe('char-hanako');
    expect(events[1].actor).toBe('char-taro');
    expect(events[1].recipient).toBeNull();
    // 存在しない ID は null に落ちる
    expect(events[2].actor).toBeNull();
    expect(events[2].recipient).toBe('char-taro');
  });

  // NOTE: Track 2A: setup 経路の explicitlyUnknownBy 上限を 4 → 12 に緩和したこと。
  // NOTE: setup 経路の characters は 12 件に切り詰められるので、known 1 + unknown 12 の
  // 計 13 IDs を検証するには LLM 出力側の characters を 12 件（0..11）に留める必要がある。
  // 上限 12 の効き方は「12 の unknown が可能」を示せば十分。
  it('accepts up to 12 explicitlyUnknownBy entries per event (Track 2A)', () => {
    const characterList = Array.from({ length: 12 }, (_, i) => ({
      characterId: `char-${i}`,
      name: `人物${i}`,
      role: 'supporting' as const,
      description: '',
    }));
    const unknownIds = characterList.slice(0, 12).map((c) => c.characterId);
    const normalized = normalizeSetupCommitData({
      session: session(),
      now,
      presetIdsByCategory: defaultPresetIdsByCategory,
      raw: {
        characters: characterList,
        storyState: {
          importantEvents: [
            {
              summary: 'A の秘密（誰も同席していない）',
              knownBy: [],
              explicitlyUnknownBy: unknownIds,
            },
          ],
        },
      },
    });
    expect(normalized.storyState.importantEvents[0].explicitlyUnknownBy?.length).toBe(12);
  });
});
