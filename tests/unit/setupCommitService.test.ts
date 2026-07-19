import { describe, expect, it } from 'vitest';
import { normalizeSetupCommitData, normalizeSetupCommitPlan } from '../../src/server/services/setupCommitService';
import { createEmptySetupDraft } from '../../src/server/services/setupDraftPatchService';
import type { SetupSession } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';
const defaultPresetIdsByCategory = {
  genre: ['modern-drama'],
  style: ['natural-dialogue'],
  pov: ['third-person-close'],
  pacing: ['standard'],
  density: ['balanced'],
  conversation: ['standard'],
  relationshipPacing: ['standard'],
  intimacy: ['suggestive'],
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
        genre: 'modern-drama',
        style: 'natural-dialogue',
        pov: 'third-person-close',
        pacing: 'standard',
        density: 'balanced',
        relationshipPacing: 'standard',
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
        genre: ['modern-drama', 'mystery'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced', 'dialogue-rich'],
        relationshipPacing: ['standard'],
      },
      raw: {
        project: {
          title: '臆病絵師と岡っ引き',
          outputLength: 12000,
          activePresetIds: {
            genre: 'period-drama',
            style: 'natural-dialogue',
            pov: 'third-person-close',
            pacing: 'standard',
            density: 'dialogue-rich',
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
    expect(normalized.projectInput.activePresetIds?.genre).toBe('modern-drama');
    expect(normalized.projectInput.activePresetIds?.density).toBe('dialogue-rich');
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
      },
      raw: {},
    });

    expect(normalized.projectInput.world?.initialSituation).toContain('気弱な絵師');
    expect(normalized.projectInput.world?.initialSituation).toContain('江戸時代風の町');
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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

  it('does not fill shared preset defaults when a setup session has no active presets', () => {
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

    expect(normalized.projectInput.activePresetIds).toEqual({});
    expect(normalized.projectInput.applyDefaultPresets).toBe(false);
  });

  it('drops the legacy automatically populated default preset set', () => {
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

    expect(normalized.projectInput.activePresetIds).toEqual({});
    expect(normalized.projectInput.applyDefaultPresets).toBe(false);
  });

  it('keeps an explicitly selected full default set in a new empty setup session', () => {
    const setupSession = session();
    setupSession.projectSettings.activePresetIds = {};
    const explicitlySelectedDefaults = {
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
          title: 'Explicit defaults',
          activePresetIds: explicitlySelectedDefaults,
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual(explicitlySelectedDefaults);
  });

  it('removes legacy defaults while preserving explicit extra preset choices', () => {
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
      distance: 'close',
      constraint: 'no-rush',
    };

    const normalized = normalizeSetupCommitPlan({
      session: setupSession,
      now,
      presetIdsByCategory: {
        ...defaultPresetIdsByCategory,
        distance: ['close'],
        constraint: ['no-rush'],
      },
      raw: {
        project: {
          title: 'Legacy defaults with explicit extras',
          activePresetIds: setupSession.projectSettings.activePresetIds,
        },
      },
    });

    expect(normalized.projectInput.activePresetIds).toEqual({
      distance: 'close',
      constraint: 'no-rush',
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
      },
      raw: {
        project: { title: 'plan title', outputLength: 5000, activePresetIds: { genre: 'modern-drama' } },
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
      },
      raw: {
        project: { title: 'edited', activePresetIds: { genre: 'unknown-genre', density: 'balanced' } },
        worldText: 'edited world',
        characters: [],
        memories: [],
        storyState: { currentSituation: ['ok'], openThreads: [{ summary: 'thread', importance: 'invalid' }] },
        customSystemPrompt: '',
      },
    });

    expect(normalized.projectInput.activePresetIds?.genre).toBe('modern-drama');
    expect(normalized.projectInput.activePresetIds?.density).toBe('balanced');
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
        genre: ['modern-drama'],
        style: ['natural-dialogue'],
        pov: ['third-person-close'],
        pacing: ['standard'],
        density: ['balanced'],
        relationshipPacing: ['standard'],
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
});
