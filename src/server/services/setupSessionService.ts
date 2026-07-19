import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { defaultModelForProvider, isSupportedProvider } from './modelInfoService.js';
import { reloadCredentials } from './credentialService.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import {
  applySetupDraftPatch,
  createEmptySetupDraft,
  normalizeComparableText,
  normalizeSetupDraft,
} from './setupDraftPatchService.js';
import {
  buildSetupChatPrompt,
  buildSetupCommitPrompt,
  buildSetupPreviewPrompt,
} from './setupPromptBuilder.js';
import {
  normalizeSetupCommitData,
  normalizeSetupCommitPlan,
  readPresetIdsByCategory,
} from './setupCommitService.js';
import { normalizeSetupPurpose } from '../types/index.js';
import { DEFAULT_ACTIVE_PRESET_IDS } from '../../shared/defaults.js';
import { normalizeActivePresetIds } from '../../shared/presetMigration.js';
import type { SetupPurpose } from '../types/index.js';
import type { NormalizedSetupCommitData } from './setupCommitService.js';
import type {
  AdapterGenerateResult,
  CommitSetupBody,
  CreateSetupSessionBody,
  FinishReason,
  PatchSetupSettingsBody,
  RetrySetupMessageBody,
  SendSetupMessageBody,
  SetLockStateBody,
  SetupCommitPlan,
  SetupCommitPlanResponse,
  SetupCommitResponse,
  SetupDraft,
  SetupDraftResponse,
  SetupLock,
  SetupLockStateResponse,
  SetupMessage,
  SetupMessageResponse,
  SetupPreviewResponse,
  SetupSession,
  SetupSessionError,
  SetupSessionResponse,
  SetupSessionSummary,
  SetupSuggestedAction,
  UpdateSetupDraftBody,
} from '../types/index.js';

const DEFAULT_MODEL_PROVIDER = 'gemini';
const CHAT_OUTPUT_LENGTH = 1800;
const PREVIEW_OUTPUT_LENGTH = 900;
const COMMIT_OUTPUT_LENGTH = 3200;
const CHAT_TEMPERATURE = 0.7;
const PREVIEW_TEMPERATURE = 0.8;
const COMMIT_TEMPERATURE = 0.2;
const TIMEOUT_MS = 120_000;
const UNREADABLE_CHAT_REPLY =
  '相談相手の返答をうまく読み取れませんでした。あなたの入力は保存されています。もう一度、今の内容を整理してみます。';
const UNREADABLE_CHAT_ACTIONS: SetupSuggestedAction[] = [
  {
    label: 'もう一度整理',
    message: '直前の相談内容をもう一度整理してください。',
  },
];


const sessionMutexes = new Map<string, Promise<void>>();

type SetupLockReason = SetupLock['reason'];

