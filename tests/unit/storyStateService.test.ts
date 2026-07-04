import { afterEach, describe, expect, it, vi } from 'vitest';
import * as storage from '../../src/server/services/storageService';
import {
  mergeStoryState,
  updateStoryStateFromAcceptedScene,
} from '../../src/server/services/storyStateService';
import type {
  AdapterGenerateResult,
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
      genre: 'modern-drama',
      style: 'natural-dialogue',
      pov: 'third-person-close',
      pacing: 'standard',
      density: 'balanced',
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
