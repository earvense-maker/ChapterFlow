// 妄想増幅器コアサービス（設計書 docs/design/妄想増幅器_設計書.md）
//
// NOTE: 責務は InteractionEvent の冪等追記、AmplifierTurn の保存、ノート（notebook）の
// 読み書き、アンカー検証、小説 advance lease の管理。選択肢の LLM 生成は
// amplifierChoiceService、メモ解釈は desireInterpreterService が担当し、ここでは
// LLM を呼ばない（プロジェクトロックを保持したまま LLM を待たない原則・設計書 12.1）。

import { createHash } from 'node:crypto';
import { KeyedMutex } from '../utils/keyedMutex.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import { withProjectWriteLock } from './projectLock.js';
import { buildStayInstruction } from './amplifierPromptBuilder.js';
import * as globalService from './amplifierGlobalService.js';
import type {
  AmplifierAnchor,
  AmplifierDirectionInput,
  AmplifierInteractionEvent,
  AmplifierProjectNotebook,
  AmplifierStateQuery,
  AmplifierStateResponse,
  AmplifierTurn,
  ExperienceMode,
  PreferenceAppliesTo,
  PreferenceCorrection,
  PreferenceMemo,
  PendingNovelAdvance,
  Project,
} from '../types/index.js';
import { normalizeExperienceMode } from '../types/index.js';

const storage = localProjectStorage();

export class AmplifierServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AmplifierServiceError';
  }
}

// NOTE: アンカー本文ハッシュ（設計書 8.2）。実効本文をUTF-8文字列として、改行だけLFへ
// 正規化し、trimや空白圧縮をせずSHA-256で計算する。選択肢prepare、commit、押下検証で
// 同じ純関数を使う。
export function computeAnchorTextHash(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

export function normalizeExperienceModeValue(value: unknown): ExperienceMode {
  return normalizeExperienceMode(value);
}

// NOTE: contextKey はクライアント入力から採用しない（設計書 8.1）。
// 小説: novel:main / ロールプレイ: roleplay:<sessionId>
export function buildContextKey(mode: 'novel' | 'roleplay', sessionId?: string): string {
  if (mode === 'roleplay') {
    if (!sessionId) {
      throw new AmplifierServiceError('sessionId が必要です。', 'invalid_anchor', false, 400);
    }
    return `roleplay:${sessionId}`;
  }
  return 'novel:main';
}

export function isRoleplayContextKey(contextKey: string): boolean {
  return contextKey.startsWith('roleplay:');
}

// --- アンカー検証 ---

export function normalizeAnchor(value: unknown): AmplifierAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'novel') {
    if (typeof raw.generationId !== 'string' || !raw.generationId) {
      throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
    }
    const revision = raw.textRevisionNumber;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
    }
    return { kind: 'novel', generationId: raw.generationId, textRevisionNumber: revision };
  }
  if (raw.kind === 'roleplay') {
    if (
      typeof raw.sessionId !== 'string' ||
      !raw.sessionId ||
      typeof raw.messageId !== 'string' ||
      !raw.messageId
    ) {
      throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
    }
    const revision = raw.contentRevision;
    if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
      throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
    }
    return {
      kind: 'roleplay',
      sessionId: raw.sessionId,
      messageId: raw.messageId,
      contentRevision: revision,
    };
  }
  throw new AmplifierServiceError('アンカーが不正です。', 'invalid_anchor', false, 400);
}

// NOTE: 保存済み実効本文の解決。改訂番号の欠損は0と解釈する（設計書 8.2）。
// 戻り値の ok が false なら「本文が現存しない」＝アンカー自体が無効。
export async function resolveEffectiveAnchorText(
  projectId: string,
  anchor: AmplifierAnchor
): Promise<{ ok: boolean; text: string; revisionNumber: number; hash: string }> {
  if (anchor.kind === 'novel') {
    const record = await storage.findGenerationRecord(projectId, anchor.generationId);
    if (!record) {
      return { ok: false, text: '', revisionNumber: 0, hash: '' };
    }
    const revisionNumber = record.textRevisionNumber ?? 0;
    const text = record.responseText ?? '';
    return {
      ok: true,
      text,
      revisionNumber,
      hash: computeAnchorTextHash(text),
    };
  }
  const session = await storage.readRoleplaySession(projectId, anchor.sessionId);
  if (!session) {
    return { ok: false, text: '', revisionNumber: 0, hash: '' };
  }
  const message = session.messages.find((candidate) => candidate.messageId === anchor.messageId);
  if (!message) {
    return { ok: false, text: '', revisionNumber: 0, hash: '' };
  }
  const revisionNumber = message.contentRevision ?? 0;
  return {
    ok: true,
    text: message.content ?? '',
    revisionNumber,
    hash: computeAnchorTextHash(message.content ?? ''),
  };
}