export async function listSetupSessions(): Promise<SetupSessionSummary[]> {
  const sessionIds = await storage.listSetupSessionIds();
  const sessions = await Promise.all(
    sessionIds.map((sessionId) => storage.readSetupSession(sessionId).catch(() => null))
  );

  return sessions
    .filter((session): session is SetupSession => session !== null)
    .flatMap((session) => {
      try {
        return [toSetupSessionSummary(normalizeStoredSession(session))];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSetupSession(
  body: CreateSetupSessionBody
): Promise<SetupSessionResponse> {
  const now = nowIso();
  const provider = normalizeProvider(body.model?.provider);
  // NOTE: 'novel' | 'roleplay' 以外は 400。undefined は 'novel' 扱い。
  if (body.purpose !== undefined && body.purpose !== 'novel' && body.purpose !== 'roleplay') {
    throw new SetupServiceError(
      "purpose は 'novel' か 'roleplay' である必要があります。",
      'invalid_purpose',
      false,
      400
    );
  }
  const purpose: SetupPurpose = normalizeSetupPurpose(body.purpose);
  const requestedPresetIds = body.projectSettings?.activePresetIds ?? {};
  const session: SetupSession = {
    schemaVersion: 2,
    sessionId: generateTimestampId('setup'),
    projectId: null,
    status: 'active',
    revision: 1,
    purpose,
    model: {
      provider,
      modelName:
        body.model?.modelName?.trim() || defaultModelForProvider(provider),
    },
    projectSettings: {
      title: body.projectSettings?.title?.trim() || '',
      outputLength: normalizeOutputLength(body.projectSettings?.outputLength),
      streamingEnabled: body.projectSettings?.streamingEnabled ?? false,
      activePresetIds: normalizeActivePresetIds(
        hasCurrentPresetCategory(requestedPresetIds)
          ? { ...DEFAULT_ACTIVE_PRESET_IDS, ...requestedPresetIds }
          : requestedPresetIds
      ),
    },
    messages: [],
    draft: createEmptySetupDraft(),
    locks: [],
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };

  await storage.writeSetupSession(session);

  const initialMessage = body.initialMessage?.trim();
  if (!initialMessage) {
    return { sessionId: session.sessionId, session, suggestedActions: [] };
  }

  try {
    const response = await sendSetupMessage(session.sessionId, {
      message: initialMessage,
      revision: session.revision,
    });
    return {
      sessionId: session.sessionId,
      session: response.session,
      assistantMessage: response.assistantMessage,
      suggestedActions: response.suggestedActions,
    };
  } catch (err) {
    if (err instanceof SetupServiceError && err.session) {
      return {
        sessionId: session.sessionId,
        session: err.session,
        suggestedActions: [],
      };
    }
    throw err;
  }
}

export async function getSetupSession(sessionId: string): Promise<SetupSession | null> {
  try {
    const session = await storage.readSetupSession(sessionId);
    return session ? normalizeStoredSession(session) : null;
  } catch (err) {
    if (err instanceof SetupServiceError) throw err;
    throw new SetupServiceError('相談セッションIDが不正です。', 'invalid_setup_id', false, 400);
  }
}

export async function abandonSetupSession(sessionId: string): Promise<SetupSession> {
  return withSessionLock(sessionId, async () => {
    const session = await readSetupSessionOrThrow(sessionId);
    if (session.status !== 'active') {
      throw new SetupServiceError(
        'この相談セッションは更新できません。',
        'setup_not_active',
        false,
        400,
        session
      );
    }
    const nextSession: SetupSession = {
      ...session,
      status: 'abandoned',
      revision: session.revision + 1,
      updatedAt: nowIso(),
    };
    await storage.writeSetupSession(nextSession);
    return nextSession;
  });
}

export async function deleteSetupSession(sessionId: string): Promise<{ ok: true }> {
  return withSessionLock(sessionId, async () => {
    const exists = await storage.setupSessionExists(sessionId);
    if (!exists) {
      throw new SetupServiceError('相談セッションが見つかりません。', 'setup_not_found', false, 404);
    }
    await storage.deleteSetupSession(sessionId);
    return { ok: true };
  });
}

export async function patchSetupSettings(
  sessionId: string,
  body: PatchSetupSettingsBody
): Promise<{ session: SetupSession; revision: number }> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    assertValidRevision(body.revision);
    assertRevision(session, body.revision);

    let model = session.model;
    if (body.model) {
      const provider = body.model.provider;
      if (!provider || !isSupportedProvider(provider)) {
        throw new SetupServiceError('未対応のモデルプロバイダーです。', 'unsupported_provider', false, 400);
      }
      model = {
        provider,
        modelName: body.model.modelName?.trim() || defaultModelForProvider(provider),
      };
    }

    const now = nowIso();
    const nextSession: SetupSession = {
      ...session,
      model,
      projectSettings: {
        ...session.projectSettings,
        ...(body.activePresetIds
          ? { activePresetIds: normalizeActivePresetIds(body.activePresetIds) }
          : {}),
      },
      revision: session.revision + 1,
      updatedAt: now,
    };
    await storage.writeSetupSession(nextSession);
    return { session: nextSession, revision: nextSession.revision };
  });
}

export async function sendSetupMessage(
  sessionId: string,
  body: SendSetupMessageBody
): Promise<SetupMessageResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  assertValidRevision(body.revision);
  assertRevision(session, body.revision);

  if (typeof body.message !== 'string') {
    throw new SetupServiceError('メッセージを入力してください。', 'invalid_message', false, 400);
  }
  const messageText = body.message.trim();
  if (!messageText) {
    throw new SetupServiceError('メッセージを入力してください。', 'invalid_message', false, 400);
  }
  if (messageText.length > 4000) {
    throw new SetupServiceError('メッセージが長すぎます。', 'invalid_message', false, 400);
  }

  const now = nowIso();
  const userMessage: SetupMessage = {
    messageId: generateTimestampId('msg'),
    role: 'user',
    content: messageText,
    createdAt: now,
  };

  const workingSession: SetupSession = {
    ...session,
    messages: [...session.messages, userMessage],
    revision: session.revision + 1,
    lastError: null,
    updatedAt: now,
  };
  await storage.writeSetupSession(workingSession);

  return runChatTurn(workingSession);
  });
}

async function runChatTurn(workingSession: SetupSession): Promise<SetupMessageResponse> {
  const userMessage = workingSession.messages[workingSession.messages.length - 1];
  if (!userMessage || userMessage.role !== 'user') {
    throw new SetupServiceError('ユーザー発言が見つかりません。', 'nothing_to_retry', false, 400);
  }

  const { systemInstructions, userPrompt } = buildSetupChatPrompt({
    session: workingSession,
    userMessage: userMessage.content,
  });

  const result = await generateWithSessionModel(workingSession, {
    systemInstructions,
    userPrompt,
    outputLength: CHAT_OUTPUT_LENGTH,
    temperature: CHAT_TEMPERATURE,
  }).catch(async (err) => {
    const nextSession = await writeSessionError(workingSession, err);
    throw toSetupServiceError(err, nextSession);
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    const error = adapterResultToError(result);
    const nextSession = await writeSessionError(workingSession, error);
    throw toSetupServiceError(error, nextSession);
  }

  return finalizeChatTurn(workingSession, result.text);
}

async function finalizeChatTurn(
  workingSession: SetupSession,
  generatedText: string
): Promise<SetupMessageResponse> {
  const parsed = parseChatResult(generatedText);
  const draft = parsed.draftPatch
    ? applySetupDraftPatch({
        draft: workingSession.draft,
        patch: parsed.draftPatch,
        locks: workingSession.locks,
        source: 'llm',
      })
    : workingSession.draft;
  const assistantMessage: SetupMessage = {
    messageId: generateTimestampId('msg'),
    role: 'assistant',
    content: parsed.visibleReply || '相談メモを更新しました。',
    createdAt: nowIso(),
  };

  const nextSession: SetupSession = {
    ...workingSession,
    messages: [...workingSession.messages, assistantMessage],
    draft,
    conversationSummary: parsed.conversationSummary
      ? parsed.conversationSummary.slice(0, MAX_CONVERSATION_SUMMARY_CHARS)
      : workingSession.conversationSummary,
    revision: workingSession.revision + 1,
    lastError: null,
    updatedAt: nowIso(),
  };
  await storage.writeSetupSession(nextSession);

  return {
    session: nextSession,
    assistantMessage,
    draft: nextSession.draft,
    suggestedActions: parsed.suggestedActions,
    revision: nextSession.revision,
  };
}

export type SetupMessageStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'result'; response: SetupMessageResponse }
  | {
      type: 'error';
      error: {
        error: string;
        code: string;
        retryable: boolean;
        session?: SetupSession;
      };
    };

