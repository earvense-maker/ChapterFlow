import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, splitWorldByConvention } from '../../src/server/prompts/promptBuilder';
import * as storage from '../../src/server/services/storageService';
import { parseWorldMd, serializeWorldMd } from '../../src/server/utils/worldMd';
import type { Character, Project, ProjectState, StoryState } from '../../src/shared/types';

const projectId = 'proj-prompt-layering-test';

afterEach(async () => {
  await storage.deleteProjectDir(projectId);
});

function project(): Project {
  return {
    schemaVersion: 1,
    projectId,
    title: 'Layering Test',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    activeModelProvider: 'openai',
    activeModelName: 'gpt-4o-mini',
    outputLength: 3000,
    streamingEnabled: false,
    activePresetIds: {
      narration: 'third-close',
      emotionDisplay: 'restrained',
      sceneProgression: 'immersive',
    },
  };
}

function state(): ProjectState {
  return {
    lastOpenedAt: '2026-07-16T00:00:00.000Z',
    currentEpisodeId: null,
    currentSceneId: null,
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    uiState: { readingPosition: 0, fontSize: 18 },
  };
}

function character(overrides: Partial<Character> = {}): Character {
  return {
    characterId: 'char-a',
    name: 'アキ',
    role: 'protagonist',
    description: '主人公',
    currentState: '開始時は故郷を離れたばかり',
    ...overrides,
  };
}

function storyState(overrides: Partial<StoryState> = {}): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

async function prompt(characters: Character[], worldText = ''): Promise<string> {
  return (
    await buildPrompt({
      project: project(),
      state: state(),
      wish: '続き',
      memories: [],
      characters,
      worldText,
    })
  ).userPrompt;
}

