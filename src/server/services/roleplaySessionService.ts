// NOTE: ロールプレイ会話ランタイム（設計書 3.4〜3.6）。
//
// データ整合性原則:
//  - 保存済みセッションが正、ストリーミング中の暫定表示は保存成功まで未確定。
//  - 全変更操作は sessionId 単位の in-memory mutex + revision 検査を通す。
//  - contextSnapshot をセッション作成時に固定し、後日のキャラ編集で会話が変質しない。
//  - 要約は非同期で走らせ、応答レイテンシに乗せない。カーソル (summaryThroughMessageId)
//    と一致するときだけマージ保存する（stale ジョブは捨てる）。
//
// revision 遷移（設計書 3.4）:
//  - messages-stream: 開始時 R → user 保存で R+1 → character コミットで R+2
//  - regenerate-stream: 開始時 R → 保存前はそのまま R → コミットで R+1
//  - 派生更新（要約完了）: revision を進めない

import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import * as expressionService from './expressionService.js';
import { runOutsideDataDirWrite, withDataDirWrite } from './dataDirLock.js';
import {
  runNonStreaming,
  runStreaming,
  ModelClientError,
} from './modelGenerationService.js';
import {
  buildRoleplaySystemInstructions,
  buildRoleplayUserPrompt,
  ROLEPLAY_RECENT_MESSAGES,
  ROLEPLAY_RECENT_MESSAGES_MAX_CHARS,
  ROLEPLAY_SUMMARY_MAX_CHARS,
  ROLEPLAY_VARIABLE_PROMPT_MAX_CHARS,
  ROLEPLAY_WORLD_MAX_CHARS,
} from './roleplayPromptBuilder.js';
import {
  DEFAULT_ROLEPLAY_OUTPUT_CHARS,
  normalizeProjectType,
  ROLEPLAY_LIMITS,
} from '../types/index.js';
import type {
  AdapterGenerateResult,
  Character,
  FinishReason,
  RoleplayContextSnapshot,
  RoleplayMessage,
  RoleplaySession,
  RoleplaySessionStatus,
  RoleplaySessionSummary,
  RoleplaySessionView,
} from '../types/index.js';

// NOTE: 応答パラメータ。target は project.roleplayOutputChars で上書き可能。
// hard cap は max(600, target*2) で派生（設計書 3.3 の 600 を最小値として保つ）。
const ROLEPLAY_OUTPUT_HARD_MIN_CAP = 600;
const ROLEPLAY_TEMPERATURE = 0.8;
const ROLEPLAY_TIMEOUT_MS = 60_000;
const ROLEPLAY_SUMMARY_TIMEOUT_MS = 45_000;
const ROLEPLAY_SUMMARY_THRESHOLD = 40;

function resolveOutputCaps(projectOutputChars: number | undefined): {
  outputLength: number;
  hardCap: number;
} {
  const target =
    typeof projectOutputChars === 'number' && Number.isFinite(projectOutputChars)
      ? Math.max(
          ROLEPLAY_LIMITS.outputCharsMin,
          Math.min(ROLEPLAY_LIMITS.outputCharsMax, Math.round(projectOutputChars))
        )
      : DEFAULT_ROLEPLAY_OUTPUT_CHARS;
  return {
    outputLength: target,
    hardCap: Math.max(ROLEPLAY_OUTPUT_HARD_MIN_CAP, target * 2),
  };
}

// NOTE: sessionId 単位の変更操作用 mutex。setupSessionService と同型。
const sessionMutexes = new Map<string, Promise<void>>();
// NOTE: 応答生成の in-flight フラグ。同一セッションへの二重送信を早期弾き。
// プロセス停止で消えるが、保存済み末尾から regenerate できるため復旧可能。
const generationInFlight = new Set<string>();
// NOTE: 要約ジョブの二重発火抑止。派生データのため保持しなくても正しさに影響しない。
const summaryInFlight = new Set<string>();

export class RoleplayServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
    public readonly revision?: number
  ) {
    super(message);
    this.name = 'RoleplayServiceError';
  }
}

// ===== ヘルパー: mutex =====

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

// ===== 検証 =====

function assertRoleplayProjectType(projectType: string | undefined): void {
  if (normalizeProjectType(projectType) !== 'roleplay') {
    throw new RoleplayServiceError(
      'このプロジェクトはロールプレイ型ではありません。',
      'project_type_mismatch',
      false,
      409
    );
  }
}

async function loadRoleplaySessionOrThrow(
  projectId: string,
  sessionId: string
): Promise<RoleplaySession> {
  let session: RoleplaySession | null;
  try {
    session = await storage.readRoleplaySession(projectId, sessionId);
  } catch {
    throw new RoleplayServiceError(
      'ロールプレイセッションIDが不正です。',
      'invalid_session_id',
      false,
      400
    );
  }
  if (!session) {
    throw new RoleplayServiceError(
      'ロールプレイセッションが見つかりません。',
      'session_not_found',
      false,
      404
    );
  }
  if (session.projectId !== projectId) {
    throw new RoleplayServiceError(
      'セッションのプロジェクトIDが URL と一致しません。',
      'session_not_found',
      false,
      404
    );
  }
  return session;
}

