import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { defaultModelForProvider, isSupportedProvider } from './modelInfoService.js';
import { reloadCredentials } from './credentialService.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as projectService from './projectService.js';
import {
  applySetupDraftPatch,
  createEmptySetupDraft,
  normalizeSetupDraft,
} from './setupDraftPatchService.js';
import {
  buildSetupChatPrompt,
  buildSetupCommitPrompt,
  buildSetupPreviewPrompt,
} from './setupPromptBuilder.js';
import {
  normalizeSetupCommitData,
  readPresetIdsByCategory,
} from './setupCommitService.js';
import type {
  ActivePresets,
  CreateSetupSessionBody,
  SendSetupMessageBody,
  SetupCommitResponse,
  SetupDraft,
  SetupDraftResponse,
  SetupLock,
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

const DEFAULT_ACTIVE_PRESETS: ActivePresets = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  relationshipPacing: 'standard',
};

const adapterMap: Record<string, ModelAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
};

const sessionMutexes = new Map<string, Promise<void>>();

type SetupLockReason = SetupLock['reason'];

export async function listSetupSessions(): Promise<SetupSessionSummary[]> {
  const sessionIds = await storage.listSetupSessionIds();
  const sessions = await Promise.all(
    sessionIds.map((sessionId) => storage.readSetupSession(sessionId).catch(() => null))
  );

  return sessions
    .filter((session): session is SetupSession => session !== null)
    .map(toSetupSessionSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createSetupSession(
  body: CreateSetupSessionBody
): Promise<SetupSessionResponse> {
  const now = nowIso();
  const provider = normalizeProvider(body.model?.provider);
  const session: SetupSession = {
    schemaVersion: 1,
    sessionId: generateTimestampId('setup'),
    projectId: null,
    status: 'active',
    revision: 1,
    model: {
      provider,
      modelName:
        body.model?.modelName?.trim() || defaultModelForProvider(provider),
    },
    projectSettings: {
      title: body.projectSettings?.title?.trim() || '',
      outputLength: normalizeOutputLength(body.projectSettings?.outputLength),
      streamingEnabled: body.projectSettings?.streamingEnabled ?? false,
      activePresetIds: {
        ...DEFAULT_ACTIVE_PRESETS,
        ...(body.projectSettings?.activePresetIds ?? {}),
      },
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
    return await storage.readSetupSession(sessionId);
  } catch {
    throw new SetupServiceError('相談セッションIDが不正です。', 'invalid_setup_id', false, 400);
  }
}

export async function sendSetupMessage(
  sessionId: string,
  body: SendSetupMessageBody
): Promise<SetupMessageResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  assertRevision(session, body.revision);

  const messageText = body.message.trim();
  if (!messageText) {
    throw new SetupServiceError('メッセージを入力してください。', 'invalid_message', false, 400);
  }

  const now = nowIso();
  const userMessage: SetupMessage = {
    messageId: generateTimestampId('msg'),
    role: 'user',
    content: messageText,
    createdAt: now,
  };

  let workingSession: SetupSession = {
    ...session,
    messages: [...session.messages, userMessage],
    revision: session.revision + 1,
    lastError: null,
    updatedAt: now,
  };
  await storage.writeSetupSession(workingSession);

  const { systemInstructions, userPrompt } = buildSetupChatPrompt({
    session: workingSession,
    userMessage: messageText,
  });

  const result = await generateWithSessionModel(workingSession, {
    systemInstructions,
    userPrompt,
    outputLength: CHAT_OUTPUT_LENGTH,
    temperature: CHAT_TEMPERATURE,
  }).catch(async (err) => {
    workingSession = await writeSessionError(workingSession, err);
    throw toSetupServiceError(err, workingSession);
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    const error = adapterResultToError(result);
    workingSession = await writeSessionError(workingSession, error);
    throw toSetupServiceError(error, workingSession);
  }

  const parsed = parseChatResult(result.text);
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
  });
}

export async function updateSetupDraft(
  sessionId: string,
  body: UpdateSetupDraftBody
): Promise<SetupDraftResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  assertRevision(session, body.revision);
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

export async function addSetupLock(
  sessionId: string,
  path: string,
  reason: SetupLockReason = 'user_locked'
): Promise<SetupSession> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  const normalizedPath = path.trim();
  if (!normalizedPath) {
    throw new SetupServiceError('path is required', 'invalid_lock_path', false, 400);
  }
  const normalizedReason = normalizeLockReason(reason);
  const now = nowIso();

  const nextSession: SetupSession = {
    ...session,
    locks: addLocks(session.locks, [normalizedPath], normalizedReason, now),
    revision: session.revision + 1,
    updatedAt: now,
  };
  await storage.writeSetupSession(nextSession);
  return nextSession;
  });
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

