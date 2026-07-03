import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/server/prompts/promptBuilder';
import type { Project, ProjectState, Memory, Character } from '../../src/server/types/index';

function makeProject(): Project {
  return {
    schemaVersion: 1,
    projectId: 'proj-test',
    title: 'Test Project',
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
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

function makeState(): ProjectState {
  return {
    lastOpenedAt: '2026-07-02T00:00:00Z',
    currentEpisodeId: null,
    currentSceneId: null,
    selectedDraftGenerationId: null,
    lastAcceptedGenerationId: null,
    pendingMemoryCandidateIds: [],
    uiState: { readingPosition: 0, fontSize: 18 },
  };
}

describe('buildPrompt', () => {
  it('includes base instruction as system prompt', async () => {
    const { systemInstructions } = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: 'もっと不穏に',
      memories: [],
      characters: [],
      worldText: '',
    });
    expect(systemInstructions).toContain('ユーザー専用の連載小説');
    expect(systemInstructions).toContain('テキストファイルに保存される小説本文そのもの');
    expect(systemInstructions).toContain('本文のみを出力');
    expect(systemInstructions).toContain('【選択された設定】');
    expect(systemInstructions).toContain('静謐で控えめな文体');
  });

  it('uses a saved custom system prompt when provided', async () => {
    const { systemInstructions } = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: 'もっと不穏に',
      memories: [],
      characters: [],
      worldText: '',
      customSystemPrompt: 'カスタムのシステム指示',
    });
    expect(systemInstructions).toBe('カスタムのシステム指示');
  });

  it('includes wish and output conditions', async () => {
    const { userPrompt } = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: 'もっと不穏に',
      memories: [],
      characters: [],
      worldText: '',
    });
    expect(userPrompt).toContain('もっと不穏に');
    expect(userPrompt).toContain('目安文字数: 約3000字（2600〜3400字程度）');
    expect(userPrompt).toContain('切りがよいところで自然に終える');
  });

  it('includes high importance memories only', async () => {
    const memories: Memory[] = [
      {
        memoryId: 'mem-1',
        type: 'storyFact',
        content: '重要な事実',
        importance: 'high',
        relatedCharacters: [],
        relatedEpisodes: [],
        createdAt: '',
        updatedAt: '',
        sourceSceneId: null,
        status: 'active',
        source: 'manual',
      },
      {
        memoryId: 'mem-2',
        type: 'preference',
        content: '中程度の好み',
        importance: 'medium',
        relatedCharacters: [],
        relatedEpisodes: [],
        createdAt: '',
        updatedAt: '',
        sourceSceneId: null,
        status: 'active',
        source: 'manual',
      },
    ];
    const { userPrompt } = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: '',
      memories,
      characters: [],
      worldText: '',
    });
    expect(userPrompt).toContain('重要な事実');
    expect(userPrompt).not.toContain('中程度の好み');
  });

  it('includes world and characters', async () => {
    const characters: Character[] = [
      {
        characterId: 'char-1',
        name: '太郎',
        role: 'protagonist',
        description: '主人公',
        speechStyle: 'くだけた',
      },
    ];
    const { userPrompt } = await buildPrompt({
      project: makeProject(),
      state: makeState(),
      wish: '',
      memories: [],
      characters,
      worldText: '現代日本の地方都市',
    });
    expect(userPrompt).toContain('現代日本の地方都市');
    expect(userPrompt).toContain('太郎');
    expect(userPrompt).toContain('主人公');
  });
});
