import { createHash } from 'node:crypto';
import { generateTimestampId } from '../utils/id.js';
import { withProjectWriteLock } from './projectLock.js';
import * as storage from './storageService.js';
import { invalidateContextSummaryOnAcceptedTextChangeUnlocked } from './acceptedTextDerivations.js';
import {
  buildStoryStateRefreshStatus,
  calculateStoryStateBacklog,
  findGeneration,
  startStoryStateRefreshAfterAcceptance,
} from './generationReaderState.js';
import {
  rebuildEpisodeMarkdownForAcceptedGeneration,
} from './generationService.js';
import { runContentEditedHook } from './amplifierEventHooks.js';
import { assertNoConflictingAdvance } from './amplifierService.js';
import type {
  GenerationRecord,
  GenerationStatus,
  GenerationTextEditResult,
  GenerationTextRevisionSource,
  GenerationTextVersion,
  ProjectState,
} from '../types/index.js';

const GENERATION_TEXT_MAX_CHARS = 200_000;

export class GenerationTextRevisionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly latestRevisionNumber?: number
  ) {
    super(message);
    this.name = 'GenerationTextRevisionError';
  }
}

export async function readGenerationTextVersions(
  projectId: string,
  generationId: string
): Promise<GenerationTextVersion[]> {
  const [record, revisions] = await Promise.all([
    readOriginalGenerationRecord(projectId, generationId),
    storage.readGenerationTextRevisionEntries(projectId, generationId),
  ]);
  if (!record) {
    throw new GenerationTextRevisionError('本文が見つかりません。', 'generation_not_found', 404);
  }
  return [
    {
      revisionId: `original:${generationId}`,
      revisionNumber: 0,
      source: 'original',
      text: record.responseText,
      createdAt: record.createdAt,
      afterHash: hashText(record.responseText),
    },
    ...revisions.map((revision) => ({
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      source: revision.source,
      text: revision.responseText,
      createdAt: revision.updatedAt,
      beforeHash: revision.beforeHash,
      afterHash: revision.afterHash,
    })),
  ];
}

export async function updateGenerationText(input: {
  projectId: string;
  generationId: string;
  nextText: string;
  expectedRevisionNumber: number;
  expectedStatus: GenerationStatus;
  expectedAcceptedGenerationId: string | null;
  source?: GenerationTextRevisionSource;
  reason?: string;
}): Promise<GenerationTextEditResult> {
  // NOTE: pendingAdvance が terminal でない間、採用状態を変える操作は 409（設計書 13.2）。
  await assertNoConflictingAdvance(input.projectId);
  const result = await withProjectWriteLock(input.projectId, () =>
    updateGenerationTextUnlocked({
      ...input,
      source: input.source ?? 'manual-edit',
      reason: input.reason ?? 'manual-edit',
    })
  );
  if (result.startRefreshGenerationId) {
    startStoryStateRefreshAfterAcceptance(
      input.projectId,
      result.startRefreshGenerationId,
      result.result.revisionNumber
    );
  }
  return result.result;
}

export async function restoreGenerationTextRevision(input: {
  projectId: string;
  generationId: string;
  revisionId: string;
  expectedRevisionNumber: number;
  expectedStatus: GenerationStatus;
  expectedAcceptedGenerationId: string | null;
}): Promise<GenerationTextEditResult> {
  const versions = await readGenerationTextVersions(input.projectId, input.generationId);
  const target = versions.find((version) => version.revisionId === input.revisionId);
  if (!target) {
    throw new GenerationTextRevisionError('復元対象の版が見つかりません。', 'revision_not_found', 404);
  }
  return updateGenerationText({
    ...input,
    nextText: target.text,
    source: 'history-restore',
    reason: `restore:${target.revisionId}`,
  });
}

export async function getStoryStateRebuildReview(projectId: string) {
  const review = await storage.readStoryStateRebuildReview(projectId);
  if (!review || review.status !== 'pending') {
    throw new GenerationTextRevisionError('確認待ちの再抽出結果はありません。', 'review_not_found', 404);
  }
  return review;
}

export async function resolveStoryStateRebuildReview(
  projectId: string,
  resolution: 'use-rebuilt' | 'use-previous-as-override'
): Promise<GenerationRecord | null> {
  return withProjectWriteLock(projectId, async () => {
    const [review, state, rebuiltState] = await Promise.all([
      storage.readStoryStateRebuildReview(projectId),
      storage.readState(projectId),
      storage.readStoryState(projectId),
    ]);
    if (!review || review.status !== 'pending' || !state || !rebuiltState) {
      throw new GenerationTextRevisionError('確認待ちの再抽出結果はありません。', 'review_not_found', 404);
    }
    if (state.storyStateRefresh?.status !== 'awaiting-review') {
      throw new GenerationTextRevisionError(
        '再抽出がまだ完了していません。',
        'review_not_ready',
        409,
        true
      );
    }
    if (resolution === 'use-previous-as-override') {
      await storage.writeStoryState(projectId, {
        ...review.previousState,
        processedGenerationIds: rebuiltState.processedGenerationIds ?? [],
        updatedAt: new Date().toISOString(),
      });
    }
    const resolvedAt = new Date().toISOString();
    await storage.writeStoryStateRebuildReview(projectId, {
      ...review,
      rebuiltState,
      status: 'resolved',
      resolution,
      resolvedAt,
    });
    await storage.writeState(projectId, {
      ...state,
      storyStateRefresh: buildStoryStateRefreshStatus(
        'fresh',
        review.sourceGenerationId,
        undefined,
        review.sourceRevisionNumber,
        { reason: 'manual-text-edit' }
      ),
    });
    return findGeneration(projectId, review.sourceGenerationId);
  });
}