describe('設定レイヤー分離 prompt rendering', () => {
  it.each([
    {
      label: 'disabled settings with motif exclusions',
      styleVariation: {
        enabled: false,
        intensity: 'subtle' as const,
        axisWeights: { visual: 0.5 },
        surfaceDecayEnabled: false,
        patternDecayEnabled: true,
        motifExclusions: ['反復フレーズ'],
      },
    },
    {
      label: 'corrupt settings that normalize to disabled',
      styleVariation: {
        enabled: true,
        intensity: 'broken',
        axisWeights: { visual: 0.5 },
        surfaceDecayEnabled: false,
        patternDecayEnabled: true,
        motifExclusions: ['反復フレーズ'],
      } as unknown as Project['styleVariation'],
    },
  ])('keeps the legacy frequent-phrase prompt for $label', async ({ styleVariation }) => {
    await storage.createProjectDir(projectId);
    const episodeId = 'ep-disabled-style';
    const sceneId = 'scene-disabled-style';
    const generationId = 'gen-disabled-style';
    await storage.writeEpisodeRecord(projectId, {
      episodeId,
      title: '既存prompt',
      order: 1,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:00:00.000Z',
      scenes: [
        {
          sceneId,
          episodeId,
          order: 1,
          createdAt: '2026-07-23T00:00:00.000Z',
          updatedAt: '2026-07-23T00:00:00.000Z',
          acceptedGenerationId: generationId,
          draftGenerationIds: [generationId],
        },
      ],
    });
    await storage.appendGenerationLog(projectId, {
      generationId,
      episodeId,
      sceneId,
      request: { wish: '', outputLength: 3000, previousContextText: '' },
      responseText: '反復フレーズ。反復フレーズ。反復フレーズ。',
      usedPresets: { narration: 'third-close' },
      usedModel: { provider: 'gemini', modelName: 'gemini-test' },
      referencedMemoryIds: [],
      status: 'accepted',
      createdAt: '2026-07-23T00:00:00.000Z',
      parentGenerationId: null,
    });
    const currentState = {
      ...state(),
      currentEpisodeId: episodeId,
      currentSceneId: sceneId,
      lastAcceptedGenerationId: generationId,
    };
    const userPrompt = (
      await buildPrompt({
        project: { ...project(), styleVariation },
        state: currentState,
        wish: '続き',
        memories: [],
        characters: [],
        worldText: '',
      })
    ).userPrompt;

    expect(userPrompt).toContain('【表現の重複を避ける】');
    expect(userPrompt).toContain('反復フレーズ');
    expect(userPrompt).not.toContain('【今回の文体レンズ】');
  });

  it('places the soft style lens before style DNA, registered NG, and the current wish', async () => {
    const styledProject = {
      ...project(),
      styleSample: '静かな文体見本。',
      styleVariation: {
        enabled: true,
        intensity: 'subtle' as const,
        axisWeights: { auditory: 1 },
        surfaceDecayEnabled: true,
        patternDecayEnabled: true,
        motifExclusions: [],
      },
    };
    const userPrompt = (
      await buildPrompt({
        project: styledProject,
        state: state(),
        wish: '雨の夜を描く',
        memories: [],
        characters: [],
        worldText: '',
        bannedExpressions: ['息を呑む'],
        styleProfile: {
          schemaVersion: 1,
          seed: 'seed',
          primaryAxis: 'auditory',
          entryChannel: 'sound',
          attenuatedPatterns: [],
          intensity: 'subtle',
        },
      })
    ).userPrompt;

    const lens = userPrompt.indexOf('【今回の文体レンズ】');
    const sample = userPrompt.indexOf('【文体見本】');
    const banned = userPrompt.indexOf('【使わない表現】');
    const wish = userPrompt.indexOf('【今回の希望】');
    expect(lens).toBeGreaterThanOrEqual(0);
    expect(lens).toBeLessThan(sample);
    expect(sample).toBeLessThan(banned);
    expect(banned).toBeLessThan(wish);
  });

  it('adds the temporal note only when work settings are present', async () => {
    const noSettings = await prompt([]);
    const withSettings = await prompt([], '王国には魔法がある。');

    expect(noSettings).not.toContain('以下は作品の基礎設定である');
    expect(withSettings).toContain('以下は作品の基礎設定である');
    expect(withSettings.indexOf('【作品設定】')).toBeLessThan(
      withSettings.indexOf('以下は作品の基礎設定である')
    );
  });

  it('does not emit an empty work-settings header for a canonical empty world', async () => {
    const emptyCanonical = serializeWorldMd({ foundation: '', initialSituation: '' });
    const userPrompt = await prompt([], emptyCanonical);

    expect(userPrompt).not.toContain('【作品設定】');
    expect(userPrompt).not.toContain('以下は作品の基礎設定である');
  });

  it('uses dynamic current state once and keeps knowledge in the information-state section', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(
      projectId,
      storyState({
        characterStates: [
          {
            characterId: 'char-a',
            name: 'アキ',
            currentState: '今は王都にいる',
            knowledge: ['手紙の差出人を知っている'],
            relationships: ['ユイと協力関係になった'],
            updatedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
      })
    );

    const userPrompt = await prompt([character()]);

    expect(userPrompt).toContain('- アキ: 今は王都にいる。関係変化: ユイと協力関係になった');
    expect(userPrompt).not.toContain('開始時は故郷を離れたばかり');
    expect(userPrompt.match(/手紙の差出人を知っている/g)).toHaveLength(1);
    expect(userPrompt).toContain('【人物の情報状態】');
  });

  it('uses labelled initial state until a dynamic current state is available', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(
      projectId,
      storyState({
        characterStates: [
          {
            characterId: 'char-a',
            name: 'アキ',
            currentState: '',
            knowledge: [],
            relationships: ['ユイを警戒している'],
            updatedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
      })
    );

    const userPrompt = await prompt([character()]);

    expect(userPrompt).toContain(
      '- アキ: 初期状態（現在状態未取得）: 開始時は故郷を離れたばかり。関係変化: ユイを警戒している'
    );
  });

  it('preserves an unmatched StoryState entry only once', async () => {
    await storage.createProjectDir(projectId);
    await storage.writeStoryState(
      projectId,
      storyState({
        characterStates: [
          {
            characterId: null,
            name: '旧名の人物',
            currentState: '港にいる',
            knowledge: ['隠し通路を知っている'],
            relationships: [],
            updatedAt: '2026-07-16T00:00:00.000Z',
          },
        ],
      })
    );

    const userPrompt = await prompt([character()]);

    expect(userPrompt).toContain('- 旧名の人物（未照合）: 港にいる');
    expect(userPrompt).toContain('知っている: 隠し通路を知っている');
    expect(userPrompt.match(/港にいる/g)).toHaveLength(1);
    expect(userPrompt.match(/隠し通路を知っている/g)).toHaveLength(1);
  });
});

describe('splitWorldByConvention', () => {
  it('keeps world text byte-for-byte when the convention is not present', () => {
    expect(splitWorldByConvention('法則A\r\n法則B')).toEqual([
      { kind: 'normal', content: '法則A\r\n法則B' },
    ]);
  });

  it('splits initial conditions while preserving ordered normal segments', () => {
    expect(
      splitWorldByConvention('法則A\n## 開始時点の状況\n王国は平和\n## 地理\n北に山脈')
    ).toEqual([
      { kind: 'normal', content: '法則A' },
      { kind: 'initial', content: '王国は平和' },
      { kind: 'normal', content: '## 地理\n北に山脈' },
    ]);
  });

  it('closes the initial section at a Japanese heading without a space after hashes', () => {
    expect(
      splitWorldByConvention('法則A\n##開始時点の状況\n王国は平和\n##地理\n北に山脈')
    ).toEqual([
      { kind: 'normal', content: '法則A' },
      { kind: 'initial', content: '王国は平和' },
      { kind: 'normal', content: '##地理\n北に山脈' },
    ]);
  });

  it('ignores headings in code fences and fails open on an unclosed fence', () => {
    expect(splitWorldByConvention('```md\n## 開始時点の状況\n```\n法則A')).toEqual([
      { kind: 'normal', content: '```md\n## 開始時点の状況\n```\n法則A' },
    ]);
    expect(splitWorldByConvention('法則A\n```\n## 開始時点の状況')).toEqual([
      { kind: 'normal', content: '法則A\n```\n## 開始時点の状況' },
    ]);
  });

  it('splits canonical fields without exposing canonical headings or resetting at subheadings', () => {
    const text = serializeWorldMd({
      foundation: '魔法法則',
      initialSituation: '停戦中\n## 現在の勢力図\n東西が拮抗',
    });

    expect(splitWorldByConvention(text)).toEqual([
      { kind: 'normal', content: '魔法法則' },
      { kind: 'initial', content: '停戦中\n## 現在の勢力図\n東西が拮抗' },
    ]);
  });

  it('intentionally treats pre-L4 world text as an initial situation after migration', () => {
    const migrated = serializeWorldMd(parseWorldMd('分類されていない旧世界設定'));

    expect(splitWorldByConvention(migrated)).toEqual([
      { kind: 'initial', content: '分類されていない旧世界設定' },
    ]);
  });
});