export async function* sendSetupMessageStream(
  sessionId: string,
  body: SendSetupMessageBody,
  abortSignal?: AbortSignal
): AsyncGenerator<SetupMessageStreamEvent> {
  const releaseLock = await acquireSessionLock(sessionId);
  try {
    yield* sendSetupMessageStreamUnlocked(sessionId, body, abortSignal);
  } finally {
    releaseLock();
  }
}

async function* sendSetupMessageStreamUnlocked(
  sessionId: string,
  body: SendSetupMessageBody,
  abortSignal?: AbortSignal
): AsyncGenerator<SetupMessageStreamEvent> {
  const session = await requireActiveSession(sessionId);
  assertValidRevision(body.revision);
  assertRevision(session, body.revision);

  if (typeof body.message !== 'string') {
    throw new SetupServiceError('メッセージを入力してください。', 'invalid_message', false, 400, session);
  }
  const messageText = body.message.trim();
  if (!messageText) {
    throw new SetupServiceError('メッセージを入力してください。', 'invalid_message', false, 400, session);
  }
  if (messageText.length > 4000) {
    throw new SetupServiceError('メッセージが長すぎます。', 'invalid_message', false, 400, session);
  }

  const now = nowIso();
  const userMessage: SetupMessage = {
    messageId: generateTimestampId('msg'),
    role: 'user',
    content: messageText,
    createdAt: now,
  };

  const workingSession: SetupSession = {
    ...session,
    messages: [...session.messages, userMessage],
    revision: session.revision + 1,
    lastError: null,
    updatedAt: now,
  };
  await storage.writeSetupSession(workingSession);

  yield* runChatTurnStream(workingSession, abortSignal);
}