function assertRevision(session: RoleplaySession, revision: number): void {
  if (session.revision !== revision) {
    throw new RoleplayServiceError(
      'ロールプレイの状態が更新されています。最新を取得してから操作してください。',
      'revision_conflict',
      false,
      409,
      session.revision
    );
  }
}

function assertValidRevision(revision: unknown): asserts revision is number {
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new RoleplayServiceError(
      'リクエストの形式が不正です。',
      'invalid_request',
      false,
      400
    );
  }
}

function assertActiveSession(session: RoleplaySession): void {
  if (session.status !== 'active') {
    throw new RoleplayServiceError(
      'このセッションはアーカイブ済みです。',
      'session_archived',
      false,
      409,
      session.revision
    );
  }
}

// ===== View 変換 =====

export function toRoleplaySessionView(session: RoleplaySession): RoleplaySessionView {
  const { contextSnapshot, ...rest } = session;
  return {
    ...rest,
    characterName: contextSnapshot.character.name ?? '',
  };
}

function toRoleplaySessionSummary(session: RoleplaySession): RoleplaySessionSummary {
  const lastMessage = session.messages[session.messages.length - 1];
  const excerpt = (lastMessage?.content ?? '').replace(/\s+/g, ' ').trim();
  return {
    sessionId: session.sessionId,
    characterId: session.characterId,
    characterName: session.contextSnapshot.character.name ?? '',
    scenario: session.scenario,
    status: session.status,
    messageCount: session.messages.length,
    lastExcerpt: excerpt.length > 90 ? `${excerpt.slice(0, 90)}...` : excerpt,
    revision: session.revision,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

// ===== 一覧・取得 =====

export async function listRoleplaySessions(
  projectId: string
): Promise<RoleplaySessionSummary[]> {
  const ids = await storage.listRoleplaySessionIds(projectId);
  const sessions = await Promise.all(
    ids.map((id) => storage.readRoleplaySession(projectId, id).catch(() => null))
  );
  return sessions
    .filter((s): s is RoleplaySession => s !== null && s.status === 'active')
    .map(toRoleplaySessionSummary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getRoleplaySession(
  projectId: string,
  sessionId: string
): Promise<RoleplaySessionView> {
  const session = await loadRoleplaySessionOrThrow(projectId, sessionId);
  return toRoleplaySessionView(session);
}

// ===== contextSnapshot 構築 =====

function buildWorldDigest(worldText: string): string {
  const trimmed = (worldText ?? '').trim();
  if (trimmed.length <= ROLEPLAY_WORLD_MAX_CHARS) return trimmed;
  // NOTE: 段落境界で切ろうと試みる。無理なら最大文字数で切る。
  const cutoff = trimmed.slice(0, ROLEPLAY_WORLD_MAX_CHARS);
  const lastNewline = cutoff.lastIndexOf('\n');
  if (lastNewline > ROLEPLAY_WORLD_MAX_CHARS * 0.6) return cutoff.slice(0, lastNewline);
  return cutoff;
}

function buildContextSnapshot(input: {
  character: Character;
  otherCharacters: Character[];
  worldText: string;
  customSystemPrompt: string;
}): RoleplayContextSnapshot {
  return {
    character: { ...input.character },
    otherCharacters: input.otherCharacters.map((c) => ({
      characterId: c.characterId,
      name: c.name,
      description: c.description,
    })),
    worldDigest: buildWorldDigest(input.worldText),
    customSystemPrompt: input.customSystemPrompt ?? '',
    capturedAt: nowIso(),
  };
}

// ===== 作成 =====

export interface CreateRoleplaySessionInput {
  projectId: string;
  characterId: string;
  scenario?: string;
}

export async function createRoleplaySession(
  input: CreateRoleplaySessionInput
): Promise<RoleplaySessionView> {
  return withDataDirWrite(async () => {
    const project = await storage.readProject(input.projectId);
    if (!project) {
      throw new RoleplayServiceError(
        'プロジェクトが見つかりません。',
        'project_not_found',
        false,
        404
      );
    }
    assertRoleplayProjectType(project.projectType);

    const characters = await storage.readCharacters(input.projectId);
    const character = characters.find((c) => c.characterId === input.characterId);
    if (!character) {
      throw new RoleplayServiceError(
        'キャラクターが見つかりません。',
        'character_not_found',
        false,
        404
      );
    }

    const scenario = normalizeScenario(input.scenario);
    const worldText = await storage.readWorld(input.projectId);
    const presets = await storage.readPresets(input.projectId);

    const snapshot = buildContextSnapshot({
      character,
      otherCharacters: characters.filter((c) => c.characterId !== input.characterId),
      worldText,
      customSystemPrompt: presets?.customSystemPrompt ?? '',
    });

    const now = nowIso();
    const sessionId = generateTimestampId('rp');
    // NOTE: greeting があれば LLM を呼ばずに最初のキャラメッセージとして入れる
    //（会話開始の体感速度と一貫性のため）。
    const greeting = character.greeting?.trim();
    const messages: RoleplayMessage[] = greeting
      ? [
          {
            messageId: generateTimestampId('rm'),
            role: 'character',
            content: greeting,
            createdAt: now,
          },
        ]
      : [];

    const session: RoleplaySession = {
      schemaVersion: 1,
      sessionId,
      projectId: input.projectId,
      characterId: input.characterId,
      scenario: scenario || undefined,
      contextSnapshot: snapshot,
      status: 'active',
      messages,
      revision: 1,
      model: {
        provider: project.activeModelProvider,
        modelName: project.activeModelName,
      },
      createdAt: now,
      updatedAt: now,
    };

    await storage.writeRoleplaySession(session);
    return toRoleplaySessionView(session);
  });
}

function normalizeScenario(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (!text) return '';
  return text.length > ROLEPLAY_LIMITS.scenarioChars
    ? text.slice(0, ROLEPLAY_LIMITS.scenarioChars)
    : text;
}

// ===== アーカイブ =====

export async function archiveRoleplaySession(
  projectId: string,
  sessionId: string,
  revision: number
): Promise<RoleplaySessionView> {
  return withSessionLock(sessionId, async () => {
    const session = await loadRoleplaySessionOrThrow(projectId, sessionId);
    assertValidRevision(revision);
    assertRevision(session, revision);
    if (generationInFlight.has(sessionId)) {
      throw new RoleplayServiceError(
        '応答生成中はアーカイブできません。',
        'generation_in_progress',
        true,
        409,
        session.revision
      );
    }
    const next: RoleplaySession = {
      ...session,
      status: 'archived',
      revision: session.revision + 1,
      updatedAt: nowIso(),
    };
    await withDataDirWrite(() => storage.writeRoleplaySession(next));
    return toRoleplaySessionView(next);
  });
}

// ===== 送信・再生成のストリーミング =====

export type RoleplayStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done'; session: RoleplaySessionView }
  | {
      type: 'error';
      error: {
        error: string;
        code: string;
        retryable: boolean;
        revision?: number;
      };
    };

export interface SendRoleplayMessageInput {
  projectId: string;
  sessionId: string;
  message: string;
  revision: number;
  abortSignal?: AbortSignal;
}

export async function* sendRoleplayMessage(
  input: SendRoleplayMessageInput
): AsyncGenerator<RoleplayStreamEvent> {
  yield* runTurn({
    projectId: input.projectId,
    sessionId: input.sessionId,
    revision: input.revision,
    abortSignal: input.abortSignal,
    kind: 'send',
    userMessage: input.message,
  });
}

export interface RegenerateRoleplayInput {
  projectId: string;
  sessionId: string;
  revision: number;
  abortSignal?: AbortSignal;
}

export async function* regenerateRoleplay(
  input: RegenerateRoleplayInput
): AsyncGenerator<RoleplayStreamEvent> {
  yield* runTurn({
    projectId: input.projectId,
    sessionId: input.sessionId,
    revision: input.revision,
    abortSignal: input.abortSignal,
    kind: 'regenerate',
  });
}

interface RunTurnInput {
  projectId: string;
  sessionId: string;
  revision: number;
  abortSignal?: AbortSignal;
  kind: 'send' | 'regenerate';
  userMessage?: string;
}

// NOTE: 4段階構成:
//  Phase 1 (mutex 内・短時間): 入力/revision 検査、user 保存、in-flight フラグ set
//  Phase 2 (mutex 外): 要約が必要ならここで実施（LLM I/O を mutex に持ち込まない）
//  Phase 3 (mutex 外): project 最新設定・NG読込・プロンプト構築・ストリーム生成
//  Phase 4 (mutex 再取得・短時間): commitTurn で最終保存
//
// generationInFlight は Phase 1 の最後に立て、Phase 2〜4 の全経路（例外・yield 後 return）
// を try/finally で確実に解放する（review §5.1）。
async function* runTurn(input: RunTurnInput): AsyncGenerator<RoleplayStreamEvent> {
  const ticket = await beginTurn(input); // Phase 1（throw 時は in-flight 未設定なので解放不要）
  if (!ticket) return;

  const {
    workingSession: postUserSession,
    provider,
    modelName,
    expectedRevisionForCommit,
    previousCharacterMessageId,
  } = ticket;

  try {
    // Phase 2: 要約（必要な場合のみ）。mutex 外・in-flight 保持中に実施。
    let effectiveSession: RoleplaySession;
    try {
      effectiveSession = await runSummaryIfNeeded({
        session: postUserSession,
        excludeCharacterMessageId: previousCharacterMessageId,
      });
    } catch (err) {
      if (err instanceof RoleplayServiceError) {
        yield {
          type: 'error',
          error: {
            error: err.message,
            code: err.code,
            retryable: err.retryable,
            revision: err.revision,
          },
        };
        return;
      }
      throw err;
    }

    // Phase 3: 最新の project 設定と NG を読み、プロンプトを組み立てる。
    const project = await storage.readProject(input.projectId);
    const caps = resolveOutputCaps(project?.roleplayOutputChars);
    const bannedExpressions = await expressionService
      .resolveBannedExpressions(input.projectId)
      .catch((err) => {
        console.warn('Roleplay: failed to resolve banned expressions', {
          projectId: input.projectId,
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        return [] as string[];
      });

    const promptMessages = selectPromptMessagesForGeneration(effectiveSession, {
      excludeCharacterMessageId: previousCharacterMessageId,
    });
    const prompt = {
      systemInstructions: buildRoleplaySystemInstructions({
        snapshot: effectiveSession.contextSnapshot,
        outputLength: caps.outputLength,
      }),
      userPrompt: buildRoleplayUserPrompt({
        snapshot: effectiveSession.contextSnapshot,
        scenario: effectiveSession.scenario,
        conversationSummary: effectiveSession.conversationSummary,
        recentMessages: promptMessages,
        bannedExpressions,
      }),
    };

    const abortController = new AbortController();
    const forward = () => abortController.abort();
    input.abortSignal?.addEventListener('abort', forward);

    let aggregate = '';
    let finishReason: FinishReason = 'stop';
    let debugInfo: string | undefined;
    let hardCapReached = false;

    try {
      for await (const event of runStreaming(provider, {
        systemInstructions: prompt.systemInstructions,
        userPrompt: prompt.userPrompt,
        outputLength: caps.outputLength,
        temperature: ROLEPLAY_TEMPERATURE,
        timeoutMs: ROLEPLAY_TIMEOUT_MS,
        modelName,
        abortSignal: abortController.signal,
      })) {
        if (input.abortSignal?.aborted) {
          abortController.abort();
          break;
        }
        if (event.type === 'chunk') {
          // NOTE: ハード上限に達したら upstream を abort して打ち切る（設計書 3.3 末尾）。
          // 打ち切り前までの範囲は正常保存する。
          const remaining = caps.hardCap - aggregate.length;
          if (remaining <= 0) {
            hardCapReached = true;
            abortController.abort();
            break;
          }
          const willOverflow = event.text.length > remaining;
          const clipped = willOverflow ? event.text.slice(0, remaining) : event.text;
          if (clipped) {
            aggregate += clipped;
            yield { type: 'chunk', text: clipped };
          }
          // NOTE: aggregate が上限に達した時点で正常打ち切り扱いにする（review §5.2）。
          // 等号境界（event.text.length === remaining）で hardCapReached を落とすと、
          // 直後の done が finishReason=error/timeout/content_filter でも
          // 「本文を破棄してエラー」になる。ここで先に abort させれば、その先の
          // finishReason 判定は素通りする。
          if (willOverflow || aggregate.length >= caps.hardCap) {
            hardCapReached = true;
            abortController.abort();
            break;
          }
        } else {
          finishReason = event.finishReason;
          debugInfo = event.debugInfo;
        }
      }
    } catch (err) {
      if (err instanceof ModelClientError) {
        yield {
          type: 'error',
          error: {
            error: err.message,
            code: err.code,
            retryable: err.retryable,
            revision: expectedRevisionForCommit,
          },
        };
        return;
      }
      yield {
        type: 'error',
        error: {
          error: err instanceof Error ? err.message : '応答生成に失敗しました。',
          code: 'roleplay_failed',
          retryable: true,
          revision: expectedRevisionForCommit,
        },
      };
      return;
    } finally {
      input.abortSignal?.removeEventListener('abort', forward);
    }

    // NOTE: ハード上限による打ち切りは正常終了扱い（保存する）。
    if (!hardCapReached) {
      if (input.abortSignal?.aborted) {
        yield {
          type: 'error',
          error: {
            error: '応答生成が中断されました。',
            code: 'aborted',
            retryable: false,
            revision: expectedRevisionForCommit,
          },
        };
        return;
      }
      if (finishReason === 'error' || finishReason === 'timeout') {
        yield {
          type: 'error',
          error: {
            error: mapFinishReasonError(finishReason, debugInfo),
            code: finishReason,
            retryable: true,
            revision: expectedRevisionForCommit,
          },
        };
        return;
      }
      if (finishReason === 'content_filter') {
        yield {
          type: 'error',
          error: {
            error: '安全フィルタで応答がブロックされました。',
            code: 'content_filter',
            retryable: false,
            revision: expectedRevisionForCommit,
          },
        };
        return;
      }
    }

    const finalText = aggregate.trim();
    if (!finalText) {
      yield {
        type: 'error',
        error: {
          error: 'モデルからの応答が空でした。',
          code: 'empty_response',
          retryable: true,
          revision: expectedRevisionForCommit,
        },
      };
      return;
    }

    // Phase 4: commitTurn で mutex 内 revision 再検査 + 保存。
    try {
      const committed = await commitTurn({
        projectId: input.projectId,
        sessionId: input.sessionId,
        workingSession: effectiveSession,
        expectedRevisionForCommit,
        characterText: finalText,
        kind: input.kind,
        previousCharacterMessageId,
      });
      yield { type: 'done', session: toRoleplaySessionView(committed) };
      // NOTE: 応答保存後に非同期要約を走らせる（設計書 3.5）。エラーは無視する。
      startBackgroundSummary(input.projectId, input.sessionId);
    } catch (err) {
      if (err instanceof RoleplayServiceError) {
        yield {
          type: 'error',
          error: {
            error: err.message,
            code: err.code,
            retryable: err.retryable,
            revision: err.revision,
          },
        };
        return;
      }
      yield {
        type: 'error',
        error: {
          error: err instanceof Error ? err.message : '応答保存に失敗しました。',
          code: 'roleplay_failed',
          retryable: true,
          revision: expectedRevisionForCommit,
        },
      };
    }
  } finally {
    // NOTE: Phase 2〜4 のどの経路でも in-flight を解放する（review §5.1）。
    generationInFlight.delete(input.sessionId);
  }
}

// NOTE: Phase 1 チケット。summary / project / NG / prompt は runTurn 側で mutex 外に構築する。
interface TurnTicket {
  workingSession: RoleplaySession;
  provider: string;
  modelName: string;
  expectedRevisionForCommit: number;
  previousCharacterMessageId: string | null;
}

// NOTE: mutex 内で行うのは validate → user 保存 → in-flight set まで。
// generationInFlight.add は「これ以降 throw しない」位置に置く（最終行の直前）。
// user 保存が失敗した場合はフラグ未設定なので後片付け不要。
async function beginTurn(input: RunTurnInput): Promise<TurnTicket | null> {
  return await withSessionLock(input.sessionId, async () => {
    const session = await loadRoleplaySessionOrThrow(input.projectId, input.sessionId);
    assertValidRevision(input.revision);
    assertRevision(session, input.revision);
    assertActiveSession(session);
    if (generationInFlight.has(input.sessionId)) {
      throw new RoleplayServiceError(
        'このセッションは既に応答生成中です。',
        'generation_in_progress',
        true,
        409,
        session.revision
      );
    }

    let workingSession = session;
    let expectedRevisionForCommit: number;
    let previousCharacterMessageId: string | null = null;

    if (input.kind === 'send') {
      const text = validateUserMessage(input.userMessage);
      // NOTE: 末尾が user の状態で send を受けたら、regenerate 誘導のため pending_response で
      // 拒否する（履歴二重化を防ぐ）。UI は 409 を見て regenerate へ導線を出す。
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === 'user') {
        throw new RoleplayServiceError(
          '直前の発言に応答が返っていません。「もう一度」で再試行してください。',
          'pending_response',
          false,
          409,
          session.revision
        );
      }
      const now = nowIso();
      const userMessage: RoleplayMessage = {
        messageId: generateTimestampId('rm'),
        role: 'user',
        content: text,
        createdAt: now,
      };
      workingSession = {
        ...session,
        messages: [...session.messages, userMessage],
        revision: session.revision + 1,
        updatedAt: now,
      };
      await withDataDirWrite(() => storage.writeRoleplaySession(workingSession));
      expectedRevisionForCommit = workingSession.revision;
    } else {
      // NOTE: regenerate: 末尾が character の場合は直前 user への再応答。
      // 末尾が user の場合は送信失敗・プロセス再起動からの再試行として、そのまま応答生成へ。
      const last = session.messages[session.messages.length - 1];
      if (!last) {
        throw new RoleplayServiceError(
          '再生成対象がありません。',
          'nothing_to_regenerate',
          false,
          400,
          session.revision
        );
      }
      if (last.role === 'character') {
        // NOTE: 直前が user でなければ再生成不可（初回 greeting など）。
        const previous = session.messages[session.messages.length - 2];
        if (!previous || previous.role !== 'user') {
          throw new RoleplayServiceError(
            'このメッセージは再生成できません（対応する発言がありません）。',
            'not_regeneratable',
            false,
            400,
            session.revision
          );
        }
        previousCharacterMessageId = last.messageId;
      }
      expectedRevisionForCommit = session.revision;
    }

    // NOTE: 以降 throw しない位置で in-flight を立てる。ここまで到達 = 何らかの成功状態。
    generationInFlight.add(input.sessionId);
    return {
      workingSession,
      provider: workingSession.model.provider,
      modelName: workingSession.model.modelName,
      expectedRevisionForCommit,
      previousCharacterMessageId,
    };
  });
}

function validateUserMessage(value: string | undefined): string {
  if (typeof value !== 'string') {
    throw new RoleplayServiceError(
      'メッセージを入力してください。',
      'invalid_message',
      false,
      400
    );
  }
  const text = value.trim();
  if (!text) {
    throw new RoleplayServiceError(
      'メッセージを入力してください。',
      'invalid_message',
      false,
      400
    );
  }
  if (text.length > 2000) {
    throw new RoleplayServiceError(
      'メッセージが長すぎます（2000字以内）。',
      'invalid_message',
      false,
      400
    );
  }
  return text;
}

async function commitTurn(input: {
  projectId: string;
  sessionId: string;
  workingSession: RoleplaySession;
  expectedRevisionForCommit: number;
  characterText: string;
  kind: 'send' | 'regenerate';
  previousCharacterMessageId: string | null;
}): Promise<RoleplaySession> {
  return await withSessionLock(input.sessionId, async () => {
    const latest = await loadRoleplaySessionOrThrow(input.projectId, input.sessionId);
    // NOTE: 生成中に別経路で状態が変わっていないことを保証する。
    if (latest.revision !== input.expectedRevisionForCommit) {
      throw new RoleplayServiceError(
        'ロールプレイの状態が更新されています。応答を保存できませんでした。',
        'revision_conflict',
        true,
        409,
        latest.revision
      );
    }
    if (latest.status !== 'active') {
      throw new RoleplayServiceError(
        'セッションがアーカイブされました。',
        'session_archived',
        false,
        409,
        latest.revision
      );
    }
    const now = nowIso();
    const characterMessage: RoleplayMessage = {
      messageId: generateTimestampId('rm'),
      role: 'character',
      content: input.characterText,
      createdAt: now,
    };
    let nextMessages: RoleplayMessage[];
    if (input.kind === 'regenerate' && input.previousCharacterMessageId) {
      nextMessages = latest.messages
        .filter((m) => m.messageId !== input.previousCharacterMessageId)
        .concat(characterMessage);
    } else {
      nextMessages = [...latest.messages, characterMessage];
    }
    const nextSession: RoleplaySession = {
      ...latest,
      messages: nextMessages,
      revision: latest.revision + 1,
      updatedAt: now,
    };
    await withDataDirWrite(() => storage.writeRoleplaySession(nextSession));
    return nextSession;
  });
}

function mapFinishReasonError(reason: FinishReason, debugInfo?: string): string {
  switch (reason) {
    case 'timeout':
      return '応答生成がタイムアウトしました。再試行してください。';
    case 'error':
      return `応答生成が失敗しました${debugInfo ? `（${debugInfo}）` : ''}。`;
    default:
      return '応答生成が失敗しました。';
  }
}

// ===== 要約カーソルとプロンプトメッセージ選択 =====

function messagesAfterCursor(
  session: RoleplaySession,
  excludeMessageId?: string | null
): RoleplayMessage[] {
  const cursor = session.summaryThroughMessageId;
  let cursorIndex = -1;
  if (cursor) {
    cursorIndex = session.messages.findIndex((m) => m.messageId === cursor);
  }
  return session.messages
    .slice(cursorIndex + 1)
    .filter((m) => !excludeMessageId || m.messageId !== excludeMessageId);
}

function selectPromptMessagesForGeneration(
  session: RoleplaySession,
  options: { excludeCharacterMessageId: string | null }
): RoleplayMessage[] {
  const afterCursor = messagesAfterCursor(session, options.excludeCharacterMessageId);
  // NOTE: 通常は afterCursor 全件を渡す。要約直後は最大 ROLEPLAY_RECENT_MESSAGES 件。
  return afterCursor.slice(-ROLEPLAY_SUMMARY_THRESHOLD);
}

// ===== 予算判定と同期要約 =====

// NOTE: performSummary の結果を「不要」「成功」「失敗」で区別する（review §追加設計不整合）。
// これまで null が両方を意味していたため、要約失敗が黙って握りつぶされていた。
type SummaryOutcome =
  | { kind: 'not_needed' } // afterCursor が既に閾値以下で fold 不要
  | { kind: 'no_fold_target' } // 20件以下だが文字数超過など、fold対象が組めない
  | { kind: 'llm_failed'; reason: string } // LLM error / timeout
  | { kind: 'empty_result' } // LLM が空応答
  | { kind: 'ok'; conversationSummary: string; summaryThroughMessageId: string };

interface BudgetJudgement {
  overCount: boolean;
  overChars: boolean;
  totalChars: number;
}

function judgeBudget(afterCursor: RoleplayMessage[]): BudgetJudgement {
  const totalChars = afterCursor.reduce((sum, m) => sum + m.content.length, 0);
  return {
    overCount: afterCursor.length > ROLEPLAY_SUMMARY_THRESHOLD,
    overChars: totalChars > ROLEPLAY_RECENT_MESSAGES_MAX_CHARS,
    totalChars,
  };
}

// NOTE: runTurn の Phase 2。mutex 外で呼ぶ。要約が不要なら session をそのまま返す。
// 予算超過で要約が必要な場合、失敗時は summary_failed を throw して呼び元で明示エラーへ。
// 成功時は summary/カーソル/summaryUpdatedAt だけをマージ保存し、revision は進めない。
async function runSummaryIfNeeded(input: {
  session: RoleplaySession;
  excludeCharacterMessageId: string | null;
}): Promise<RoleplaySession> {
  const { session } = input;
  const afterCursor = messagesAfterCursor(session, input.excludeCharacterMessageId);
  const judged = judgeBudget(afterCursor);

  if (!judged.overCount && !judged.overChars) {
    return session;
  }

  const outcome = await performSummary(session, afterCursor);
  if (outcome.kind === 'llm_failed' || outcome.kind === 'empty_result') {
    throw new RoleplayServiceError(
      '会話履歴の要約に失敗しました。時間をおいて再試行してください。',
      'summary_failed',
      true,
      503,
      session.revision
    );
  }
  if (outcome.kind === 'no_fold_target' || outcome.kind === 'not_needed') {
    // NOTE: 20件以下で fold 対象が無いのに予算超過ということは、個々のメッセージが
    // 極端に長い状態。要約でも縮められないので明示エラー（設計 3.5 の契約）。
    throw new RoleplayServiceError(
      '会話履歴が長すぎて要約できませんでした。長い発言を短くしてから再送信してください。',
      'summary_failed',
      false,
      503,
      session.revision
    );
  }

  // outcome.kind === 'ok'
  const merged = await mergeSummaryIfCursorUnchanged({
    projectId: session.projectId,
    sessionId: session.sessionId,
    expectedCursor: session.summaryThroughMessageId,
    conversationSummary: outcome.conversationSummary,
    summaryThroughMessageId: outcome.summaryThroughMessageId,
  });
  if (!merged) {
    // 他経路が要約を進めた場合。最新セッションを取得しなおして再判定。
    const latest = await storage.readRoleplaySession(session.projectId, session.sessionId);
    if (!latest) throw new RoleplayServiceError(
      'セッションを読み込めませんでした。',
      'session_not_found',
      false,
      404,
      session.revision
    );
    const stillNeeded = judgeBudget(messagesAfterCursor(latest, input.excludeCharacterMessageId));
    if (stillNeeded.overCount || stillNeeded.overChars) {
      // 別経路の要約でも予算に収まらない → 明示エラー
      throw new RoleplayServiceError(
        '会話履歴が長すぎて要約できませんでした。時間をおいて再試行してください。',
        'summary_failed',
        true,
        latest.revision
      );
    }
    return latest;
  }

  // 再判定: マージ後 latest でまだ予算内か（他タブが新規発言を積んでいる可能性）
  const revalidate = judgeBudget(messagesAfterCursor(merged, input.excludeCharacterMessageId));
  if (revalidate.overCount || revalidate.overChars) {
    throw new RoleplayServiceError(
      '会話履歴が長すぎて要約できませんでした。時間をおいて再試行してください。',
      'summary_failed',
      true,
      503,
      merged.revision
    );
  }
  return merged;
}

// NOTE: mutex 内でカーソル一致を確認してからマージ保存する。stale なら null を返す。
// revision と updatedAt は進めず、派生フィールドだけ書く（設計 3.5）。
async function mergeSummaryIfCursorUnchanged(input: {
  projectId: string;
  sessionId: string;
  expectedCursor: string | undefined;
  conversationSummary: string;
  summaryThroughMessageId: string;
}): Promise<RoleplaySession | null> {
  return await withSessionLock(input.sessionId, async () => {
    const latest = await storage.readRoleplaySession(input.projectId, input.sessionId);
    if (!latest) return null;
    if (latest.summaryThroughMessageId !== input.expectedCursor) return null;
    const next: RoleplaySession = {
      ...latest,
      conversationSummary: input.conversationSummary,
      summaryThroughMessageId: input.summaryThroughMessageId,
      summaryUpdatedAt: nowIso(),
    };
    await withDataDirWrite(() => storage.writeRoleplaySession(next));
    return next;
  });
}

// NOTE: 実際の要約生成。afterCursor の古い方を conversationSummary へ畳む。
// 直近を残す件数は「20 件かつ 16000 字以内」を両方満たすラインで動的に決める。
// 20件以下でも文字数が超過する場合は no_fold_target（呼び元で summary_failed）。
async function performSummary(
  session: RoleplaySession,
  afterCursor: RoleplayMessage[]
): Promise<SummaryOutcome> {
  const totalChars = afterCursor.reduce((sum, m) => sum + m.content.length, 0);
  if (
    afterCursor.length <= ROLEPLAY_RECENT_MESSAGES &&
    totalChars <= ROLEPLAY_RECENT_MESSAGES_MAX_CHARS
  ) {
    return { kind: 'not_needed' };
  }

  // NOTE: 「新しい方から詰めて、20件かつ 16000 字を両方超えないラインまで残す」を
  // 動的に決める。残せる件数が 0 になる（つまり最新1件でも上限超え）場合は
  // no_fold_target で呼び元へ返し、明示エラーで通知する。
  const keepCount = decideKeepCount(afterCursor);
  if (keepCount <= 0) return { kind: 'no_fold_target' };
  const foldTarget = afterCursor.slice(0, afterCursor.length - keepCount);
  const lastFolded = foldTarget[foldTarget.length - 1];
  if (!lastFolded) return { kind: 'no_fold_target' };

  const characterName = session.contextSnapshot.character.name ?? 'キャラクター';
  const existingSummary = session.conversationSummary?.trim() ?? '';
  const foldedText = foldTarget
    .map((m) => `${m.role === 'user' ? 'ユーザー' : characterName}: ${m.content}`)
    .join('\n');

  const systemInstructions = [
    'あなたはロールプレイ会話の要約係です。',
    '与えられた会話履歴と既存の要約を統合し、続きの会話に必要な情報だけを残してください。',
    '関係の変化、呼び方の変化、交わした約束、明かされた事実を優先的に残してください。',
    '個々のセリフを引用せず、要点だけを平文で書いてください。',
    `出力は${ROLEPLAY_SUMMARY_MAX_CHARS}字以内にしてください。`,
  ].join('\n');

  const userPrompt = [
    existingSummary ? `【既存の要約】\n${existingSummary}` : '',
    `【追加する会話】\n${foldedText}`,
    '【出力】',
    '統合後の要約だけを出力してください。',
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  let result;
  try {
    result = await runNonStreaming(session.model.provider, {
      systemInstructions,
      userPrompt,
      outputLength: 1200,
      temperature: 0.25,
      timeoutMs: ROLEPLAY_SUMMARY_TIMEOUT_MS,
      modelName: session.model.modelName,
    });
  } catch (err) {
    return { kind: 'llm_failed', reason: err instanceof Error ? err.message : String(err) };
  }
  if (result.finishReason === 'error' || result.finishReason === 'timeout') {
    return { kind: 'llm_failed', reason: result.finishReason };
  }
  const summaryText = result.text.trim().slice(0, ROLEPLAY_SUMMARY_MAX_CHARS);
  if (!summaryText) return { kind: 'empty_result' };
  return {
    kind: 'ok',
    conversationSummary: summaryText,
    summaryThroughMessageId: lastFolded.messageId,
  };
}

// NOTE: 「新しい方から詰め、20件かつ 16000 字を両方超えない最大数」を返す。
// 最新1件でも 16000 字を超える病的ケースでは 0 を返す（no_fold_target）。
function decideKeepCount(afterCursor: RoleplayMessage[]): number {
  let count = 0;
  let chars = 0;
  for (let i = afterCursor.length - 1; i >= 0; i--) {
    const next = chars + afterCursor[i].content.length;
    if (count >= ROLEPLAY_RECENT_MESSAGES) break;
    if (next > ROLEPLAY_RECENT_MESSAGES_MAX_CHARS) break;
    chars = next;
    count += 1;
  }
  return count;
}

// ===== 非同期要約 =====

function startBackgroundSummary(projectId: string, sessionId: string): void {
  if (summaryInFlight.has(sessionId)) return;
  summaryInFlight.add(sessionId);
  runOutsideDataDirWrite(() => {
    void (async () => {
      try {
        await runBackgroundSummary(projectId, sessionId);
      } catch (err) {
        console.warn('Roleplay summary failed', {
          projectId,
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        summaryInFlight.delete(sessionId);
      }
    })();
  });
}

async function runBackgroundSummary(projectId: string, sessionId: string): Promise<void> {
  // NOTE: スナップショット段階（mutex なし）。要約対象を確定する。
  const snapshot = await storage.readRoleplaySession(projectId, sessionId);
  if (!snapshot) return;
  const afterCursor = messagesAfterCursor(snapshot);
  if (afterCursor.length <= ROLEPLAY_SUMMARY_THRESHOLD) return;

  // NOTE: 生成中は mutex を持たない（他の変更をブロックしないため）。非同期要約は
  // 失敗しても正しさに影響しないため、'ok' 以外はすべて warn ログを残して終了。
  const outcome = await performSummary(snapshot, afterCursor);
  if (outcome.kind !== 'ok') {
    if (outcome.kind === 'llm_failed' || outcome.kind === 'empty_result') {
      console.warn('Background roleplay summary skipped', {
        projectId,
        sessionId,
        outcome: outcome.kind,
      });
    }
    return;
  }

  // NOTE: マージ段階。カーソルが動いていない場合だけ保存する（stale ジョブ検知）。
  const merged = await mergeSummaryIfCursorUnchanged({
    projectId,
    sessionId,
    expectedCursor: snapshot.summaryThroughMessageId,
    conversationSummary: outcome.conversationSummary,
    summaryThroughMessageId: outcome.summaryThroughMessageId,
  });
  if (!merged) {
    // 別経路で要約が進んだ、あるいはセッションが消えた／アーカイブされた場合。捨てる。
    return;
  }
}

// ===== テスト用の内部フラグリセット =====

export function __resetInFlightForTesting(): void {
  generationInFlight.clear();
  summaryInFlight.clear();
  sessionMutexes.clear();
}
