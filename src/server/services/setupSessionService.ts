import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { defaultModelForProvider, isSupportedProvider } from './modelInfoService.js';
import { reloadCredentials } from './credentialService.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { KeyedMutex } from '../utils/keyedMutex.js';
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
  buildSetupDraftExtractionPrompt,
  buildSetupPreviewPrompt,
} from './setupPromptBuilder.js';
import {
  normalizeSetupCommitData,
  normalizeSetupCommitPlan,
  readPresetIdsByCategory,
} from './setupCommitService.js';
import { normalizeSetupPurpose } from '../types/index.js';
import {
  INTERACTIVE_TASK_MAX_OUTPUT_TOKENS,
  JSON_TASK_MAX_OUTPUT_TOKENS,
} from '../utils/outputLength.js';
import { DEFAULT_STREAMING_ENABLED } from '../../shared/defaults.js';
import { normalizeActivePresetIds } from '../../shared/presetMigration.js';
import { hasSetupDraftContent } from '../../shared/setupContent.js';
import type { SetupPurpose } from '../types/index.js';
import type { NormalizedSetupCommitData } from './setupCommitService.js';
import type {
  CanonScope,
  Character,
  CommitSetupBody,
  ConfirmQuickContractsBody,
  CreateQuickSetupPlanBody,
  CreateSetupSessionBody,
  CreativeContractItem,
  FinishReason,
  LatentCanonItem,
  PatchSetupSettingsBody,
  QuickContractCandidate,
  RetrySetupMessageBody,
  SendSetupMessageBody,
  SetLockStateBody,
  SetupCommitPlan,
  SetupCommitPlanResponse,
  SetupCommitResponse,
  SetupDraft,
  SetupDraftCharacter,
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
  UpdateSetupDraftBody,
} from '../types/index.js';
import {
  SetupServiceError,
  adapterResultToError,
  mapErrorMessage,
  toSetupServiceError,
} from './setupSessionErrors.js';
export { SetupServiceError } from './setupSessionErrors.js';
export { normalizeChatReply } from './setupSessionParsing.js';
import {
  DRAFT_PATCH_MARKER,
  MAX_CONVERSATION_SUMMARY_CHARS,
  isRecord,
  normalizeChatReply,
  parseDraftExtraction,
  parseJsonObject,
} from './setupSessionParsing.js';
import {
  assertRevision,
  assertValidCreateSetupSessionBody,
  assertValidRevision,
  normalizeOutputLength,
  normalizeProvider,
} from './setupSessionValidation.js';

const CHAT_OUTPUT_LENGTH = 1800;
const PREVIEW_OUTPUT_LENGTH = 900;
const COMMIT_OUTPUT_LENGTH = 3200;
const CHAT_TEMPERATURE = 0.7;
const PREVIEW_TEMPERATURE = 0.8;
const COMMIT_TEMPERATURE = 0.2;
const TIMEOUT_MS = 120_000;

// NOTE: 相談は一問一答のやり取りで、待たされること自体が体験を壊す。思考モデルの
// 既定（本文向けの最大熟考）をそのまま使うと、短い返答のために延々と考え込み、
// max_tokens を思考で使い切って本文0字で返る事故が起きた。相談経路は熟考量を落とす。
const CHAT_REASONING_EFFORT = 'low' as const;
const PREVIEW_REASONING_EFFORT = 'low' as const;
// NOTE: 最終変換だけは設定一式を JSON へ組み替える重い変換なので中程度を残す。
// 出力も長いため枠は JSON タスク用の広い方を使う。
const COMMIT_REASONING_EFFORT = 'medium' as const;

// NOTE: 設定草案への書き起こしは responseMimeType=json を指定するので、DeepSeek 側で
// 思考が切れる。reasoningEffort は渡さない（渡しても json 分岐が優先される）。
const DRAFT_EXTRACT_OUTPUT_LENGTH = 3000;
const DRAFT_EXTRACT_TEMPERATURE = 0.2;

// NOTE: 文言はクライアントのボタン名（「今の相談を草案にまとめる」）と揃える。
// ずれると、画面のどれを押せばいいのか分からないエラーになる。
const SETUP_DRAFT_REQUIRED_MESSAGE =
  '設定草案がまだ空です。「今の相談を草案にまとめる」を実行してから作品にしてください。';