function normalizeLockReason(value: unknown): SetupLockReason {
  return value === 'manual_edit' ? 'manual_edit' : 'user_locked';
}

export async function removeSetupLock(
  sessionId: string,
  lockId: string
): Promise<SetupSession> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  const nextSession: SetupSession = {
    ...session,
    locks: session.locks.filter((lock) => lock.lockId !== lockId),
    revision: session.revision + 1,
    updatedAt: nowIso(),
  };
  await storage.writeSetupSession(nextSession);
  return nextSession;
  });
}

export async function generateSetupPreview(
  sessionId: string
): Promise<SetupPreviewResponse> {
  return withSessionLock(sessionId, async () => {
  const session = await requireActiveSession(sessionId);
  const { systemInstructions, userPrompt } = buildSetupPreviewPrompt(session);
  const result = await generateWithSessionModel(session, {
    systemInstructions,
    userPrompt,
    outputLength: PREVIEW_OUTPUT_LENGTH,
    temperature: PREVIEW_TEMPERATURE,
  }).catch(async (err) => {
    const nextSession = await writeSessionError(session, err);
    throw toSetupServiceError(err, nextSession);
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    const error = adapterResultToError(result);
    const nextSession = await writeSessionError(session, error);
    throw toSetupServiceError(error, nextSession);
  }

  return { previewText: result.text.trim() };
  });
}

export async function commitSetupSession(
  sessionId: string
): Promise<SetupCommitResponse> {
  return withSessionLock(sessionId, async () => {
  const existingSession = await readSetupSessionOrThrow(sessionId);
  if (existingSession.status === 'committed' && existingSession.committedProjectId) {
    return { projectId: existingSession.committedProjectId, session: existingSession };
  }
  const session = ensureActiveSession(existingSession);
  const presetIdsByCategory = await readPresetIdsByCategory();
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
  return session;
}

function ensureActiveSession(session: SetupSession): SetupSession {
  if (session.status !== 'active') {
    throw new SetupServiceError('この相談セッションは更新できません。', 'setup_not_active', false, 400, session);
  }
  return session;
}

async function withSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = sessionMutexes.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  sessionMutexes.set(sessionId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (sessionMutexes.get(sessionId) === next) {
      sessionMutexes.delete(sessionId);
    }
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

async function generateWithSessionModel(
  session: SetupSession,
  request: {
    systemInstructions: string;
    userPrompt: string;
    outputLength: number;
    temperature: number;
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

export function parseChatResult(text: string): {
  visibleReply: string;
  draftPatch: unknown | null;
  suggestedActions: SetupSuggestedAction[];
} {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return {
      visibleReply: UNREADABLE_CHAT_REPLY,
      draftPatch: null,
      suggestedActions: UNREADABLE_CHAT_ACTIONS.map((action) => ({ ...action })),
    };
  }

  return {
    visibleReply: asString(parsed.visibleReply),
    draftPatch: parsed.draftPatch ?? null,
    suggestedActions: normalizeSuggestedActions(parsed.suggestedActions),
  };
}

function normalizeSuggestedActions(value: unknown): SetupSuggestedAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label = asString(item.label);
      const message = asString(item.message);
      return label && message ? { label, message } : null;
    })
    .filter((item): item is SetupSuggestedAction => item !== null)
    .slice(0, 4);
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
    case 'rate_limit':
      base = 'リクエスト制限に達しました。しばらくしてから再試行してください。';
      break;
    case 'timeout':
      base = '生成がタイムアウトしました。少し待って再試行してください。';
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
  if (!Number.isFinite(value)) return 6000;
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