// NOTE: 選択肢の押下検証（設計書 8.2）。アンカーIDだけでなく、保存済み実効本文の
// 改訂番号とハッシュを検証する。本文編集・別案への移動・再生成・別セッションへの切替後に
// 古いカードが押された場合は false を返し、呼び出し側は 409 amplifier_turn_stale を返す。
// turnAnchorHash は選択肢作成時に保存した実効本文ハッシュ。
export function verifyAnchorAgainstCurrent(
  anchor: AmplifierAnchor,
  resolved: { ok: boolean; revisionNumber: number; text: string },
  turnAnchorHash: string
): boolean {
  if (!resolved.ok) return false;
  const expectedRevision =
    anchor.kind === 'novel' ? anchor.textRevisionNumber : anchor.contentRevision;
  if (expectedRevision !== resolved.revisionNumber) return false;
  return computeAnchorTextHash(resolved.text) === turnAnchorHash;
}

// --- ノート ---

export function createEmptyNotebook(learningEnabled: boolean): AmplifierProjectNotebook {
  const now = nowIso();
  return {
    schemaVersion: 1,
    projectMemos: [],
    currentMemos: {},
    corrections: [],
    projectBoundary: '',
    learningEnabled,
    foldedThroughSequence: 0,
    interpreter: { state: 'idle' },
    pendingAdvance: null,
    revision: 1,
    updatedAt: now,
  };
}