const sessionMutex = new KeyedMutex();

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
  assertValidCreateSetupSessionBody(body);
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
  const setupMode: 'quick' | 'full' = body.setupMode === 'quick' ? 'quick' : 'full';
  const requestedPresetIds = body.projectSettings?.activePresetIds ?? {};
  const session: SetupSession = {
    schemaVersion: 2,
    sessionId: generateTimestampId('setup'),
    projectId: null,
    status: 'active',
    revision: 1,
    purpose,
    setupMode,
    model: {
      provider,
      modelName:
        body.model?.modelName?.trim() || defaultModelForProvider(provider),
    },
    projectSettings: {
      title: body.projectSettings?.title?.trim() || '',
      outputLength: normalizeOutputLength(body.projectSettings?.outputLength),
      streamingEnabled: body.projectSettings?.streamingEnabled ?? DEFAULT_STREAMING_ENABLED,
      activePresetIds: normalizeActivePresetIds(requestedPresetIds),
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
    return { sessionId: session.sessionId, session };
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
    };
  } catch (err) {
    if (err instanceof SetupServiceError && err.session) {
      return {
        sessionId: session.sessionId,
        session: err.session,
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
    debugLabel: 'setup.chat',
    systemInstructions,
    userPrompt,
    outputLength: CHAT_OUTPUT_LENGTH,
    temperature: CHAT_TEMPERATURE,
    maxOutputTokens: INTERACTIVE_TASK_MAX_OUTPUT_TOKENS,
    reasoningEffort: CHAT_REASONING_EFFORT,
  }).catch(async (err) => {
    const nextSession = await writeSessionError(workingSession, err);
    throw toSetupServiceError(err, nextSession);
  });

  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    const error = adapterResultToError(result);
    const nextSession = await writeSessionError(workingSession, error);
    throw toSetupServiceError(error, nextSession);
  }

  // NOTE: 空応答ガード。これが無いと空文字が assistant メッセージとして lastError=null の
  // まま履歴に保存され、利用者には会話が進まない理由が見えず再試行ボタンも出ない。
  // finishReason は length（枠切れ）でも error ではないため、上の分岐では捕まらない。
  //
  // 判定は正規化後の文字列で行う。素の text を見ると、応答が ===DRAFT_PATCH=== で
  // 始まったとき（マーカー除去を保険として残している、まさにその状況）にガードを
  // すり抜けて空メッセージが保存される。
  const reply = normalizeChatReply(result.text);
  if (!reply) {
    const error = emptyChatResponseError(workingSession, result.debugInfo, 'setup.chat');
    const nextSession = await writeSessionError(workingSession, error);
    throw toSetupServiceError(error, nextSession);
  }

  return finalizeChatTurn(workingSession, reply);
}

/**
 * 本文0字で返ってきたときの共通エラー。ストリーミングと非ストリーミングで文言と
 * 診断の出方を揃える。思考モデルが枠を思考で使い切ったケースがここに集まるので、
 * 切り分けに要る診断はサーバーログにも必ず残す。
 */
function emptyChatResponseError(
  session: SetupSession,
  debugInfo: string | undefined,
  label: string
): SetupServiceError {
  console.warn('Setup model returned no text', {
    label,
    sessionId: session.sessionId,
    provider: session.model.provider,
    modelName: session.model.modelName,
    debugInfo: debugInfo ?? 'none',
  });
  return new SetupServiceError(
    mapErrorMessage('empty_response', debugInfo),
    'empty_response',
    true,
    503,
    session
  );
}