async function* runChatTurnStream(
  workingSession: SetupSession,
  abortSignal?: AbortSignal
): AsyncGenerator<SetupMessageStreamEvent> {
  const userMessage = workingSession.messages[workingSession.messages.length - 1];
  if (!userMessage || userMessage.role !== 'user') {
    throw new SetupServiceError('ユーザー発言が見つかりません。', 'nothing_to_retry', false, 400, workingSession);
  }

  if (abortSignal?.aborted) {
    throw new SetupServiceError('生成が中断されました', 'aborted', false, 499, workingSession);
  }

  const { systemInstructions, userPrompt } = buildSetupChatPrompt({
    session: workingSession,
    userMessage: userMessage.content,
  });

  await reloadCredentials();
  const adapter = adapterMap[workingSession.model.provider];
  if (!adapter) {
    throw new SetupServiceError(
      `Unsupported provider: ${workingSession.model.provider}`,
      'unsupported_provider',
      false,
      400,
      workingSession
    );
  }

  const request = {
    systemInstructions,
    userPrompt,
    outputLength: CHAT_OUTPUT_LENGTH,
    temperature: CHAT_TEMPERATURE,
    timeoutMs: TIMEOUT_MS,
    modelName: workingSession.model.modelName,
    abortSignal,
  };

  if (!adapter.generateTextStream) {
    const result = await adapter.generateText(request).catch(async (err) => {
      const nextSession = await writeSessionError(workingSession, err);
      throw toSetupServiceError(err, nextSession);
    });

    if (abortSignal?.aborted) {
      throw new SetupServiceError('生成が中断されました', 'aborted', false, 499, workingSession);
    }

    if (result.finishReason === 'error' || result.finishReason === 'timeout') {
      const error = adapterResultToError(result);
      const nextSession = await writeSessionError(workingSession, error);
      throw toSetupServiceError(error, nextSession);
    }

    const response = await finalizeChatTurn(workingSession, result.text);
    if (response.assistantMessage?.content) {
      yield { type: 'delta', text: response.assistantMessage.content };
    }
    yield { type: 'result', response };
    return;
  }

  let generatedText = '';
  let finishReason: FinishReason = 'stop';
  let rawUsage: AdapterGenerateResult['rawUsage'] | undefined;
  let debugInfo: string | undefined;
  let markerIndex: number | null = null;
  let emittedIndex = 0;
  const markerBufferLen = 20;

  try {
    for await (const event of adapter.generateTextStream(request)) {
      if (abortSignal?.aborted) {
        throw new SetupServiceError('生成が中断されました', 'aborted', false, 499, workingSession);
      }

      if (event.type === 'chunk') {
        generatedText += event.text;
        if (markerIndex === null) {
          const found = generatedText.indexOf(DRAFT_PATCH_MARKER);
          if (found >= 0) {
            markerIndex = found;
            const delta = generatedText.slice(emittedIndex, found);
            emittedIndex = found;
            if (delta) {
              yield { type: 'delta', text: delta };
            }
          } else {
            const safeEnd = Math.max(0, generatedText.length - markerBufferLen);
            if (safeEnd > emittedIndex) {
              yield { type: 'delta', text: generatedText.slice(emittedIndex, safeEnd) };
              emittedIndex = safeEnd;
            }
          }
        }
      } else {
        finishReason = event.finishReason;
        rawUsage = event.rawUsage;
        debugInfo = event.debugInfo;
      }
    }
  } catch (err) {
    if (err instanceof SetupServiceError) throw err;
    if (err instanceof ModelAdapterError) {
      const nextSession = await writeSessionError(workingSession, err);
      throw toSetupServiceError(err, nextSession);
    }
    const nextSession = await writeSessionError(workingSession, err);
    throw toSetupServiceError(err, nextSession);
  }

  if (abortSignal?.aborted) {
    throw new SetupServiceError('生成が中断されました', 'aborted', false, 499, workingSession);
  }

  if (finishReason === 'error' || finishReason === 'timeout') {
    const error = new SetupServiceError(
      mapErrorMessage(finishReason),
      finishReason,
      true,
      503,
      workingSession
    );
    const nextSession = await writeSessionError(workingSession, error);
    throw toSetupServiceError(error, nextSession);
  }

  const streamedText = generatedText.trim();
  if (!streamedText) {
    const emptyError = new SetupServiceError(
      mapErrorMessage('empty_response', debugInfo),
      'empty_response',
      true,
      503,
      workingSession
    );
    const nextSession = await writeSessionError(workingSession, emptyError);
    throw toSetupServiceError(emptyError, nextSession);
  }

  if (markerIndex !== null) {
    const delta = generatedText.slice(emittedIndex, markerIndex);
    emittedIndex = markerIndex;
    if (delta) {
      yield { type: 'delta', text: delta };
    }
  } else {
    if (emittedIndex < generatedText.length) {
      yield { type: 'delta', text: generatedText.slice(emittedIndex) };
      emittedIndex = generatedText.length;
    }
  }

  const response = await finalizeChatTurn(workingSession, generatedText);
  yield { type: 'result', response };
}

export async function updateSetupDraft(
  sessionId: string,
  body: UpdateSetupDraftBody
): Promise<SetupDraftResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  assertValidRevision(body.revision);
  assertRevision(session, body.revision);
  if (!isRecord(body.draft)) {
    throw new SetupServiceError('ドラフトの形式が不正です。', 'invalid_request', false, 400);
  }
  const now = nowIso();
  const manualEditPaths = normalizeLockPaths(body.manualEditPaths);

  const nextSession: SetupSession = {
    ...session,
    draft: normalizeSetupDraft(body.draft, now),
    locks: addLocks(session.locks, manualEditPaths, 'manual_edit', now),
    revision: session.revision + 1,
    lastError: null,
    updatedAt: now,
  };
  await storage.writeSetupSession(nextSession);
  return {
    session: nextSession,
    draft: nextSession.draft,
    revision: nextSession.revision,
  };
  });
}

export async function retrySetupMessage(
  sessionId: string,
  _body: RetrySetupMessageBody = {}
): Promise<SetupMessageResponse> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    const lastMessage = session.messages[session.messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user') {
      throw new SetupServiceError(
        '再試行できるユーザー発言がありません。',
        'nothing_to_retry',
        false,
        400,
        session
      );
    }
    return runChatTurn({ ...session, lastError: null });
  });
}

export async function setLockState(
  sessionId: string,
  body: SetLockStateBody
): Promise<SetupLockStateResponse> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    assertValidRevision(body.revision);
    assertRevision(session, body.revision);
    if (typeof body.path !== 'string' || typeof body.locked !== 'boolean') {
      throw new SetupServiceError('リクエストの形式が不正です。', 'invalid_request', false, 400);
    }
    const normalizedPath = body.path.trim();
    if (!normalizedPath) {
      throw new SetupServiceError('path is required', 'invalid_lock_path', false, 400);
    }

    const now = nowIso();
    const nextDraft = cloneDraft(session.draft);
    const item = findDraftItemById(nextDraft, normalizedPath);
    if (item) {
      item.locked = body.locked;
      item.updatedAt = now;
    }

    let nextLocks = session.locks;
    if (body.locked) {
      nextLocks = addLocks(session.locks, [normalizedPath], 'user_locked', now);
    } else {
      nextLocks = session.locks.filter((lock) => lock.path !== normalizedPath);
    }

    const nextSession: SetupSession = {
      ...session,
      draft: nextDraft,
      locks: nextLocks,
      revision: session.revision + 1,
      lastError: null,
      updatedAt: now,
    };
    await storage.writeSetupSession(nextSession);
    return { session: nextSession, revision: nextSession.revision };
  });
}

