import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import * as generationTextRevisionService from '../../src/server/services/generationTextRevisionService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import type { EpisodeRecord, GenerationRecord, Project, StoryState } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createProjectWithGeneration(status: 'draft' | 'accepted'): Promise<{
  project: Project;
  generation: GenerationRecord;
}> {
  const created = await projectService.createProject({ title: 'Manual text edit test' });
  const project = await projectService.updateProject(created.projectId, {
    refineAutomation: { mode: 'off', scanPolicy: 'when-needed' },
  });
  createdProjectIds.push(project.projectId);
  const generation: GenerationRecord = {
    generationId: 'gen-edit',
    episodeId: 'ep-edit',
    sceneId: 'scene-edit',
    request: { wish: '', outputLength: 1000, previousContextText: '' },
    responseText: 'original text',
    usedPresets: project.activePresetIds,
    usedModel: { provider: 'gemini', modelName: 'gemini-test' },
    referencedMemoryIds: [],
    status,
    createdAt: '2026-08-10T00:00:00.000Z',
    parentGenerationId: null,
  };
  const episode: EpisodeRecord = {
    episodeId: generation.episodeId,
    title: 'Edit test',
    order: 1,
    createdAt: generation.createdAt,
    updatedAt: generation.createdAt,
    scenes: [
      {
        sceneId: generation.sceneId,
        episodeId: generation.episodeId,
        order: 1,
        createdAt: generation.createdAt,
        updatedAt: generation.createdAt,
        acceptedGenerationId: status === 'accepted' ? generation.generationId : null,
        draftGenerationIds: [generation.generationId],
      },
    ],
  };
  await storage.writeEpisodeRecord(project.projectId, episode);
  await storage.appendGenerationLog(project.projectId, generation);
  const state = await storage.readState(project.projectId);
  await storage.writeState(project.projectId, {
    ...state!,
    currentEpisodeId: episode.episodeId,
    currentSceneId: generation.sceneId,
    selectedDraftGenerationId: generation.generationId,
    storyStateRefresh: {
      status: 'fresh',
      generationId: status === 'accepted' ? generation.generationId : null,
      updatedAt: generation.createdAt,
    },
  });
  return { project, generation };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('generationTextRevisionService', () => {
  it('edits a draft with optimistic locking and restores the original version', async () => {
    const { project, generation } = await createProjectWithGeneration('draft');

    const edited = await generationTextRevisionService.updateGenerationText({
      projectId: project.projectId,
      generationId: generation.generationId,
      nextText: 'edited text',
      expectedRevisionNumber: 0,
      expectedStatus: 'draft',
      expectedAcceptedGenerationId: null,
    });

    expect(edited).toMatchObject({ revisionNumber: 1, derivationStatus: 'not-applicable' });
    await expect(storage.findGenerationRecord(project.projectId, generation.generationId)).resolves.toMatchObject({
      responseText: 'edited text',
      textRevisionNumber: 1,
    });
    await expect(storage.readGenerationMarkdown(project.projectId, generation.generationId)).resolves.toBe(
      'edited text'
    );

    await expect(
      generationTextRevisionService.updateGenerationText({
        projectId: project.projectId,
        generationId: generation.generationId,
        nextText: 'conflicting edit',
        expectedRevisionNumber: 0,
        expectedStatus: 'draft',
        expectedAcceptedGenerationId: null,
      })
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409, latestRevisionNumber: 1 });

    const versions = await generationTextRevisionService.readGenerationTextVersions(
      project.projectId,
      generation.generationId
    );
    expect(versions.map((version) => [version.revisionNumber, version.text])).toEqual([
      [0, 'original text'],
      [1, 'edited text'],
    ]);

    const restored = await generationTextRevisionService.restoreGenerationTextRevision({
      projectId: project.projectId,
      generationId: generation.generationId,
      revisionId: `original:${generation.generationId}`,
      expectedRevisionNumber: 1,
      expectedStatus: 'draft',
      expectedAcceptedGenerationId: null,
    });
    expect(restored).toMatchObject({ revisionNumber: 2 });
    await expect(storage.findGenerationRecord(project.projectId, generation.generationId)).resolves.toMatchObject({
      responseText: 'original text',
      textRevisionNumber: 2,
    });
  });

  it('rebuilds derived state after an accepted text edit and requires review', async () => {
    const { project, generation } = await createProjectWithGeneration('accepted');
    await storage.writeStoryState(project.projectId, {
      schemaVersion: 1,
      currentSituation: ['before edit'],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 2 },
      processedGenerationIds: [generation.generationId],
      updatedAt: generation.createdAt,
    } as StoryState);
    vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{}',
      finishReason: 'stop',
      retryable: false,
    });

    const edited = await generationTextRevisionService.updateGenerationText({
      projectId: project.projectId,
      generationId: generation.generationId,
      nextText: 'accepted edited text',
      expectedRevisionNumber: 0,
      expectedStatus: 'accepted',
      expectedAcceptedGenerationId: generation.generationId,
    });
    expect(edited).toMatchObject({ revisionNumber: 1, derivationStatus: 'pending' });

    await waitFor(async () => {
      const state = await storage.readState(project.projectId);
      return state?.storyStateRefresh?.status === 'awaiting-review';
    });
    await expect(generationTextRevisionService.getStoryStateRebuildReview(project.projectId)).resolves.toMatchObject({
      status: 'pending',
      sourceGenerationId: generation.generationId,
      sourceRevisionNumber: 1,
      previousState: { currentSituation: ['before edit'] },
      rebuiltState: expect.any(Object),
    });

    await generationTextRevisionService.resolveStoryStateRebuildReview(
      project.projectId,
      'use-previous-as-override'
    );
    await expect(storage.readState(project.projectId)).resolves.toMatchObject({
      storyStateRefresh: { status: 'fresh', generationId: generation.generationId, revisionNumber: 1 },
    });
    await expect(storage.readStoryState(project.projectId)).resolves.toMatchObject({
      currentSituation: ['before edit'],
      processedGenerationIds: [generation.generationId],
    });
    await expect(storage.readAcceptedDerivations(project.projectId)).resolves.toEqual([
      expect.objectContaining({
        generationId: generation.generationId,
        sourceTextRevisionNumber: 1,
        status: 'applied',
      }),
    ]);
  });
});