// NOTE: 相談ターンは会話だけを進め、設定草案には触れない。メモへの反映は
// generateSetupDraft（利用者が「今の相談を草案にまとめる」を実行）に一本化した。
// NOTE: visibleReply は呼び出し側で normalizeChatReply 済みのものを受け取る。
// ここで正規化すると「ガードは素のテキスト、保存は正規化後」というずれが生まれ、
// 空メッセージがガードをすり抜ける。正規化と検査は必ず同じ文字列に対して行う。
async function finalizeChatTurn(
  workingSession: SetupSession,
  visibleReply: string
): Promise<SetupMessageResponse> {
  const assistantMessage: SetupMessage = {
    messageId: generateTimestampId('msg'),
    role: 'assistant',
    content: visibleReply,
    createdAt: nowIso(),
  };

  const nextSession: SetupSession = {
    ...workingSession,
    messages: [...workingSession.messages, assistantMessage],
    revision: workingSession.revision + 1,
    lastError: null,
    updatedAt: nowIso(),
  };
  await storage.writeSetupSession(nextSession);

  return {
    session: nextSession,
    assistantMessage,
    draft: nextSession.draft,
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
    debugLabel: 'setup.chat.stream',
    systemInstructions,
    userPrompt,
    outputLength: CHAT_OUTPUT_LENGTH,
    temperature: CHAT_TEMPERATURE,
    maxOutputTokens: INTERACTIVE_TASK_MAX_OUTPUT_TOKENS,
    reasoningEffort: CHAT_REASONING_EFFORT,
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

    // NOTE: ストリーミング非対応アダプタ用の分岐。相談チャットの空応答経路は3つある。
    const reply = normalizeChatReply(result.text);
    if (!reply) {
      const error = emptyChatResponseError(workingSession, result.debugInfo, 'setup.chat.stream');
      const nextSession = await writeSessionError(workingSession, error);
      throw toSetupServiceError(error, nextSession);
    }

    const response = await finalizeChatTurn(workingSession, reply);
    if (response.assistantMessage?.content) {
      yield { type: 'delta', text: response.assistantMessage.content };
    }
    yield { type: 'result', response };
    return;
  }

  let generatedText = '';
  let finishReason: FinishReason = 'stop';
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

  const streamedReply = normalizeChatReply(generatedText);
  if (!streamedReply) {
    const emptyError = emptyChatResponseError(workingSession, debugInfo, 'setup.chat.stream');
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

  const response = await finalizeChatTurn(workingSession, streamedReply);
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

/**
 * 会話ログから設定草案へ一括で書き起こす。相談中は毎ターン走らせず、利用者が
 * 「今の相談を草案にまとめる」を押したときと、作品化の前だけ実行する。
 *
 * JSON 出力なので responseMimeType を指定する。DeepSeek はこれで思考モードが切れ、
 * 抽出が本来の速さで終わる（相談チャットに構造化出力を混ぜていた頃の遅さと
 * 空応答は、この組み合わせが取れなかったことが原因だった）。
 */
export async function generateSetupDraft(
  sessionId: string,
  body: { revision?: number } = {}
): Promise<SetupDraftResponse> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    if (body.revision !== undefined) {
      assertValidRevision(body.revision);
      assertRevision(session, body.revision);
    }
    if (!session.messages.some((message) => message.role === 'user' && message.content.trim())) {
      throw new SetupServiceError(
        'まだ相談の内容がありません。先に相談してください。',
        'setup_content_empty',
        false,
        400,
        session
      );
    }

    const { systemInstructions, userPrompt } = buildSetupDraftExtractionPrompt({ session });
    const result = await generateWithSessionModel(session, {
      debugLabel: 'setup.draftExtract',
      systemInstructions,
      userPrompt,
      outputLength: DRAFT_EXTRACT_OUTPUT_LENGTH,
      temperature: DRAFT_EXTRACT_TEMPERATURE,
      maxOutputTokens: JSON_TASK_MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
    }).catch(async (err) => {
      const nextSession = await writeSessionError(session, err);
      throw toSetupServiceError(err, nextSession);
    });

    if (result.finishReason === 'error' || result.finishReason === 'timeout') {
      const error = adapterResultToError(result);
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    if (!result.text.trim()) {
      const error = emptyChatResponseError(session, result.debugInfo, 'setup.draftExtract');
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const parsed = parseDraftExtraction(result.text);
    if (!parsed) {
      const error = new SetupServiceError(
        'メモへの書き起こしを読み取れませんでした。もう一度試してください。',
        'invalid_draft_json',
        true,
        503,
        session
      );
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const draft = parsed.draftPatch
      ? applySetupDraftPatch({
          draft: session.draft,
          patch: parsed.draftPatch,
          locks: session.locks,
          source: 'llm',
        })
      : session.draft;

    const nextSession: SetupSession = {
      ...session,
      draft,
      conversationSummary: parsed.conversationSummary
        ? parsed.conversationSummary.slice(0, MAX_CONVERSATION_SUMMARY_CHARS)
        : session.conversationSummary,
      draftWrittenUpMessageCount: session.messages.length,
      revision: session.revision + 1,
      lastError: null,
      updatedAt: nowIso(),
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

  // NOTE: 試し書きは相談経路の中で最も出力枠が小さく、散文を書かせるので思考も長い。
  // ガードが無いと空文字がそのまま試し書き履歴に積まれ、画面には何も出ないのに
  // 成功扱いになる。相談チャットと同じく length では error にならない点に注意。
  if (!result.text.trim()) {
    const error = emptyChatResponseError(session, result.debugInfo, 'setup.preview');
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
    debugLabel: 'setup.preview',
    systemInstructions,
    userPrompt,
    outputLength: PREVIEW_OUTPUT_LENGTH,
    temperature: PREVIEW_TEMPERATURE,
    maxOutputTokens: INTERACTIVE_TASK_MAX_OUTPUT_TOKENS,
    reasoningEffort: PREVIEW_REASONING_EFFORT,
  });
}

// ============================================================
// クイックセットアップ（設計書 4.1）
// ============================================================

const QUICK_PLAN_OUTPUT_LENGTH = 5_000;
const QUICK_PLAN_TEMPERATURE = 0.5;

export interface CreateQuickSetupPlanResult {
  plan: SetupCommitPlan;
  session: SetupSession;
  revision: number;
}

// NOTE: 一文の希望から最小の計画を1回の構造化呼び出しで作る。契約候補・最小人物・
// 薄い潜在設定（最大8件）を SetupDraft / SetupCommitPlan を通して確認・commitする。
export async function createQuickSetupPlan(
  sessionId: string,
  body: CreateQuickSetupPlanBody
): Promise<CreateQuickSetupPlanResult> {
  return withSessionLock(sessionId, async () => {
    const session = ensureActiveSession(await readSetupSessionOrThrow(sessionId));
    assertValidRevision(body?.revision);
    assertRevision(session, body.revision);
    const wish = asString(body?.wish);
    if (!wish) {
      throw new SetupServiceError(
        '見たい作品を一文で書いてください。',
        'quick_wish_required',
        false,
        400,
        session
      );
    }
    const purpose: SetupPurpose = normalizeSetupPurpose(session.purpose);
    const hardContracts = Array.isArray(body.hardContracts)
      ? body.hardContracts.map(asString).filter(Boolean).slice(0, 8)
      : [];
    const openingWish = asString(body?.openingWish);

    const userPrompt = [
      'あなたは小説アプリのクイックセットアップ係です。',
      '利用者の一文の希望から、作品開始に必要な最小限の計画をJSONで作ってください。',
      '裏設定を大量に作らないこと。薄い初期補完に留め、人物・世界は本文で自然に明らかになる余地を残してください。',
      'JSONオブジェクトだけを出力してください。',
      '【希望】',
      wish,
      ...(hardContracts.length > 0
        ? ['【絶対に守ってほしいこと（作者明示・hard契約になる）】', ...hardContracts.map((text) => `- ${text}`)]
        : []),
      ...(openingWish ? ['【最初に見たい場面】', openingWish] : []),
      purpose === 'roleplay'
        ? '【用途】ロールプレイ。会話相手となる主人公格のキャラクター（greeting付き）を必ず含めてください。'
        : '【用途】連載小説。',
      '【出力形式】',
      JSON.stringify(
        {
          title: '仮タイトル',
          coreConcept: '作品の核（1文）',
          contracts: [{ kind: 'promise|prohibition|preference', text: '契約の文言' }],
          characters: [
            {
              role: 'protagonist|deuteragonist|supporting',
              name: '名前',
              description: '概要（2〜3文）',
              speechStyle: '口調（任意）',
              secrets: '見せない面（任意）',
              greeting: 'ロールプレイの開幕メッセージ（roleplayのみ）',
            },
          ],
          world: { foundation: '世界の土台', initialSituation: '開始時点の状況' },
          openingSeeds: ['最初の場面の候補'],
          scenarioSeeds: ['ロールプレイの会話舞台候補'],
          latentCanon: [
            {
              scope: 'world|character|relationship|history|plot|other',
              statement: '本文にまだ出ない設定（最大8件）',
            },
          ],
        },
        null,
        2
      ),
      '【制約】',
      [
        '- contracts は hope から読み取れる約束・禁止・好みだけを抽出する。作者が明示した hardContracts は必ず contracts に含める。',
        '- contracts は最大5件。promise / prohibition は hard 候補、preference は soft。',
        '- characters は小説では1〜3人、ロールプレイでは1人以上（会話相手が必要）。',
        '- latentCanon は最大8件。本文にまだ出ない設定だけを入れる。',
        '- 本文にすでに現れる内容や、作者がまだ決めていないことを勝手に確定する設定は入れない。',
      ].join('\n'),
    ].join('\n\n---\n\n');

    const result = await generateWithSessionModel(session, {
      debugLabel: 'setup.quickPlan',
      systemInstructions:
        'あなたは小説アプリのクイックセットアップ係です。JSONオブジェクトだけを出力してください。',
      userPrompt,
      outputLength: QUICK_PLAN_OUTPUT_LENGTH,
      temperature: QUICK_PLAN_TEMPERATURE,
      maxOutputTokens: JSON_TASK_MAX_OUTPUT_TOKENS,
      reasoningEffort: 'medium',
      responseMimeType: 'application/json',
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
        'クイックセットアップのJSONを読み取れませんでした。もう一度試してください。',
        'invalid_quick_json',
        true,
        503,
        session
      );
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const plan = buildQuickSetupPlan({
      raw: parsed,
      session,
      purpose,
      hardContracts,
      openingWish,
    });
    // NOTE: ロールプレイは会話相手のCharacter生成が不可欠（設計書 4.1）。
    if (purpose === 'roleplay' && plan.characters.length === 0) {
      const error = new SetupServiceError(
        '会話相手の人物を作成できませんでした。再試行してください。',
        'quick_character_failed',
        true,
        503,
        session
      );
      const nextSession = await writeSessionError(session, error);
      throw toSetupServiceError(error, nextSession);
    }

    const now = nowIso();
    const draft = buildQuickSetupDraft(parsed, hardContracts, session, now);
    const nextSession: SetupSession = {
      ...session,
      draft,
      commitPlan: { plan, createdAt: now },
      revision: session.revision + 1,
      lastError: null,
      updatedAt: now,
    };
    await storage.writeSetupSession(nextSession);
    return { plan, session: nextSession, revision: nextSession.revision };
  });
}

// NOTE: 確認カードの結果をdraft.quickContractsへ反映し、commitPlanの契約を再構築する
// （設計書 4.1-2）。confirmed の項目だけが hard 契約（source: user）になる。
export async function confirmQuickContracts(
  sessionId: string,
  body: ConfirmQuickContractsBody
): Promise<CreateQuickSetupPlanResult> {
  return withSessionLock(sessionId, async () => {
    const session = ensureActiveSession(await readSetupSessionOrThrow(sessionId));
    assertValidRevision(body?.revision);
    assertRevision(session, body.revision);
    if (!session.commitPlan) {
      throw new SetupServiceError(
        '先にクイックセットアップの計画を作成してください。',
        'quick_plan_missing',
        false,
        400,
        session
      );
    }
    const confirmed = new Map(
      (Array.isArray(body.items) ? body.items : []).map((item) => [
        asString(item.id),
        item.confirmed === true,
      ])
    );
    const now = nowIso();
    const quickContracts = (session.draft.quickContracts ?? []).map((item) =>
      confirmed.has(item.id)
        ? {
            ...item,
            source: confirmed.get(item.id) ? ('user' as const) : item.source,
            status: confirmed.get(item.id) ? ('active' as const) : ('archived' as const),
            updatedAt: now,
          }
        : item
    );
    const draft: SetupDraft = { ...session.draft, quickContracts };

    const plan: SetupCommitPlan = {
      ...session.commitPlan.plan,
      // NOTE: hard候補は確認済み（source user）だけを契約に残す。softはAI提案でも
      // 「確認不要」として表示しているため、activeならsourceを維持したまま残す
      // （レビュー指摘 P2）。件数はhard 8 / soft 12の上限に従う。
      creativeContract: (() => {
        const result: CreativeContractItem[] = [];
        let hardCount = 0;
        let softCount = 0;
        for (const item of quickContracts) {
          if (item.status !== 'active') continue;
          if (item.source !== 'user' && item.strength !== 'soft') continue;
          if (item.strength === 'hard') {
            if (hardCount >= 8) continue;
            hardCount += 1;
          } else {
            if (softCount >= 12) continue;
            softCount += 1;
          }
          result.push({
            contractId: item.id,
            kind: item.kind,
            strength: item.strength,
            text: item.text,
            source: item.source === 'ai-suggested' ? ('ai-suggested' as const) : ('user' as const),
            status: 'active' as const,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          });
        }
        return result;
      })(),
    };
    const nextSession: SetupSession = {
      ...session,
      draft,
      commitPlan: { plan, createdAt: session.commitPlan.createdAt },
      revision: session.revision + 1,
      lastError: null,
      updatedAt: now,
    };
    await storage.writeSetupSession(nextSession);
    return { plan, session: nextSession, revision: nextSession.revision };
  });
}

function buildQuickSetupPlan(input: {
  raw: Record<string, unknown>;
  session: SetupSession;
  purpose: SetupPurpose;
  hardContracts: string[];
  openingWish: string;
}): SetupCommitPlan {
  const { raw, session, purpose, hardContracts, openingWish } = input;
  const now = nowIso();
  const rawCharacters = asArray(raw.characters);
  const characters: Character[] = [];
  for (const item of rawCharacters) {
    const normalized = normalizeQuickCharacter(item);
    if (normalized) characters.push(normalized);
  }
  const rawCanon = asArray(raw.latentCanon);
  const latentCanonItems: LatentCanonItem[] = rawCanon
    .map((item): LatentCanonItem | null => {
      if (!isRecord(item)) return null;
      const statement = asString(item.statement);
      if (!statement) return null;
      const scope = asCanonScope(item.scope);
      return {
        canonId: generateTimestampId('can'),
        scope,
        statement: statement.slice(0, 2000),
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'unknown',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: now,
        updatedAt: now,
      };
    })
    .filter((item): item is LatentCanonItem => item !== null)
    .slice(0, 8);

  const contracts = buildQuickContractItems(raw, hardContracts, now);
  const projectType = purpose === 'roleplay' ? 'roleplay' : 'novel';

  return {
    project: {
      title: truncate(asString(raw.title), 100) || '無題の作品',
      outputLength: session.projectSettings.outputLength,
      activePresetIds: session.projectSettings.activePresetIds,
      projectType,
    },
    coreConcept: truncate(asString(raw.coreConcept), 300),
    firstWishSuggestion: purpose === 'novel' ? truncate(openingWish, 300) : '',
    styleSample: '',
    world: {
      foundation: truncate(asString(isRecord(raw.world) ? raw.world.foundation : ''), 4000),
      initialSituation: truncate(
        asString(isRecord(raw.world) ? raw.world.initialSituation : ''),
        4000
      ),
    },
    characters,
    memories: [],
    storyState: {
      schemaVersion: 1,
      currentSituation: [],
      characterStates: [],
      importantEvents: [],
      openThreads: [],
      authorUndecided: [],
      clock: { day: 1 },
      processedGenerationIds: [],
      updatedAt: now,
    },
    customSystemPrompt: '',
    scenarioSeeds:
      purpose === 'roleplay'
        ? asArray(raw.scenarioSeeds)
            .map(asString)
            .filter(Boolean)
            .slice(0, 10)
        : [],
    ...(contracts.length > 0 ? { creativeContract: contracts } : {}),
    ...(latentCanonItems.length > 0 ? { latentCanonItems } : {}),
    latentSeedStatus: latentCanonItems.length > 0 ? 'ok' : 'failed',
  };
}

function buildQuickContractItems(
  raw: Record<string, unknown>,
  hardContracts: string[],
  now: string
): CreativeContractItem[] {
  const result: CreativeContractItem[] = [];
  const seen = new Set<string>();
  // 作者明示のhardContractsを最優先で入れる。
  for (const text of hardContracts) {
    const comparable = normalizeComparableText(text);
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    result.push({
      contractId: generateTimestampId('ctr'),
      kind: 'promise',
      strength: 'hard',
      text: text.slice(0, 500),
      source: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const item of asArray(raw.contracts)) {
    if (!isRecord(item)) continue;
    const text = asString(item.text);
    if (!text || text.length > 500) continue;
    const comparable = normalizeComparableText(text);
    if (seen.has(comparable)) continue;
    const kind = item.kind === 'prohibition' || item.kind === 'preference' ? item.kind : 'promise';
    // NOTE: LLM抽出は ai-suggested（softのみ）。hard候補は確認カード通過後にsource userへ
    // 昇格して hard になる（confirmQuickContracts）。ここではsoftとして入れておく。
    const strength = kind === 'preference' ? 'soft' : 'soft';
    seen.add(comparable);
    result.push({
      contractId: generateTimestampId('ctr'),
      kind,
      strength,
      text,
      source: 'ai-suggested',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    if (result.length >= 8) break;
  }
  return result;
}

function buildQuickSetupDraft(
  raw: Record<string, unknown>,
  hardContracts: string[],
  session: SetupSession,
  now: string
): SetupDraft {
  const characters: SetupDraftCharacter[] = asArray(raw.characters)
    .map((item) => {
      if (!isRecord(item)) return null;
      const name = asString(item.name);
      const description = asString(item.description);
      if (!name && !description) return null;
      const role = item.role === 'protagonist' || item.role === 'deuteragonist' || item.role === 'supporting' ? item.role : 'supporting';
      return {
        id: generateTimestampId('char-draft'),
        role,
        name,
        label: name,
        description: description || name,
        ...(asString(item.speechStyle) ? { speechStyle: asString(item.speechStyle) } : {}),
        ...(asString(item.secrets) ? { secrets: asString(item.secrets) } : {}),
        ...(asString(item.greeting) ? { greeting: asString(item.greeting) } : {}),
        source: 'ai-suggested',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
    })
    .filter((item): item is SetupDraftCharacter => item !== null)
    .slice(0, 4);
  const quickContracts: QuickContractCandidate[] = [
    ...hardContracts.map((text) => ({
      id: generateTimestampId('qctr'),
      kind: 'promise' as const,
      strength: 'hard' as const,
      text: text.slice(0, 500),
      source: 'user' as const,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    })),
    ...asArray(raw.contracts)
      .map((item): QuickContractCandidate | null => {
        if (!isRecord(item)) return null;
        const text = asString(item.text);
        if (!text) return null;
        const kind = item.kind === 'prohibition' || item.kind === 'preference' ? item.kind : 'promise';
        return {
          id: generateTimestampId('qctr'),
          kind,
          strength: (kind === 'preference' ? 'soft' : 'hard') as 'hard' | 'soft',
          text: text.slice(0, 500),
          source: 'ai-suggested' as const,
          status: 'active' as const,
          createdAt: now,
          updatedAt: now,
        };
      })
      .filter((item): item is QuickContractCandidate => item !== null)
      .slice(0, 10),
  ];
  return {
    coreConcept: truncate(asString(raw.coreConcept), 300),
    confirmed: [],
    candidates: [],
    undecided: [],
    characters,
    relationshipSeeds: [],
    // クイック生成の world は { foundation, initialSituation }。詳細設定の草案は文字列
    // リストなので、2つのセクションを順に移して引き継ぐ。配列形式も旧データ互換で残す。
    world: (isRecord(raw.world)
      ? [raw.world.foundation, raw.world.initialSituation]
      : asArray(raw.world)
    )
      .map(asString)
      .filter(Boolean)
      .slice(0, 20),
    tone: [],
    ng: [],
    openingSeeds: asArray(raw.openingSeeds).map(asString).filter(Boolean).slice(0, 10),
    scenarioSeeds:
      normalizeSetupPurpose(session.purpose) === 'roleplay'
        ? asArray(raw.scenarioSeeds).map(asString).filter(Boolean).slice(0, 10)
        : [],
    quickContracts,
  };
}

function normalizeQuickCharacter(value: unknown): Character | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const description = asString(value.description);
  if (!name && !description) return null;
  const role =
    value.role === 'protagonist' || value.role === 'deuteragonist' || value.role === 'supporting'
      ? value.role
      : 'supporting';
  const character: Character = {
    characterId: generateTimestampId('char'),
    name,
    role,
    description: description || name,
    ...(asString(value.speechStyle) ? { speechStyle: asString(value.speechStyle) } : {}),
    ...(asString(value.secrets) ? { secrets: asString(value.secrets) } : {}),
    ...(asString(value.greeting) ? { greeting: asString(value.greeting) } : {}),
  };
  return character;
}

function asCanonScope(value: unknown): CanonScope {
  return value === 'world' ||
    value === 'character' ||
    value === 'relationship' ||
    value === 'history' ||
    value === 'plot' ||
    value === 'other'
    ? value
    : 'other';
}

function truncate(value: string, maxChars: number): string {
  const text = value.trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function createSetupCommitPlan(
  sessionId: string,
  _body?: { revision?: number }
): Promise<SetupCommitPlanResponse> {
  return withSessionLock(sessionId, async () => {
    const session = await requireActiveSession(sessionId);
    // NOTE: 相談ターンが草案を書かなくなったので、会話しただけでは作品化させない。
    // 会話ログから直接変換はできてしまうが、それでは利用者が中身を確認・修正する
    // 機会が無いまま作品ができる。草案の実体を通過条件にする。
    if (!hasSetupDraftContent(session)) {
      throw new SetupServiceError(
        SETUP_DRAFT_REQUIRED_MESSAGE,
        'setup_draft_empty',
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
      debugLabel: 'setup.commitPlan',
      systemInstructions,
      userPrompt,
      outputLength: COMMIT_OUTPUT_LENGTH,
      temperature: COMMIT_TEMPERATURE,
      maxOutputTokens: JSON_TASK_MAX_OUTPUT_TOKENS,
      reasoningEffort: COMMIT_REASONING_EFFORT,
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
    // NOTE: 相談ターンが草案を書かなくなったので、会話しただけでは作品化させない。
    // 会話ログから直接変換はできてしまうが、それでは利用者が中身を確認・修正する
    // 機会が無いまま作品ができる。草案の実体を通過条件にする。
    if (!hasSetupDraftContent(session)) {
      throw new SetupServiceError(
        SETUP_DRAFT_REQUIRED_MESSAGE,
        'setup_draft_empty',
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
    // NOTE: novel 用途では normalizeSetupCommitPlan が undefined にしている。
    ...(projectInput.defaultUserPersona
      ? { defaultUserPersona: projectInput.defaultUserPersona }
      : {}),
    // NOTE: クイックセットアップの契約・潜在設定（設計書 4.1）。commit時に再度
    // normalizeSetupCommitPlan を通って createProject へ渡る。
    ...(projectInput.initialCreativeContract
      ? { creativeContract: projectInput.initialCreativeContract.items }
      : {}),
    ...(projectInput.initialLatentCanon &&
    projectInput.initialLatentCanon.items.length > 0
      ? { latentCanonItems: projectInput.initialLatentCanon.items }
      : {}),
    ...(projectInput.initialLatentCanon?.latentSeedStatus === 'failed'
      ? { latentSeedStatus: 'failed' as const }
      : {}),
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
  return sessionMutex.acquire(sessionId);
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

async function generateWithSessionModel(
  session: SetupSession,
  request: {
    // NOTE: 開発版のプロンプトダンプ用ラベル。必須にして、呼び出しを増やしたときに
    // 「どの相談画面の指示文か分からないダンプ」が黙って混ざるのを防ぐ。
    debugLabel: string;
    systemInstructions: string;
    userPrompt: string;
    outputLength: number;
    temperature: number;
    // NOTE: 思考モデルは max_tokens を思考と本文で共有する。outputLength からの推定は
    // 思考ゼロ前提の値なので、相談経路はここで明示的に枠と熟考量を指定する。
    maxOutputTokens?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
    responseMimeType?: 'application/json';
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