function cloneDraft(draft: SetupDraft): SetupDraft {
  return JSON.parse(JSON.stringify(draft)) as SetupDraft;
}

function findDraftItemById(
  draft: SetupDraft,
  id: string
): { locked?: boolean; updatedAt: string } | null {
  for (const item of draft.confirmed) {
    if (item.id === id) return item;
  }
  for (const item of draft.candidates) {
    if (item.id === id) return item;
  }
  for (const item of draft.undecided) {
    if (item.id === id) return item;
  }
  for (const item of draft.characters) {
    if (item.id === id) return item;
  }
  return null;
}

function toSetupSessionSummary(session: SetupSession): SetupSessionSummary {
  return {
    sessionId: session.sessionId,
    status: session.status,
    revision: session.revision,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
    draftExcerpt: buildDraftExcerpt(session),
    committedProjectId: session.committedProjectId,
    // NOTE: サマリーAPI では常に正規化済みの purpose を返し、UI 側は undefined を扱わない。
    purpose: normalizeSetupPurpose(session.purpose),
  };
}

function buildDraftExcerpt(session: SetupSession): string {
  const latestMessage = [...session.messages].reverse().find((message) => message.role === 'user');
  const parts = [
    session.draft.coreConcept,
    ...session.draft.confirmed
      .filter((item) => item.status === 'active')
      .map((item) => item.text),
    ...session.draft.candidates
      .filter((candidate) => candidate.status === 'active')
      .map((candidate) => candidate.summary || candidate.title),
    latestMessage?.content,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  const excerpt = parts[0] ?? '';
  return excerpt.length > 90 ? `${excerpt.slice(0, 90)}...` : excerpt;
}

function addLocks(
  locks: SetupLock[],
  paths: string[],
  reason: SetupLockReason,
  createdAt: string
): SetupLock[] {
  const next = [...locks];
  for (const path of paths) {
    if (next.some((lock) => lock.path === path)) continue;
    next.push({
      lockId: generateTimestampId('lock'),
      path,
      reason,
      createdAt,
    });
  }
  return next;
}

function normalizeLockPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const path = typeof item === 'string' ? item.trim() : '';
    if (!path || path.length > 160 || result.includes(path)) continue;
    result.push(path);
    if (result.length >= 40) break;
  }
  return result;
}

export async function generateSetupPreview(
  sessionId: string,
  body: { instruction?: string } = {}
): Promise<SetupPreviewResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  const result = await generateSetupPreviewText(session, instruction).catch(async (err) => {
    const nextSession = await writeSessionError(session, err);
    throw toSetupServiceError(err, nextSession);
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    const error = adapterResultToError(result);
    const nextSession = await writeSessionError(session, error);
    throw toSetupServiceError(error, nextSession);
  }

  const previewText = result.text.trim();
  const now = nowIso();
  const draft = instruction ? addToneHint(session.draft, instruction) : session.draft;
  const previews: NonNullable<SetupSession['previews']> = [...(session.previews ?? [])];
  previews.push({
    previewId: generateTimestampId('preview'),
    text: previewText,
    createdAt: now,
  });
  while (previews.length > 3) {
    previews.shift();
  }

  const nextSession: SetupSession = {
    ...session,
    draft,
    previews,
    revision: session.revision + 1,
    lastError: null,
    updatedAt: now,
  };
  await storage.writeSetupSession(nextSession);

  return { previewText, session: nextSession, revision: nextSession.revision };
  });
}

async function generateSetupPreviewText(session: SetupSession, instruction = '') {
  const { systemInstructions, userPrompt } = buildSetupPreviewPrompt(session, instruction);
  return generateWithSessionModel(session, {
    systemInstructions,
    userPrompt,
    outputLength: PREVIEW_OUTPUT_LENGTH,
    temperature: PREVIEW_TEMPERATURE,
  });
}

export async function createSetupCommitPlan(
  sessionId: string,
  _body?: { revision?: number }
): Promise<SetupCommitPlanResponse> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    if (!hasMeaningfulSetupContent(session)) {
      throw new SetupServiceError(
        '作品の種がまだありません。相談するか、作品の種メモを入力してください。',
        'setup_content_empty',
        false,
        400,
        session
      );
    }
    const presetIdsByCategory = await readPresetIdsByCategory();
    const styleSample = await resolveAutoStyleSample(session);
    const { systemInstructions, userPrompt } = buildSetupCommitPrompt({
      session,
      presetIdsByCategory,
    });

    const result = await generateWithSessionModel(session, {
      systemInstructions,
      userPrompt,
      outputLength: COMMIT_OUTPUT_LENGTH,
      temperature: COMMIT_TEMPERATURE,
    }).catch(async (err) => {
      const nextSession = await writeSessionError(session, err);
      throw toSetupServiceError(err, nextSession);
    });

    if (result.finishReason === 'error' || result.finishReason === 'timeout') {
      const error = adapterResultToError(result);
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const parsed = parseJsonObject(result.text);
    if (!parsed) {
      const error = new SetupServiceError(
        '最終変換のJSONを読み取れませんでした。もう一度試してください。',
        'invalid_commit_json',
        true,
        503,
        session
      );
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const normalized = normalizeSetupCommitData({
      raw: parsed,
      session,
      presetIdsByCategory,
    });
    const plan = normalizedToPlan(normalized);
    plan.styleSample = styleSample || '';
    const now = nowIso();
    const nextSession: SetupSession = {
      ...session,
      commitPlan: { plan, createdAt: now },
      revision: session.revision + 1,
      lastError: null,
      updatedAt: now,
    };
    await storage.writeSetupSession(nextSession);
    return { plan, session: nextSession, revision: nextSession.revision };
  });
}