function normalizeNotebook(value: AmplifierProjectNotebook | null): AmplifierProjectNotebook {
  const now = nowIso();
  if (!value || typeof value !== 'object') {
    return createEmptyNotebook(true);
  }
  const raw = value as Partial<AmplifierProjectNotebook>;
  const memos = Array.isArray(raw.projectMemos) ? raw.projectMemos : [];
  const currentMemos: Record<string, PreferenceMemo[]> = {};
  if (raw.currentMemos && typeof raw.currentMemos === 'object') {
    for (const [key, list] of Object.entries(raw.currentMemos as Record<string, unknown>)) {
      if (Array.isArray(list)) currentMemos[key] = list as PreferenceMemo[];
    }
  }
  return {
    schemaVersion: 1,
    projectMemos: memos,
    currentMemos,
    corrections: Array.isArray(raw.corrections) ? raw.corrections : [],
    projectBoundary: typeof raw.projectBoundary === 'string' ? raw.projectBoundary : '',
    learningEnabled: typeof raw.learningEnabled === 'boolean' ? raw.learningEnabled : true,
    foldedThroughSequence:
      typeof raw.foldedThroughSequence === 'number' ? raw.foldedThroughSequence : 0,
    interpreter:
      raw.interpreter && typeof raw.interpreter === 'object'
        ? (raw.interpreter as AmplifierProjectNotebook['interpreter'])
        : { state: 'idle' },
    pendingAdvance:
      raw.pendingAdvance && typeof raw.pendingAdvance === 'object'
        ? (raw.pendingAdvance as PendingNovelAdvance)
        : null,
    revision: typeof raw.revision === 'number' && raw.revision >= 1 ? raw.revision : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

export async function readNotebook(projectId: string): Promise<AmplifierProjectNotebook> {
  const stored = await storage.readAmplifierNotebook(projectId);
  return normalizeNotebook(stored);
}

export async function writeNotebook(
  projectId: string,
  notebook: AmplifierProjectNotebook
): Promise<void> {
  await storage.writeAmplifierNotebook(projectId, notebook);
}

export async function ensureNotebookDir(projectId: string): Promise<AmplifierProjectNotebook> {
  const notebook = await readNotebook(projectId);
  await writeNotebook(projectId, notebook);
  return notebook;
}

// --- InteractionEvent（設計書 7 / 12.3） ---

// NOTE: 追記は withDataDirWrite と専用サービスロック（プロジェクト単位）を通す（設計書 9.4）。
const interactionMutex = new KeyedMutex();

export async function readInteractions(projectId: string): Promise<AmplifierInteractionEvent[]> {
  return storage.readAmplifierInteractions(projectId);
}

async function nextSequence(projectId: string): Promise<number> {
  const events = await storage.readAmplifierInteractions(projectId);
  let max = 0;
  for (const event of events) {
    if (typeof event.sequence === 'number' && event.sequence > max) max = event.sequence;
  }
  return max + 1;
}

// NOTE: clientEventId で同じ操作の再送を検出する（設計書 12.3）。既存イベントを返し、
// 二重記録しない。呼び出し側は project lock を保持していてよい（advance の冪等保存）。
export async function recordInteractionUnlocked(
  projectId: string,
  input: {
    clientEventId: string;
    mode: 'novel' | 'roleplay';
    type: AmplifierInteractionEvent['type'];
    anchor: AmplifierAnchor;
    turnId?: string;
    payload: AmplifierInteractionEvent['payload'];
    excludeFromGlobalLearning: boolean;
    contextKey: string;
  }
): Promise<{ event: AmplifierInteractionEvent; created: boolean }> {
  // NOTE: clientEventId の確認、sequence 採番、追記を同じ排他区間へ置く。異なる
  // ロールプレイ会話枠から同時に選ばれても、重複 sequence や二重イベントを作らない。
  return interactionMutex.runExclusive(projectId, async () => {
    const existing = await findEventByClientId(projectId, input.clientEventId);
    if (existing) {
      return { event: existing, created: false };
    }
    const sequence = await nextSequence(projectId);
    // NOTE: payload は API 境界で検証済みの判別共用体。型の相関が取れないため、
    // ここでのみ構成時のキャストで締める（保存されるのは検証済みの値のみ）。
    const event = {
      schemaVersion: 1 as const,
      eventId: generateTimestampId('amp-ev'),
      clientEventId: input.clientEventId,
      sequence,
      projectId,
      contextKey: input.contextKey,
      mode: input.mode,
      type: input.type,
      anchor: input.anchor,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      payload: input.payload,
      excludeFromGlobalLearning: input.excludeFromGlobalLearning,
      createdAt: nowIso(),
    } as AmplifierInteractionEvent;
    await storage.appendAmplifierInteraction(projectId, event);
    return { event, created: true };
  });
}

export async function findEventByClientId(
  projectId: string,
  clientEventId: string
): Promise<AmplifierInteractionEvent | null> {
  const events = await storage.readAmplifierInteractions(projectId);
  return events.find((event) => event.clientEventId === clientEventId) ?? null;
}

export async function findEventById(
  projectId: string,
  eventId: string
): Promise<AmplifierInteractionEvent | null> {
  const events = await storage.readAmplifierInteractions(projectId);
  return events.find((event) => event.eventId === eventId) ?? null;
}

// NOTE: イベントのグローバル学習除外を解決する（設計書 14.2）。作品の学習オフ、または
// ロールプレイ会話枠ごとの excludeFromGlobalLearning のどちらかが真なら除外する。
export async function resolveEventExcludeFromGlobalLearning(
  projectId: string,
  contextKey: string,
  notebook: AmplifierProjectNotebook
): Promise<boolean> {
  if (!notebook.learningEnabled) return true;
  if (contextKey.startsWith('roleplay:')) {
    const sessionId = contextKey.slice('roleplay:'.length);
    const session = await storage.readRoleplaySession(projectId, sessionId);
    return session?.excludeFromGlobalLearning === true;
  }
  return false;
}

// --- AmplifierTurn（設計書 8 / 12.2） ---

export function createEmptyTurn(
  projectId: string,
  contextKey: string,
  anchor: AmplifierAnchor,
  hash: string,
  excerpt: string,
  supersedesTurnId?: string
): AmplifierTurn {
  const now = nowIso();
  return {
    schemaVersion: 1,
    turnId: generateTimestampId('amp-turn'),
    projectId,
    contextKey,
    anchor,
    anchorTextHash: hash,
    anchorExcerpt: excerpt.slice(0, 200),
    status: 'choices_pending',
    choices: [],
    ...(supersedesTurnId ? { supersedesTurnId } : {}),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export async function readTurn(projectId: string, turnId: string): Promise<AmplifierTurn | null> {
  return storage.readAmplifierTurn(projectId, turnId);
}

// NOTE: 保存後のターンを返す。revision は保存時に +1 されるため、クライアントへ返す
// ターンは必ずこの戻り値を使うこと（返り値を使わずに呼び出し元のオブジェクトを返すと、
// 押下検証の turnRevision が古い値のままになり 409 amplifier_turn_stale になる）。
export async function writeTurn(projectId: string, turn: AmplifierTurn): Promise<AmplifierTurn> {
  const next = { ...turn, revision: turn.revision + 1, updatedAt: nowIso() };
  await storage.writeAmplifierTurn(projectId, next);
  return next;
}

export async function readTurnsForContextKey(
  projectId: string,
  contextKey: string
): Promise<AmplifierTurn[]> {
  const turns = await storage.readAmplifierTurns(projectId);
  return turns
    .filter((turn) => turn.contextKey === contextKey)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// NOTE: 表示対象は、同じ contextKey でアンカーが一致する最新の ready/failed/pending ターン。
// consumed / superseded は選択済みなので出さない。
export async function findDisplayTurn(
  projectId: string,
  contextKey: string
): Promise<AmplifierTurn | null> {
  const turns = await readTurnsForContextKey(projectId, contextKey);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.status === 'ready' || turn.status === 'failed' || turn.status === 'choices_pending') {
      return turn;
    }
  }
  return null;
}

export async function findTurnByAnchor(
  projectId: string,
  anchor: AmplifierAnchor,
  contextKey: string
): Promise<AmplifierTurn | null> {
  const turns = await readTurnsForContextKey(projectId, contextKey);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.status === 'consumed' || turn.status === 'superseded') continue;
    if (anchor.kind === 'novel') {
      if (
        turn.anchor.kind === 'novel' &&
        turn.anchor.generationId === anchor.generationId &&
        turn.anchor.textRevisionNumber === anchor.textRevisionNumber
      ) {
        return turn;
      }
    } else if (
      turn.anchor.kind === 'roleplay' &&
      turn.anchor.sessionId === anchor.sessionId &&
      turn.anchor.messageId === anchor.messageId &&
      turn.anchor.contentRevision === anchor.contentRevision
    ) {
      return turn;
    }
  }
  return null;
}

// --- 状態取得（設計書 13.1） ---

export async function getAmplifierState(
  projectId: string,
  query: AmplifierStateQuery
): Promise<AmplifierStateResponse> {
  const project = await storage.readProject(projectId);
  if (!project) {
    throw new AmplifierServiceError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const contextKey = buildContextKey(query.kind, query.sessionId);
  const notebook = await readNotebook(projectId);
  const turn = await findDisplayTurn(projectId, contextKey);
  // NOTE: ワークスペース読み込み時に未処理カーソルが残っていたら解釈を予約する
  // （設計書 10.2 更新トリガー）。非同期なので状態取得をブロックしない。
  if (notebook.interpreter.state !== 'pending') {
    void (async () => {
      const events = await readInteractions(projectId);
      if (events.some((event) => event.sequence > notebook.foldedThroughSequence)) {
        const { requestProjectInterpretation } = await import('./desireInterpreterService.js');
        void requestProjectInterpretation(projectId);
      }
    })();
  }
  return { projectId, contextKey, turn, notebook };
}

export async function assertAmplifierProject(projectId: string): Promise<Project> {
  const project = await storage.readProject(projectId);
  if (!project) {
    throw new AmplifierServiceError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  if (normalizeExperienceModeValue(project.experienceMode) !== 'amplifier') {
    throw new AmplifierServiceError(
      'この作品は妄想増幅器モードではありません。',
      'not_amplifier_project',
      false,
      409
    );
  }
  return project;
}

// --- 小説 advance lease（設計書 9.1 / 13.2） ---

export const ADVANCE_LEASE_MS = 180_000;

// NOTE: 期限切れleaseは次回操作のpreflightでfailedへ正規化する（設計書 9.1）。
export function normalizeExpiredLease(
  lease: PendingNovelAdvance | null | undefined
): PendingNovelAdvance | null {
  if (!lease) return null;
  if (lease.status === 'reserved' || lease.status === 'generating') {
    const expiresAt = new Date(lease.leaseExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
      return {
        ...lease,
        status: 'failed',
        errorCode: 'advance_lease_expired',
        updatedAt: nowIso(),
      };
    }
  }
  return lease;
}

export function leaseIsTerminal(lease: PendingNovelAdvance | null): boolean {
  if (!lease) return true;
  return lease.status === 'complete' || lease.status === 'failed' || lease.status === 'cancelled';
}

export async function reserveNovelAdvanceUnlocked(input: {
  projectId: string;
  operationId: string;
  interactionEventId: string;
  sourceTurnId: string;
  acceptedGenerationId: string;
  notebook: AmplifierProjectNotebook;
}): Promise<AmplifierProjectNotebook> {
  const lease: PendingNovelAdvance = {
    operationId: input.operationId,
    interactionEventId: input.interactionEventId,
    sourceTurnId: input.sourceTurnId,
    acceptedGenerationId: input.acceptedGenerationId,
    status: 'reserved',
    leaseExpiresAt: new Date(Date.now() + ADVANCE_LEASE_MS).toISOString(),
    revision: 1,
    updatedAt: nowIso(),
  };
  const next: AmplifierProjectNotebook = {
    ...input.notebook,
    pendingAdvance: lease,
    revision: input.notebook.revision + 1,
    updatedAt: nowIso(),
  };
  await writeNotebook(input.projectId, next);
  return next;
}

export async function updateAdvanceLeaseUnlocked(
  projectId: string,
  notebook: AmplifierProjectNotebook,
  update: Partial<PendingNovelAdvance>
): Promise<AmplifierProjectNotebook> {
  const lease = notebook.pendingAdvance;
  if (!lease) {
    throw new AmplifierServiceError(
      '進行中の advance がありません。',
      'amplifier_advance_not_found',
      true,
      409
    );
  }
  const merged: PendingNovelAdvance = {
    ...lease,
    ...update,
    revision: lease.revision + 1,
    updatedAt: nowIso(),
  };
  const next: AmplifierProjectNotebook = {
    ...notebook,
    pendingAdvance: merged,
    revision: notebook.revision + 1,
    updatedAt: nowIso(),
  };
  await writeNotebook(projectId, next);
  return next;
}

// --- お気に入り（設計書 7.4） ---

export async function recordFavorite(input: {
  projectId: string;
  clientEventId: string;
  scope: 'whole' | 'selection';
  anchor: AmplifierAnchor;
  excerpt?: string;
}): Promise<AmplifierInteractionEvent> {
  const result = await withProjectWriteLock(input.projectId, async () => {
    // 削除待ちの後にロックを取った場合、存在確認をやり直してディレクトリを復活させない。
    const project = await assertAmplifierProject(input.projectId);
    const notebook = await readNotebook(input.projectId);
    const mode = project.projectType === 'roleplay' ? 'roleplay' : 'novel';
    const contextKey =
      mode === 'roleplay' && input.anchor.kind === 'roleplay'
        ? buildContextKey('roleplay', input.anchor.sessionId)
        : buildContextKey('novel');
    const excludeFromGlobalLearning = await resolveEventExcludeFromGlobalLearning(
      input.projectId,
      contextKey,
      notebook
    );
    return recordInteractionUnlocked(input.projectId, {
      clientEventId: input.clientEventId,
      mode,
      type: 'favorite',
      anchor: input.anchor,
      payload: {
        scope: input.scope,
        anchor: input.anchor,
        ...(input.excerpt ? { excerpt: input.excerpt.slice(0, 500) } : {}),
      },
      excludeFromGlobalLearning,
      contextKey,
    });
  });
  return result.event;
}

// --- 作品内嗜好メモ（設計書 14.2） ---

export async function getProjectPreferences(
  projectId: string
): Promise<{ notebook: AmplifierProjectNotebook }> {
  await assertAmplifierProject(projectId);
  return { notebook: await readNotebook(projectId) };
}

export async function updateProjectPreferences(
  projectId: string,
  body: {
    addCorrections?: Array<{ scope: 'global' | 'project' | 'current'; appliesTo: PreferenceAppliesTo; text: string }>;
    withdrawCorrectionIds?: string[];
    deleteMemoIds?: string[];
    projectBoundary?: string | null;
    resetCurrentContextKeys?: string[];
    learningEnabled?: boolean;
  }
): Promise<{ notebook: AmplifierProjectNotebook }> {
  await assertAmplifierProject(projectId);
  return withProjectWriteLock(projectId, async () => {
    // 削除操作との競合でロック待ちした場合に、空ノートを書いて作品を復活させない。
    await assertAmplifierProject(projectId);
    const notebook = await readNotebook(projectId);
    const now = nowIso();
    const corrections = [...notebook.corrections];
    const projectMemos = [...notebook.projectMemos];
    const currentMemos = { ...notebook.currentMemos };
    const revisionLog: Array<{
      scope: 'global' | 'project' | 'current';
      kind: 'correction_add' | 'correction_withdraw' | 'memo_delete' | 'reset';
      memoId?: string;
      correctionId?: string;
      beforeText?: string;
      afterText?: string;
    }> = [];

    for (const input of body.addCorrections ?? []) {
      if (input.scope === 'global') {
        throw new AmplifierServiceError(
          'グローバル修正は /system/amplifier-preferences から操作してください。',
          'invalid_correction_scope',
          false,
          400
        );
      }
      const text = input.text.trim();
      if (!text || text.length > 2000) {
        throw new AmplifierServiceError(
          '修正文は1〜2000文字にしてください。',
          'invalid_correction',
          false,
          400
        );
      }
      if (input.appliesTo !== 'novel' && input.appliesTo !== 'roleplay' && input.appliesTo !== 'mixed') {
        throw new AmplifierServiceError(
          'appliesTo が不正です。',
          'invalid_correction',
          false,
          400
        );
      }
      const correction: PreferenceCorrection = {
        correctionId: generateTimestampId('amp-corr'),
        scope: input.scope,
        appliesTo: input.appliesTo,
        text,
        status: 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      corrections.push(correction);
      revisionLog.push({
        scope: input.scope,
        kind: 'correction_add',
        correctionId: correction.correctionId,
        afterText: text,
      });
    }
    for (const correctionId of body.withdrawCorrectionIds ?? []) {
      const index = corrections.findIndex((candidate) => candidate.correctionId === correctionId);
      if (index >= 0 && corrections[index].status === 'active') {
        corrections[index] = {
          ...corrections[index],
          status: 'withdrawn',
          revision: corrections[index].revision + 1,
          updatedAt: now,
        };
        revisionLog.push({
          scope: corrections[index].scope,
          kind: 'correction_withdraw',
          correctionId,
        });
      }
    }
    for (const memoId of body.deleteMemoIds ?? []) {
      const projectIndex = projectMemos.findIndex((memo) => memo.memoId === memoId);
      if (projectIndex >= 0) {
        projectMemos.splice(projectIndex, 1);
        revisionLog.push({ scope: 'project', kind: 'memo_delete', memoId });
      }
      for (const key of Object.keys(currentMemos)) {
        const before = currentMemos[key];
        const after = before.filter((memo) => memo.memoId !== memoId);
        if (after.length !== before.length) {
          currentMemos[key] = after;
          revisionLog.push({ scope: 'current', kind: 'memo_delete', memoId });
        }
      }
    }
    if (body.projectBoundary !== undefined) {
      notebook.projectBoundary = (body.projectBoundary ?? '').trim().slice(0, 2000);
    }
    if (body.learningEnabled !== undefined) {
      notebook.learningEnabled = body.learningEnabled;
    }
    for (const key of body.resetCurrentContextKeys ?? []) {
      if (Object.hasOwn(currentMemos, key)) {
        delete currentMemos[key];
        revisionLog.push({ scope: 'current', kind: 'reset', memoId: key });
      }
    }

    const next: AmplifierProjectNotebook = {
      ...notebook,
      projectMemos,
      currentMemos,
      corrections,
      revision: notebook.revision + 1,
      updatedAt: now,
    };
    await writeNotebook(projectId, next);
    for (const entry of revisionLog) {
      await storage.appendAmplifierNotebookRevision(projectId, {
        revisionId: generateTimestampId('amp-noterev'),
        scope: entry.scope,
        kind: entry.kind,
        ...(entry.memoId ? { memoId: entry.memoId } : {}),
        ...(entry.correctionId ? { correctionId: entry.correctionId } : {}),
        ...(entry.beforeText !== undefined ? { beforeText: entry.beforeText } : {}),
        ...(entry.afterText !== undefined ? { afterText: entry.afterText } : {}),
        createdAt: now,
      });
    }
    return { notebook: next };
  });
}

// NOTE: 会話枠のcurrentメモはアーカイブ後も履歴として残すが、新しい会話へ引き継がない
// （設計書 3.1）。この関数はロールプレイセッション開始時の preflight で使う。
export async function deleteAmplifierProjectData(projectId: string): Promise<void> {
  // 作品削除時はディレクトリごと消える（設計書 15.2）。ここでは明示的に後片付けしない
  // が、ロック保持中のメモリ状態を残さないために冪等にしておく。
  await interactionMutex.runExclusive(projectId, async () => undefined);
}

// --- 方向入力の検証（設計書 13.1） ---
// NOTE: 選択肢のラベル・本文はクライアントから信用せず、turnId からサーバー保存値を
// 解決する。小説 advance とロールプレイ amplifier-turn で同じ検証を使い、不正な方向で
// イベント保存・turn消費が起きないようにする（レビュー指摘: 検証前にturnをconsumed
// すると、その後の解決に失敗してturnだけ再利用不能になる）。
export interface NormalizedAmplifierDirection {
  type: 'choice_selected' | 'free_text' | 'stay';
  payload: AmplifierInteractionEvent['payload'];
}

export function normalizeAmplifierDirectionInput(
  direction: AmplifierDirectionInput,
  turn: { choices: Array<{ choiceId: string }> }
): NormalizedAmplifierDirection {
  if (!direction || typeof direction !== 'object') {
    throw new AmplifierServiceError('方向が不正です。', 'invalid_direction', false, 400);
  }
  const raw = direction as unknown as Record<string, unknown>;
  const hasSelectedChoice = Object.hasOwn(raw, 'selectedChoiceId');
  const hasFreeText = Object.hasOwn(raw, 'freeText');
  const hasCommand = Object.hasOwn(raw, 'command');
  if (Number(hasSelectedChoice) + Number(hasFreeText) + Number(hasCommand) !== 1) {
    throw new AmplifierServiceError(
      '方向は選択肢・自由記述・留まるのいずれか一つだけ指定してください。',
      'invalid_direction',
      false,
      400
    );
  }
  if (hasSelectedChoice) {
    if (typeof raw.selectedChoiceId !== 'string' || !raw.selectedChoiceId) {
      throw new AmplifierServiceError('選択肢が不正です。', 'invalid_direction', false, 400);
    }
    if (!turn.choices.some((choice) => choice.choiceId === raw.selectedChoiceId)) {
      throw new AmplifierServiceError(
        '選択された方向がこの選択肢にありません。再読み込みしてください。',
        'amplifier_direction_invalid',
        false,
        409
      );
    }
    return { type: 'choice_selected', payload: { choiceId: raw.selectedChoiceId } };
  }
  if (hasFreeText) {
    if (typeof raw.freeText !== 'string') {
      throw new AmplifierServiceError('自由記述が不正です。', 'invalid_direction', false, 400);
    }
    const text = raw.freeText.trim();
    if (!text) {
      throw new AmplifierServiceError('自由記述を入力してください。', 'invalid_direction', false, 400);
    }
    if (text.length > 2000) {
      throw new AmplifierServiceError(
        '自由記述が長すぎます（2000字以内）。',
        'invalid_direction',
        false,
        400
      );
    }
    return { type: 'free_text', payload: { text } };
  }
  if (raw.command === 'stay') {
    return { type: 'stay', payload: { command: 'stay' } };
  }
  throw new AmplifierServiceError('方向が不正です。', 'invalid_direction', false, 400);
}

// --- 生成プロンプト用の方向解決（設計書 11 / 13.2） ---

export async function resolveAmplifierDirection(
  projectId: string,
  event: AmplifierInteractionEvent
): Promise<string> {
  switch (event.type) {
    case 'stay':
      return buildStayInstruction();
    case 'free_text':
      return (event.payload as { text?: string }).text ?? '';
    case 'choice_selected': {
      const choiceId = (event.payload as { choiceId?: string }).choiceId;
      if (!event.turnId) {
        throw new AmplifierServiceError(
          '方向イベントが不正です。',
          'amplifier_direction_invalid',
          false,
          409
        );
      }
      const turn = await readTurn(projectId, event.turnId);
      const choice = turn?.choices.find((candidate) => candidate.choiceId === choiceId);
      if (!choice) {
        throw new AmplifierServiceError(
          '選択された方向が見つかりません。',
          'amplifier_direction_invalid',
          false,
          409
        );
      }
      return `${choice.label}: ${choice.description}`;
    }
    default:
      throw new AmplifierServiceError(
        '方向イベントではありません。',
        'amplifier_direction_invalid',
        false,
        409
      );
  }
}

// NOTE: pendingAdvance が terminal でない間、通常の小説生成・別の advance・採用状態を変える
// 操作はサーバー側で 409 を返す（設計書 13.2）。自分自身の operationId だけは許可する。
export async function assertNoConflictingAdvance(
  projectId: string,
  operationId?: string
): Promise<void> {
  const notebook = await readNotebook(projectId);
  const lease = normalizeExpiredLease(notebook.pendingAdvance);
  if (lease && lease.status !== 'complete' && lease.status !== 'failed' && lease.status !== 'cancelled') {
    if (lease.operationId !== operationId) {
      throw new AmplifierServiceError(
        '別の方向選択の場面生成が進行中です。',
        'amplifier_advance_in_progress',
        true,
        409
      );
    }
  }
}

export interface AmplifierPromptContext {
  direction: string;
  currentMemo: string;
  projectMemo: string;
  globalMemo: string;
  projectBoundary: string;
  globalBoundary: string;
}

function memoTextForMode(
  memos: PreferenceMemo[],
  mode: 'novel' | 'roleplay',
  corrections: PreferenceCorrection[]
): { ai: string; corrections: string } {
  const applicable = (memo: { appliesTo: PreferenceAppliesTo }) =>
    memo.appliesTo === 'mixed' || memo.appliesTo === mode;
  return {
    ai: memos.filter(applicable).map((memo) => memo.text).filter(Boolean).join('\n'),
    corrections: corrections
      .filter((correction) => correction.status === 'active' && applicable(correction))
      .map((correction) => correction.text)
      .filter(Boolean)
      .join('\n'),
  };
}

// NOTE: 生成プロンプトへ渡す三スコープの実効メモ（設計書 11.1 / 6.4）。ユーザー修正は
// AIメモと結合した実効テキストとして返すが、呼び出し側で「あなたの訂正」として区別
// 表示できるよう、scope ごとに AI と修正を分けて返す。
export async function collectAmplifierPromptContext(
  projectId: string,
  mode: 'novel' | 'roleplay',
  contextKey: string,
  direction: string
): Promise<AmplifierPromptContext> {
  const notebook = await readNotebook(projectId);
  const global = await globalService.collectGlobalMemosForPrompt(mode);

  const currentMemos = notebook.currentMemos[contextKey] ?? [];
  const currentCorrections = notebook.corrections.filter(
    (correction) => correction.scope === 'current' && correction.status === 'active'
  );
  const projectCorrections = notebook.corrections.filter(
    (correction) => correction.scope === 'project' && correction.status === 'active'
  );

  const current = memoTextForMode(currentMemos, mode, currentCorrections);
  const project = memoTextForMode(notebook.projectMemos, mode, projectCorrections);
  const globalText = memoTextForMode(global.memos, mode, global.corrections);

  const compose = (ai: string, corrections: string): string =>
    [ai, corrections ? `【あなたの訂正】\n${corrections}` : ''].filter(Boolean).join('\n\n');

  return {
    direction,
    currentMemo: compose(current.ai, current.corrections),
    projectMemo: compose(project.ai, project.corrections),
    globalMemo: compose(globalText.ai, globalText.corrections),
    projectBoundary: notebook.projectBoundary,
    globalBoundary: global.boundary,
  };
}
