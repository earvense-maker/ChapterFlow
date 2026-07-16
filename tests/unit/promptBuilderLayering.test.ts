import { afterEach, describe, expect, it } from 'vitest';
import { buildPrompt, splitWorldByConvention } from '../../src/server/prompts/promptBuilder';
import * as storage from '../../src/server/services/storageService';
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
      genre: 'modern-drama',
      style: 'quiet',
      pov: 'third-person-close',
      pacing: 'slow',
      density: 'dialogue-rich',
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
  it('adds the temporal note only when work settings are present', async () => {
    const noSettings = await prompt([]);
    const withSettings = await prompt([], '王国には魔法がある。');

    expect(noSettings).not.toContain('以下は作品の基礎設定である');
    expect(withSettings).toContain('以下は作品の基礎設定である');
    expect(withSettings.indexOf('【作品設定】')).toBeLessThan(
      withSettings.indexOf('以下は作品の基礎設定である')
    );
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
});