function hasMeaningfulSetupContent(session: SetupSession): boolean {
  const draft = session.draft;
  return Boolean(
    session.messages.some((message) => message.role === 'user' && message.content.trim()) ||
      draft.coreConcept.trim() ||
      draft.confirmed.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.candidates.some(
        (item) => item.status === 'active' && (item.title.trim() || item.summary.trim())
      ) ||
      draft.undecided.some((item) => item.status === 'active' && item.text.trim()) ||
      draft.characters.some(
        (item) =>
          item.status === 'active' &&
          (item.name.trim() || item.label.trim() || item.description.trim())
      ) ||
      draft.relationshipSeeds.some((item) => item.trim()) ||
      draft.world.some((item) => item.trim()) ||
      draft.tone.some((item) => item.trim()) ||
      draft.ng.some((item) => item.trim()) ||
      draft.openingSeeds.some((item) => item.trim()) ||
      (draft.scenarioSeeds ?? []).some((item) => item.trim())
  );
}

async function resolveAutoStyleSample(session: SetupSession): Promise<string> {
  const latestPreview = session.previews?.at(-1)?.text.trim();
  if (latestPreview) return latestPreview.slice(0, 1000);
  try {
    const result = await generateSetupPreviewText(session);
    if (result.finishReason === 'error' || result.finishReason === 'timeout') return '';
    return result.text.trim().slice(0, 1000);
  } catch {
    return '';
  }
}

export async function commitSetupSession(
  sessionId: string,
  body: CommitSetupBody
): Promise<SetupCommitResponse> {
  return withSessionLock(sessionId, async () => {
    const existingSession = await readSetupSessionOrThrow(sessionId);
    if (existingSession.status === 'committed' && existingSession.committedProjectId) {
      return { projectId: existingSession.committedProjectId, session: existingSession };
    }
    const session = ensureActiveSession(existingSession);
    if (!hasMeaningfulSetupContent(session)) {
      throw new SetupServiceError(
        '作品の種がまだありません。相談するか、作品の種メモを入力してください。',
        'setup_content_empty',
        false,
        400,
        session
      );
    }
    if (!session.commitPlan) {
      throw new SetupServiceError(
        '作品にする内容を先に確認してください。',
        'setup_plan_missing',
        false,
        400,
        session
      );
    }
    assertValidRevision(body?.revision);
    assertRevision(session, body.revision);

    if (!isRecord(body.plan)) {
      throw new SetupServiceError('作成プランの形式が不正です。', 'invalid_request', false, 400, session);
    }

    const presetIdsByCategory = await readPresetIdsByCategory();
    const normalized = normalizeSetupCommitPlan({
      raw: body.plan,
      session,
      presetIdsByCategory,
    });

    let projectId: string | null = null;
    try {
      const project = await projectService.createProject(normalized.projectInput);
      projectId = project.projectId;
      await storage.writeMemories(project.projectId, normalized.memories);
      await storage.writeStoryState(project.projectId, normalized.storyState);

      const nextSession: SetupSession = {
        ...session,
        status: 'committed',
        committedProjectId: project.projectId,
        revision: session.revision + 1,
        lastError: null,
        updatedAt: nowIso(),
      };
      await storage.writeSetupSession(nextSession);
      return { projectId: project.projectId, session: nextSession };
    } catch (err) {
      if (projectId) {
        await storage.deleteProjectDir(projectId).catch(() => undefined);
      }
      throw err;
    }
  });
}

async function requireActiveSession(sessionId: string): Promise<SetupSession> {
  const session = await readSetupSessionOrThrow(sessionId);
  return ensureActiveSession(session);
}

async function readSetupSessionOrThrow(sessionId: string): Promise<SetupSession> {
  let session: SetupSession | null = null;
  try {
    session = await storage.readSetupSession(sessionId);
  } catch {
    throw new SetupServiceError('相談セッションIDが不正です。', 'invalid_setup_id', false, 400);
  }
  if (!session) {
    throw new SetupServiceError('相談セッションが見つかりません。', 'setup_not_found', false, 404);
  }
  return normalizeStoredSession(session);
}