async function updateGenerationTextUnlocked(input: {
  projectId: string;
  generationId: string;
  nextText: string;
  expectedRevisionNumber: number;
  expectedStatus: GenerationStatus;
  expectedAcceptedGenerationId: string | null;
  source: GenerationTextRevisionSource;
  reason: string;
}): Promise<{ result: GenerationTextEditResult; startRefreshGenerationId: string | null }> {
  const nextText = normalizeEditedText(input.nextText);
  const record = await findGeneration(input.projectId, input.generationId);
  if (!record) {
    throw new GenerationTextRevisionError('本文が見つかりません。', 'generation_not_found', 404);
  }
  if (record.status !== 'draft' && record.status !== 'accepted') {
    throw new GenerationTextRevisionError(
      '下書きまたは採用済みの本文だけを編集できます。',
      'generation_not_editable',
      422
    );
  }
  const currentRevisionNumber = record.textRevisionNumber ?? 0;
  if (!Number.isInteger(input.expectedRevisionNumber) || input.expectedRevisionNumber < 0) {
    throw new GenerationTextRevisionError('改訂番号が不正です。', 'invalid_revision', 400);
  }
  if (currentRevisionNumber !== input.expectedRevisionNumber) {
    throw new GenerationTextRevisionError(
      '本文が別の操作で更新されています。再読み込みしてください。',
      'revision_conflict',
      409,
      false,
      currentRevisionNumber
    );
  }

  const acceptedGenerationId = await readSceneAcceptedGenerationId(input.projectId, record);
  if (
    record.status !== input.expectedStatus ||
    acceptedGenerationId !== input.expectedAcceptedGenerationId
  ) {
    throw new GenerationTextRevisionError(
      '編集中に採用状態が変わりました。内容を確認してからもう一度保存してください。',
      'generation_state_conflict',
      409,
      false,
      currentRevisionNumber
    );
  }
  if (nextText === record.responseText) {
    return {
      result: {
        generation: record,
        revisionNumber: currentRevisionNumber,
        derivationStatus: record.status === 'accepted' ? 'fresh' : 'not-applicable',
      },
      startRefreshGenerationId: null,
    };
  }

  const revisionNumber = currentRevisionNumber + 1;
  const revisionId = generateTimestampId('textrev');

  let derivationStatus: GenerationTextEditResult['derivationStatus'] = 'not-applicable';
  let acceptedState: ProjectState | null = null;
  if (record.status === 'accepted') {
    const state = await requireProjectState(input.projectId);
    if (state.storyStateRefresh && state.storyStateRefresh.status !== 'fresh') {
      throw new GenerationTextRevisionError(
        '作品の状態整理が完了してから、採用済み本文を編集してください。',
        'story_state_not_fresh',
        409,
        true,
        currentRevisionNumber
      );
    }
    acceptedState = state;
    derivationStatus = 'pending';
  }

  if (acceptedState) {
    // dirty marker だけを先行させる。ここでは派生データを消さないため、ログ追記前に
    // 停止しても旧本文と旧派生は揃ったまま、手動再抽出で fresh に戻せる。
    await storage.writeState(input.projectId, {
      ...acceptedState,
      storyStateRefresh: buildStoryStateRefreshStatus(
        'pending',
        null,
        undefined,
        revisionNumber,
        { reason: 'manual-text-edit' }
      ),
    });
  }

  // NOTE: 追記ログが正本。派生データの破棄と markdown より必ず先に確定する。
  await storage.appendGenerationTextRevisionLog(input.projectId, input.generationId, nextText, {
    reason: input.reason,
    before: record.responseText,
    after: nextText,
    source: input.source,
    revisionId,
    revisionNumber,
  });
  if (acceptedState) {
    try {
      const contextSummary = await invalidateContextSummaryOnAcceptedTextChangeUnlocked(
        input.projectId,
        acceptedState,
        [input.generationId]
      );
      await invalidateAcceptedNarrativeProjection(
        input.projectId,
        acceptedState,
        input.generationId,
        revisionNumber,
        contextSummary
      );
    } catch (error) {
      console.warn('Accepted text projections will be recovered from pending state', {
        projectId: input.projectId,
        generationId: input.generationId,
        revisionNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await storage.writeGenerationMarkdown(input.projectId, input.generationId, nextText).catch((error) => {
    console.warn('Generation markdown repair deferred', {
      projectId: input.projectId,
      generationId: input.generationId,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  let startRefreshGenerationId: string | null = null;
  if (record.status === 'accepted') {
    await rebuildEpisodeMarkdownForAcceptedGeneration(input.projectId, input.generationId).catch((error) => {
      console.warn('Episode markdown repair deferred', {
        projectId: input.projectId,
        generationId: input.generationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const backlog = await calculateStoryStateBacklog(input.projectId).catch(() => []);
    startRefreshGenerationId = backlog[0]?.generationId ?? input.generationId;
    derivationStatus = 'pending';
  }

  const generation = await findGeneration(input.projectId, input.generationId);
  if (!generation) {
    throw new GenerationTextRevisionError('保存した本文を再読込できません。', 'generation_not_found', 404);
  }
  // NOTE: 妄想増幅器の content_edited イベント（設計書 7.4）。本文保存後に追記し、
  // 旧turnをsupersedeする。失敗しても編集は成功として返す（設計書 21）。
  void runContentEditedHook({
    projectId: input.projectId,
    anchor: {
      kind: 'novel',
      generationId: input.generationId,
      textRevisionNumber: revisionNumber,
    },
    beforeText: record.responseText,
    afterText: nextText,
  });
  return {
    result: { generation, revisionNumber, derivationStatus },
    startRefreshGenerationId,
  };
}

async function invalidateAcceptedNarrativeProjection(
  projectId: string,
  state: ProjectState,
  generationId: string,
  revisionNumber: number,
  contextSummary: ProjectState['contextSummary'] | null
): Promise<void> {
  const [storyState, canon, derivations] = await Promise.all([
    storage.readStoryState(projectId),
    storage.readLatentCanon(projectId),
    storage.readAcceptedDerivations(projectId),
  ]);
  const now = new Date().toISOString();
  if (storyState) {
    await storage.writeStoryStateRebuildReview(projectId, {
      schemaVersion: 1,
      projectId,
      status: 'pending',
      previousState: storyState,
      sourceGenerationId: generationId,
      sourceRevisionNumber: revisionNumber,
      createdAt: now,
    });
    await storage.writeStoryState(projectId, {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: storyState.authorUndecided ?? [],
      clock: { day: 1 },
      processedGenerationIds: [],
      updatedAt: now,
    });
  }
  if (canon) {
    const items = canon.items
      .map((item) => ({
        ...item,
        evidence: item.evidence.filter((evidence) => evidence.kind !== 'generation'),
      }))
      .filter(
        (item) =>
          item.manualLock || item.source !== 'generation' || item.evidence.length > 0
      );
    await storage.writeLatentCanon({
      ...canon,
      items,
      processedGenerationIds: [],
      pendingConflicts: canon.pendingConflicts.filter(
        (conflict) => !conflict.generationId
      ),
      revision: canon.revision + 1,
      updatedAt: now,
    });
  }
  await storage.writeAcceptedDerivations(
    projectId,
    derivations.map((derivation) => ({ ...derivation, status: 'stale' as const }))
  );
  await storage.writeState(projectId, {
    ...state,
    ...(contextSummary ? { contextSummary } : {}),
    storyStateRefresh: buildStoryStateRefreshStatus(
      'pending',
      null,
      undefined,
      revisionNumber,
      { reason: 'manual-text-edit' }
    ),
  });
}

async function readSceneAcceptedGenerationId(
  projectId: string,
  record: GenerationRecord
): Promise<string | null> {
  const episode = await storage.readEpisodeRecord(projectId, record.episodeId);
  const scene = episode?.scenes.find((candidate) => candidate.sceneId === record.sceneId);
  if (!episode || !scene) {
    throw new GenerationTextRevisionError('本文に対応するシーンが見つかりません。', 'scene_not_found', 404);
  }
  return scene.acceptedGenerationId;
}

async function requireProjectState(projectId: string): Promise<ProjectState> {
  const state = await storage.readState(projectId);
  if (!state) {
    throw new GenerationTextRevisionError('作品が見つかりません。', 'project_not_found', 404);
  }
  return state;
}

async function readOriginalGenerationRecord(
  projectId: string,
  generationId: string
): Promise<GenerationRecord | null> {
  return storage.findOriginalGenerationRecord(projectId, generationId);
}

function normalizeEditedText(value: string): string {
  if (typeof value !== 'string') {
    throw new GenerationTextRevisionError('本文を文字列で指定してください。', 'invalid_text', 400);
  }
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    throw new GenerationTextRevisionError('本文を空にはできません。', 'empty_text', 400);
  }
  if (normalized.length > GENERATION_TEXT_MAX_CHARS) {
    throw new GenerationTextRevisionError(
      `本文は${GENERATION_TEXT_MAX_CHARS.toLocaleString()}文字以内にしてください。`,
      'text_too_long',
      400
    );
  }
  return normalized;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
