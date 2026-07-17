import { afterEach, describe, expect, it } from 'vitest';
import * as projectService from '../../src/server/services/projectService';
import * as knowledgeService from '../../src/server/services/knowledgeService';
import * as storage from '../../src/server/services/storageService';

const createdProjectIds: string[] = [];

async function createTrackedProject() {
  const project = await projectService.createProject({ title: 'Validation Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId)));
  createdProjectIds.length = 0;
});

describe('project settings validation', () => {
  it('rejects unsupported model providers without persisting them', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, { activeModelProvider: 'unsupported' })
    ).rejects.toThrow(projectService.ProjectValidationError);

    const stored = await projectService.getProject(project.projectId);
    expect(stored?.activeModelProvider).toBe('gemini');
  });

  it('rolls back a newly created project directory when creation validation fails', async () => {
    await expect(
      projectService.createProject({
        title: 'Invalid Start',
        activeModelProvider: 'unsupported',
      })
    ).rejects.toThrow(projectService.ProjectValidationError);

    const after = await storage.listProjectIds();
    const projects = await Promise.all(after.map((projectId) => storage.readProject(projectId)));
    expect(projects.filter(Boolean).some((project) => project?.title === 'Invalid Start')).toBe(
      false
    );
  });

  it('rejects output lengths outside the supported range', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, { outputLength: 10001 })
    ).rejects.toThrow(projectService.ProjectValidationError);
  });

  it('normalizes valid model settings before saving', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'gemini',
      activeModelName: ' gemini-1.5-flash ',
      outputLength: 2500.4,
      streamingEnabled: true,
    });

    expect(updated.activeModelProvider).toBe('gemini');
    expect(updated.activeModelName).toBe('gemini-1.5-flash');
    expect(updated.outputLength).toBe(2500);
    expect(updated.streamingEnabled).toBe(true);
  });

  it('trims titles and rejects blank title updates', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      title: '  Renamed Story  ',
    });
    expect(updated.title).toBe('Renamed Story');

    await expect(
      projectService.updateProject(project.projectId, { title: '   ' })
    ).rejects.toThrow(projectService.ProjectValidationError);
    expect((await projectService.getProject(project.projectId))?.title).toBe('Renamed Story');
  });

  it('normalizes samplingConfig penalties to 0..1', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: -0.5, presencePenalty: 1.5 },
    });

    expect(updated.samplingConfig).toEqual({
      frequencyPenalty: 0,
      presencePenalty: 1,
      temperature: 0.7,
    });
  });

  it('preserves an existing samplingConfig field when partially updating the other', async () => {
    const project = await createTrackedProject();

    await projectService.updateProject(project.projectId, {
      samplingConfig: { frequencyPenalty: 0.6, presencePenalty: 0.2 },
    });
    const updated = await projectService.updateProject(project.projectId, {
      samplingConfig: { presencePenalty: 0.4 },
    });

    expect(updated.samplingConfig).toEqual({
      frequencyPenalty: 0.6,
      presencePenalty: 0.4,
      temperature: 0.7,
    });
  });

  it('copies samplingConfig when duplicating a project', async () => {
    const source = await createTrackedProject();
    await projectService.updateProject(source.projectId, {
      samplingConfig: { frequencyPenalty: 0.3, presencePenalty: 0.5 },
    });

    const duplicate = await projectService.createProject({
      duplicateFrom: source.projectId,
      title: 'Copied Settings',
    });
    createdProjectIds.push(duplicate.projectId);

    expect(duplicate.samplingConfig).toEqual({
      frequencyPenalty: 0.3,
      presencePenalty: 0.5,
      temperature: 0.7,
    });
  });

  it('copies knowledge files when duplicating a project', async () => {
    const source = await createTrackedProject();
    const knowledge = await knowledgeService.createKnowledge(source.projectId, {
      fileName: '用語集.md',
      content: '固有名詞A',
    });

    const duplicate = await projectService.createProject({
      duplicateFrom: source.projectId,
      title: 'Copied Knowledge',
    });
    createdProjectIds.push(duplicate.projectId);

    const copiedList = await knowledgeService.listKnowledge(duplicate.projectId);
    const copiedContent = await knowledgeService.getKnowledgeContent(
      duplicate.projectId,
      knowledge.knowledgeId
    );

    expect(copiedList).toMatchObject([
      { knowledgeId: knowledge.knowledgeId, title: '用語集', contentStatus: 'ok' },
    ]);
    expect(copiedContent.content).toBe('固有名詞A');
  });

  it('does not copy broken knowledge index entries without content', async () => {
    const source = await createTrackedProject();
    const missing = await knowledgeService.createKnowledge(source.projectId, {
      fileName: 'missing.md',
      content: 'deleted',
    });
    const kept = await knowledgeService.createKnowledge(source.projectId, {
      fileName: 'kept.md',
      content: '残す資料',
    });
    await storage.deleteKnowledgeContent(source.projectId, missing.knowledgeId, missing.extension);

    const duplicate = await projectService.createProject({
      duplicateFrom: source.projectId,
      title: 'Copied Partial Knowledge',
    });
    createdProjectIds.push(duplicate.projectId);

    const copiedList = await knowledgeService.listKnowledge(duplicate.projectId);
    expect(copiedList).toMatchObject([
      { knowledgeId: kept.knowledgeId, title: 'kept', contentStatus: 'ok', order: 0 },
    ]);
  });

  it('rejects invalid samplingConfig values', async () => {
    const project = await createTrackedProject();

    await expect(
      projectService.updateProject(project.projectId, {
        samplingConfig: { frequencyPenalty: NaN },
      })
    ).rejects.toThrow(projectService.ProjectValidationError);
  });

  it('accepts DeepSeek as a supported provider', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'deepseek',
      activeModelName: ' deepseek-v4-flash ',
    });

    expect(updated.activeModelProvider).toBe('deepseek');
    expect(updated.activeModelName).toBe('deepseek-v4-flash');
  });

  it('accepts xAI as a supported provider', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'xai',
      activeModelName: ' grok-4.3 ',
    });

    expect(updated.activeModelProvider).toBe('xai');
    expect(updated.activeModelName).toBe('grok-4.3');
  });

  it('accepts OpenRouter as a supported provider', async () => {
    const project = await createTrackedProject();

    const updated = await projectService.updateProject(project.projectId, {
      activeModelProvider: 'openrouter',
      activeModelName: ' openrouter/free ',
    });

    expect(updated.activeModelProvider).toBe('openrouter');
    expect(updated.activeModelName).toBe('openrouter/free');
  });

  it('creates a project with initial detailed settings', async () => {
    const project = await projectService.createProject({
      title: 'Detailed Start',
      outputLength: 4500.4,
      streamingEnabled: true,
      activeModelProvider: 'gemini',
      activeModelName: ' gemini-1.5-flash ',
      activePresetIds: { genre: 'romance' },
      world: { foundation: '都市の管理制度', initialSituation: '静かな管理都市' },
      characters: [
        {
          characterId: 'char-test',
          name: 'レン',
          role: 'protagonist',
          description: '都市監査員',
        },
      ],
      customSystemPrompt: '本文だけを書く',
    });
    createdProjectIds.push(project.projectId);

    const [worldText, characters, presets] = await Promise.all([
      storage.readWorld(project.projectId),
      storage.readCharacters(project.projectId),
      storage.readPresets(project.projectId),
    ]);

    expect(project.outputLength).toBe(4500);
    expect(project.streamingEnabled).toBe(true);
    expect(project.activeModelProvider).toBe('gemini');
    expect(project.activeModelName).toBe('gemini-1.5-flash');
    expect(project.activePresetIds.genre).toBe('romance');
    expect(project.activePresetIds.conversation).toBe('standard');
    expect(project.activePresetIds.intimacy).toBe('suggestive');
    const state = await storage.readState(project.projectId);
    expect(state?.storyStateRefresh).toMatchObject({
      status: 'fresh',
      generationId: null,
    });
    expect(worldText).toEqual({
      foundation: '都市の管理制度',
      initialSituation: '静かな管理都市',
    });
    expect(characters).toHaveLength(1);
    expect(presets?.conversationPreset).toBe('standard');
    expect(presets?.intimacyPreset).toBe('suggestive');
    expect(presets?.customSystemPrompt).toBe('本文だけを書く');
  });

  it('clamps roleplayOutputChars into the 100–500 range', async () => {
    const project = await projectService.createProject({
      title: 'Roleplay clamp',
      projectType: 'roleplay',
      roleplayOutputChars: 5, // 100 未満は 100 に丸め
    });
    createdProjectIds.push(project.projectId);
    expect(project.roleplayOutputChars).toBe(100);

    const bumped = await projectService.updateProject(project.projectId, {
      roleplayOutputChars: 9999, // 500 超は 500 に丸め
    });
    expect(bumped.roleplayOutputChars).toBe(500);

    // 未指定でもデフォルト（250）が保存される（新規作成時）
    const withDefault = await projectService.createProject({
      title: 'Default roleplay chars',
      projectType: 'roleplay',
    });
    createdProjectIds.push(withDefault.projectId);
    expect(withDefault.roleplayOutputChars).toBe(250);
  });

  it('rejects non-numeric roleplayOutputChars on update', async () => {
    const project = await projectService.createProject({
      title: 'Roleplay reject',
      projectType: 'roleplay',
    });
    createdProjectIds.push(project.projectId);

    await expect(
      projectService.updateProject(project.projectId, {
        // @ts-expect-error 意図的に不正値を渡してエラー系を確認
        roleplayOutputChars: 'abc',
      })
    ).rejects.toThrow(projectService.ProjectValidationError);
  });
});