function normalizeStoredSession(session: SetupSession): SetupSession {
  if (session.schemaVersion !== 1 && session.schemaVersion !== 2) {
    throw new SetupServiceError(
      'この相談セッションの形式には対応していません。',
      'unsupported_setup_schema',
      false,
      400
    );
  }
  return {
    ...session,
    schemaVersion: 2,
    // NOTE: 保存ファイルは purpose 無しのまま許容し、境界で 'novel' に正規化する。
    purpose: normalizeSetupPurpose(session.purpose),
    projectSettings: {
      ...session.projectSettings,
      activePresetIds: normalizeActivePresetIds(
        session.projectSettings?.activePresetIds ?? {}
      ),
    },
    // NOTE: v1 の人物フィールドと欠落した配列を、再開時に一括で v2 へ寄せる。
    draft: normalizeSetupDraft(session.draft),
    previews: session.previews ?? [],
    conversationSummary: session.conversationSummary ?? '',
    commitPlan: session.commitPlan ?? null,
  };
}

function hasCurrentPresetCategory(value: object): boolean {
  return [
    'narration',
    'aftertaste',
    'emotionDisplay',
    'sceneProgression',
    'chapterEnding',
    'painLevel',
  ].some((key) => Object.hasOwn(value, key));
}

function normalizedToPlan(normalized: NormalizedSetupCommitData): SetupCommitPlan {
  const { projectInput } = normalized;
  // NOTE: normalizeSetupCommitPlan が session.purpose から強制的にセット済み。
  const projectType = projectInput.projectType === 'roleplay' ? 'roleplay' : 'novel';
  return {
    project: {
      title: projectInput.title ?? '無題の作品',
      outputLength: projectInput.outputLength ?? 3000,
      activePresetIds: projectInput.activePresetIds ?? {},
      projectType,
    },
    coreConcept: projectInput.coreConcept ?? '',
    // NOTE: roleplay 用途では firstWishSuggestion を UI・保存対象から外す。
    firstWishSuggestion:
      projectType === 'roleplay' ? '' : projectInput.firstWishSuggestion ?? '',
    styleSample: projectInput.styleSample ?? '',
    world: projectInput.world ?? { foundation: '', initialSituation: '' },
    characters: projectInput.characters ?? [],
    memories: normalized.memories,
    storyState: normalized.storyState,
    customSystemPrompt: projectInput.customSystemPrompt ?? '',
    scenarioSeeds: projectInput.scenarioSeeds ?? [],
  };
}

function addToneHint(draft: SetupDraft, hint: string): SetupDraft {
  const text = hint.trim();
  if (!text) return draft;
  if (draft.tone.some((item) => normalizeComparableText(item) === normalizeComparableText(text))) {
    return draft;
  }
  return {
    ...draft,
    tone: [...draft.tone.slice(-11), text],
  };
}

function ensureActiveSession(session: SetupSession): SetupSession {
  if (session.status !== 'active') {
    throw new SetupServiceError('この相談セッションは更新できません。', 'setup_not_active', false, 400, session);
  }
  return session;
}

async function acquireSessionLock(sessionId: string): Promise<() => void> {
  const previous = sessionMutexes.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  sessionMutexes.set(sessionId, next);

  await previous.catch(() => undefined);
  return () => {
    release();
    if (sessionMutexes.get(sessionId) === next) {
      sessionMutexes.delete(sessionId);
    }
  };
}

async function withSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>
): Promise<T> {
  const releaseLock = await acquireSessionLock(sessionId);
  try {
    return await task();
  } finally {
    releaseLock();
  }
}

function assertRevision(session: SetupSession, revision: number): void {
  if (session.revision !== revision) {
    throw new SetupServiceError(
      '相談メモが更新されています。最新の内容を確認してください。',
      'revision_conflict',
      false,
      409,
      session
    );
  }
}

function assertValidRevision(revision: unknown): asserts revision is number {
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new SetupServiceError('リクエストの形式が不正です。', 'invalid_request', false, 400);
  }
}

async function generateWithSessionModel(
  session: SetupSession,
  request: {
    systemInstructions: string;
    userPrompt: string;
    outputLength: number;
    temperature: number;
    abortSignal?: AbortSignal;
  }
) {
  await reloadCredentials();
  const adapter = adapterMap[session.model.provider];
  if (!adapter) {
    throw new SetupServiceError(
      `Unsupported provider: ${session.model.provider}`,
      'unsupported_provider',
      false,
      400,
      session
    );
  }

  try {
    return await adapter.generateText({
      ...request,
      timeoutMs: TIMEOUT_MS,
      modelName: session.model.modelName,
    });
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new SetupServiceError(err.message, err.code, err.retryable, 503, session);
    }
    throw err;
  }
}

async function writeSessionError(
  session: SetupSession,
  err: unknown
): Promise<SetupSession> {
  const setupError = normalizeSessionError(err);
  const nextSession: SetupSession = {
    ...session,
    lastError: setupError,
    updatedAt: nowIso(),
  };
  await storage.writeSetupSession(nextSession);
  return nextSession;
}

function normalizeSessionError(err: unknown): SetupSessionError {
  if (err instanceof SetupServiceError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      createdAt: nowIso(),
    };
  }
  if (err instanceof ModelAdapterError) {
    return {
      code: err.code,
      message: err.message,
      retryable: err.retryable,
      createdAt: nowIso(),
    };
  }
  return {
    code: 'setup_failed',
    message: err instanceof Error ? err.message : '相談処理に失敗しました。',
    retryable: true,
    createdAt: nowIso(),
  };
}

const DRAFT_PATCH_MARKER = '===DRAFT_PATCH===';
const MAX_CONVERSATION_SUMMARY_CHARS = 2000;

export function parseChatResult(text: string): {
  visibleReply: string;
  draftPatch: unknown | null;
  suggestedActions: SetupSuggestedAction[];
  conversationSummary: string | null;
} {
  const markerIndex = text.indexOf(DRAFT_PATCH_MARKER);
  if (markerIndex >= 0) {
    const visibleReply = text.slice(0, markerIndex).trim();
    const jsonPart = text.slice(markerIndex + DRAFT_PATCH_MARKER.length);
    const parsed = parseJsonObject(jsonPart);
    if (parsed) {
      return {
        visibleReply,
        draftPatch: parsed.draftPatch ?? null,
        suggestedActions: normalizeSuggestedActions(parsed.suggestedActions),
        conversationSummary: asString(parsed.conversationSummary) || null,
      };
    }
    return {
      visibleReply,
      draftPatch: null,
      suggestedActions: [],
      conversationSummary: null,
    };
  }

  const parsed = parseJsonObject(text);
  if (parsed) {
    return {
      visibleReply: asString(parsed.visibleReply),
      draftPatch: parsed.draftPatch ?? null,
      suggestedActions: normalizeSuggestedActions(parsed.suggestedActions),
      conversationSummary: asString(parsed.conversationSummary) || null,
    };
  }

  const plain = stripCodeFence(text).trim();
  if (!plain) {
    return unreadableChatFallback();
  }
  if (plain.includes('draftPatch') || plain.includes('visibleReply')) {
    return unreadableChatFallback();
  }

  return {
    visibleReply: plain,
    draftPatch: null,
    suggestedActions: [],
    conversationSummary: null,
  };
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function unreadableChatFallback(): {
  visibleReply: string;
  draftPatch: null;
  suggestedActions: SetupSuggestedAction[];
  conversationSummary: null;
} {
  return {
    visibleReply: UNREADABLE_CHAT_REPLY,
    draftPatch: null,
    suggestedActions: UNREADABLE_CHAT_ACTIONS.map((action) => ({ ...action })),
    conversationSummary: null,
  };
}

function normalizeSuggestedActions(value: unknown): SetupSuggestedAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label = asString(item.label);
      const message = asString(item.message);
      const intent = normalizeSuggestedActionIntent(item.intent);
      return label && message ? { label, message, ...(intent ? { intent } : {}) } : null;
    })
    .filter((item): item is SetupSuggestedAction => item !== null)
    .slice(0, 4);
}

function normalizeSuggestedActionIntent(value: unknown): SetupSuggestedAction['intent'] {
  return value === 'preview' || value === 'commit' ? value : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function adapterResultToError(result: {
  errorCode?: string;
  errorMessage?: string;
  retryable: boolean;
}): SetupServiceError {
  const code = result.errorCode || 'setup_generation_failed';
  return new SetupServiceError(
    mapErrorMessage(code, result.errorMessage),
    code,
    result.retryable,
    503
  );
}

function toSetupServiceError(err: unknown, session?: SetupSession): SetupServiceError {
  if (err instanceof SetupServiceError) {
    return session && !err.session
      ? new SetupServiceError(err.message, err.code, err.retryable, err.status, session)
      : err;
  }
  if (err instanceof ModelAdapterError) {
    return new SetupServiceError(err.message, err.code, err.retryable, 503, session);
  }
  return new SetupServiceError(
    err instanceof Error ? err.message : '相談処理に失敗しました。',
    'setup_failed',
    true,
    503,
    session
  );
}

function mapErrorMessage(code: string, detail?: string): string {
  let base: string;
  switch (code) {
    case 'api_key_missing':
      base = 'APIキーが設定されていません。設定画面からAPIキーを入力してください。';
      break;
    case 'invalid_api_key':
      base = 'APIキーが無効です。設定を確認してください。';
      break;
    case 'payment_required':
      base = 'APIキーのクレジットが不足しています。プロバイダー側の残高や利用上限を確認してください。';
      break;
    case 'permission_denied':
      base = 'APIキーにこのモデルを利用する権限がないか、プロバイダー側で拒否されました。';
      break;
    case 'rate_limit':
      base = 'リクエスト制限に達しました。しばらくしてから再試行してください。';
      break;
    case 'timeout':
      base = '生成がタイムアウトしました。少し待って再試行してください。';
      break;
    case 'service_unavailable':
      base = 'モデルサービスを現在利用できません。少し待って再試行してください。';
      break;
    default:
      base = '相談処理に失敗しました。設定を確認して再試行してください。';
  }
  return detail && detail !== base ? `${base}\n詳細: ${detail}` : base;
}

function normalizeProvider(value: string | undefined): string {
  return value && isSupportedProvider(value) ? value : DEFAULT_MODEL_PROVIDER;
}

function normalizeOutputLength(value: number | undefined): number {
  if (!Number.isFinite(value)) return 3000;
  return Math.max(500, Math.min(10000, Math.round(value as number)));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SetupServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
    public readonly session?: SetupSession
  ) {
    super(message);
    this.name = 'SetupServiceError';
  }
}
