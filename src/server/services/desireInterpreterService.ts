// Desire Interpreter（設計書 10）
//
// NOTE: 場面を生成しない。InteractionEvent・提示候補・直前場面の必要な抜粋・以前のメモから
// 観察ノートを書き直す。ユーザーが今選んだ方向は、解釈完了を待たず次の生成へ直接渡す
// ため、ここはバックグラウンドの詳細メモ更新を担当する（設計書 10.2 二速度更新）。
//
// 更新失敗時は既存メモを維持し、場面生成と選択をブロックしない。pending/failed 状態と
// 処理カーソルを保存し、次回読み込みまたは設定画面の「再試行」で再開する（設計書 10.2）。

import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { KeyedMutex } from '../utils/keyedMutex.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import { withProjectWriteLock } from './projectLock.js';
import * as amplifier from './amplifierService.js';
import * as globalService from './amplifierGlobalService.js';
import { buildInterpretationPrompt } from './amplifierPromptBuilder.js';
import { runNonStreaming } from './modelGenerationService.js';
import { resolveAppDefaultModelSettings } from './appSettingsService.js';
import type {
  AmplifierGlobalObservation,
  AmplifierInteractionEvent,
  AmplifierProjectNotebook,
  GlobalNotebook,
  PreferenceAppliesTo,
  PreferenceConfidence,
  PreferenceMemo,
} from '../types/index.js';
import type { InterpretationEventView } from './amplifierPromptBuilder.js';

const storage = localProjectStorage();

const PROJECT_FOLD_MAX_EVENTS = 40;
const INTERPRET_TIMEOUT_MS = 90_000;
const INTERPRET_OUTPUT_LENGTH = 6_000;

// NOTE: プロジェクト単位で fold を1本に絞る。global fold と同時に走らせても
// ロック順（グローバル→プロジェクトの取得禁止）に反しない。
const projectFoldMutex = new KeyedMutex();

interface InterpreterMemoInput {
  memoId?: string;
  appliesTo?: PreferenceAppliesTo;
  text?: string;
  confidence?: string;
  contextKey?: string;
}

function normalizeAppliesTo(value: unknown): PreferenceAppliesTo {
  return value === 'roleplay' || value === 'mixed' ? value : 'novel';
}

function normalizeConfidence(value: unknown): PreferenceConfidence {
  return value === 'recurring' ? 'recurring' : 'tentative';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseInterpreterJson(text: string): {
  current: Array<{ contextKey: string; appliesTo: PreferenceAppliesTo; text: string }>;
  project: InterpreterMemoInput[];
  globalCandidates: Array<{ appliesTo: PreferenceAppliesTo; text: string }>;
} | null {
  if (typeof text !== 'string') return null;
  let parsed: unknown = null;
  const trimmed = text.trim();
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!fenced) return null;
    try {
      parsed = JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
  }
  if (!isRecord(parsed)) return null;

  const current: Array<{ contextKey: string; appliesTo: PreferenceAppliesTo; text: string }> = [];
  if (Array.isArray(parsed.current)) {
    for (const item of parsed.current) {
      if (!isRecord(item)) continue;
      const contextKey = typeof item.contextKey === 'string' ? item.contextKey.trim() : '';
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!contextKey || !text) continue;
      current.push({
        contextKey,
        appliesTo: normalizeAppliesTo(item.appliesTo),
        text: text.slice(0, 800),
      });
    }
  }
  const project: InterpreterMemoInput[] = [];
  if (Array.isArray(parsed.project)) {
    for (const item of parsed.project) {
      if (!isRecord(item)) continue;
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) continue;
      project.push({
        ...(typeof item.memoId === 'string' ? { memoId: item.memoId } : {}),
        appliesTo: normalizeAppliesTo(item.appliesTo),
        text: text.slice(0, 1600),
        confidence: normalizeConfidence(item.confidence),
      });
    }
  }
  const globalCandidates: Array<{ appliesTo: PreferenceAppliesTo; text: string }> = [];
  if (Array.isArray(parsed.globalCandidates)) {
    for (const item of parsed.globalCandidates) {
      if (!isRecord(item)) continue;
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (!text) continue;
      globalCandidates.push({
        appliesTo: normalizeAppliesTo(item.appliesTo),
        text: text.slice(0, 300),
      });
    }
  }
  if (current.length === 0 && project.length === 0 && globalCandidates.length === 0) {
    return null;
  }
  return { current, project, globalCandidates };
}

// --- 作品内 fold（project / current メモ） ---

// NOTE: イベントを人間可読な表示行へ解決する。choice_selected は保存済みturnから
// 選ばれた候補の見出し・説明・選ばなかった候補・アンカー抜粋を解決しないと、
// 「何を選んだか」を学習できない（設計書 10.1 / 7.2）。turn が消えている場合や
// choiceId が解決できない場合は、不透明なIDのまま残さず「解決不可」と明示する。
async function buildInterpretationEventViews(
  projectId: string,
  events: AmplifierInteractionEvent[]
): Promise<InterpretationEventView[]> {
  const views: InterpretationEventView[] = [];
  for (const event of events) {
    const anchor =
      event.anchor.kind === 'novel'
        ? `novel:${event.anchor.generationId}@${event.anchor.textRevisionNumber}`
        : `roleplay:${event.anchor.sessionId}/${event.anchor.messageId}@${event.anchor.contentRevision}`;
    views.push({
      type: event.type,
      contextKey: event.contextKey,
      anchor,
      summary: await summarizeEventForInterpretation(projectId, event),
    });
  }
  return views;
}

async function summarizeEventForInterpretation(
  projectId: string,
  event: AmplifierInteractionEvent
): Promise<string> {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'choice_selected': {
      const choiceId = String(payload.choiceId ?? '');
      if (!event.turnId) return `選択（候補詳細なし）: ${choiceId}`;
      const turn = await amplifier.readTurn(projectId, event.turnId);
      if (!turn) return `選択（turn消失）: ${choiceId}`;
      const chosen = turn.choices.find((choice) => choice.choiceId === choiceId);
      const chosenLabel = chosen ? `${chosen.label}: ${chosen.description}` : `（解決不可）${choiceId}`;
      const others = turn.choices
        .filter((choice) => choice.choiceId !== choiceId)
        .map((choice) => choice.label);
      const excerpt = turn.anchorExcerpt.trim()
        ? `場面: ${turn.anchorExcerpt.trim().slice(0, 100)}`
        : '';
      return [
        `選択: ${chosenLabel}`,
        others.length > 0 ? `選ばなかった候補: ${others.join(' / ')}` : '',
        excerpt,
      ]
        .filter(Boolean)
        .join('\n  ');
    }
    case 'free_text':
      return `自由記述: ${String(payload.text ?? '').slice(0, 300)}`;
    case 'stay':
      return 'この場面に留まる';
    case 'choice_alternatives_requested':
      return `別の方向を要求（旧turn ${String(payload.previousTurnId ?? '')}）`;
    case 'favorite':
      return `お気に入り(${String(payload.scope ?? '')}): ${String(payload.excerpt ?? '').slice(0, 200)}`;
    case 'direction_rejected':
      return `方向違い: ${String(payload.reason ?? '（理由なし）').slice(0, 200)}`;
    case 'scene_regenerated':
      return '場面を再生成';
    case 'content_edited':
      return '本文を編集';
    case 'memo_corrected':
      return `メモ修正(${String(payload.correctionId ?? '')})`;
  }
}

export async function requestProjectInterpretation(projectId: string): Promise<void> {
  await projectFoldMutex
    .runExclusive(projectId, () => interpretProjectOnce(projectId))
    .catch((error) => {
      console.warn('Amplifier project interpretation failed', { projectId, error });
    });
}

async function interpretProjectOnce(projectId: string): Promise<void> {
  // --- prepare（プロジェクトロック内） ---
  const prepared = await withProjectWriteLock(projectId, async () => {
    const project = await amplifier.assertAmplifierProject(projectId);
    const notebook = await amplifier.readNotebook(projectId);
    if (notebook.interpreter.state === 'pending') return null;
    const events = await amplifier.readInteractions(projectId);
    // NOTE: 先頭から順に消化する。slice(-N) だと41件以上溜まったとき古いイベントが
    // 二度と処理されず、カーソルだけが進んで未解釈のまま捨てられる（設計書 9.4）。
    const pending = events
      .filter((event) => event.sequence > notebook.foldedThroughSequence)
      .slice(0, PROJECT_FOLD_MAX_EVENTS);
    if (pending.length === 0) return null;
    const mode: 'novel' | 'roleplay' =
      project.projectType === 'roleplay' ? 'roleplay' : 'novel';
    const next: AmplifierProjectNotebook = {
      ...notebook,
      interpreter: { state: 'pending', pendingAt: nowIso() },
      revision: notebook.revision + 1,
      updatedAt: nowIso(),
    };
    await amplifier.writeNotebook(projectId, next);
    return {
      notebook: next,
      events: pending,
      expectedRevision: next.revision,
      mode,
    };
  });
  if (!prepared) return;

  // --- generate（ロック外） ---
  let parsed: ReturnType<typeof parseInterpreterJson> | null = null;
  let modelError: { code: string; message: string } | null = null;
  try {
    // NOTE: 保存済みturnから選択肢の見出し・説明・選ばなかった候補・アンカー抜粋を
    // 解決し、「何を選んだか」を学習できる形へ整形する（設計書 10.1）。
    const eventViews = await buildInterpretationEventViews(projectId, prepared.events);
    const { systemInstructions, userPrompt } = buildInterpretationPrompt({
      mode: prepared.mode,
      eventViews,
      previousMemos: [
        ...prepared.notebook.projectMemos,
        ...Object.values(prepared.notebook.currentMemos).flat(),
      ],
      corrections: prepared.notebook.corrections,
      contextKeys: Object.keys(prepared.notebook.currentMemos),
      isGlobal: false,
    });
    const project = await storage.readProject(projectId);
    if (!project) return;
    const result = await runNonStreaming(project.activeModelProvider, {
      debugLabel: 'amplifier.interpretProject',
      systemInstructions,
      userPrompt,
      outputLength: INTERPRET_OUTPUT_LENGTH,
      temperature: 0.3,
      timeoutMs: INTERPRET_TIMEOUT_MS,
      modelName: project.activeModelName,
    });
    parsed = parseInterpreterJson(result.text);
  } catch (error) {
    modelError = {
      code:
        error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : 'interpreter_failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // --- commit（プロジェクトロック内・期待改訂の検証） ---
  const committed = await withProjectWriteLock(projectId, async () => {
    // モデル呼び出し中に作品が削除された場合、空ノートを再作成しない。
    await amplifier.assertAmplifierProject(projectId);
    const current = await amplifier.readNotebook(projectId);
    if (current.revision !== prepared.expectedRevision) {
      // NOTE: 解釈中に別の更新が入っていたら結果を破棄（設計書 12.2 の expectedRevision
      // 検証）。pending のままにすると再試行も何もしなくなって固まるため、idle へ戻し、
      // 未処理イベントが残っていれば次回 fold で再予約されるようにする。
      const next: AmplifierProjectNotebook = {
        ...current,
        interpreter: { state: 'idle' },
        revision: current.revision + 1,
        updatedAt: nowIso(),
      };
      await amplifier.writeNotebook(projectId, next);
      return {
        notebook: next,
        candidates: [] as Array<{ appliesTo: PreferenceAppliesTo; text: string }>,
        ok: false,
        stale: true,
      };
    }
    if (parsed) {
      const merged = mergeProjectMemos(current, parsed, prepared.events);
      const next: AmplifierProjectNotebook = {
        ...merged.notebook,
        // NOTE: 消化したイベントの末尾までだけ進める（slice(0,N) と対で、未消化分を
        // カーソルで飛ばさない）。
        foldedThroughSequence: Math.max(
          current.foldedThroughSequence,
          prepared.events[prepared.events.length - 1].sequence
        ),
        interpreter: { state: 'idle' },
        revision: current.revision + 1,
        updatedAt: nowIso(),
      };
      await amplifier.writeNotebook(projectId, next);
      await appendMemoRevisions(projectId, merged.changes);
      return { notebook: next, candidates: parsed.globalCandidates, ok: true, stale: false };
    }
    const next: AmplifierProjectNotebook = {
      ...current,
      interpreter: {
        state: 'failed',
        failedAt: nowIso(),
        lastErrorCode: modelError?.code ?? 'interpreter_failed',
      },
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    await amplifier.writeNotebook(projectId, next);
    return { notebook: next, candidates: [], ok: false, stale: false };
  });

  // --- グローバル観察（プロジェクトロックの外で追記・設計書 12.1） ---
  if (committed.ok && committed.candidates.length > 0) {
    await promoteToGlobalObservations(projectId, prepared.events, committed.candidates);
  } else if (committed.stale) {
    // NOTE: stale で結果を破棄した場合は、未処理イベントが残っているので再予約する。
    // requestProjectInterpretation は mutex で直列化されるため、無限ループにはならない。
    void requestProjectInterpretation(projectId);
  }
}

// NOTE: グローバル学習は「この作品から学習するか」と「グローバル利用をオンにしているか」と
// 「会話枠の除外指定」の三つをすべて満たしたイベントだけが対象（設計書 9.2 / 14.2）。
// 除外会話と通常会話が同じfoldに混ざった場合、除外イベント由来の内容がグローバル候補へ
// 入らないよう、対象外イベントをevidenceから外す。
async function promoteToGlobalObservations(
  projectId: string,
  events: Array<{ excludeFromGlobalLearning: boolean; eventId?: string }>,
  candidates: Array<{ appliesTo: PreferenceAppliesTo; text: string }>
): Promise<void> {
  const notebook = await amplifier.readNotebook(projectId);
  if (!notebook.learningEnabled) return;
  const globalSettings = await globalService.getAmplifierSettings();
  if (!globalSettings.globalLearningEnabled) return;
  const eligible = events.filter((event) => !event.excludeFromGlobalLearning);
  if (eligible.length === 0) return;
  const sourceEvent = eligible[eligible.length - 1];
  for (const candidate of candidates) {
    const observation: AmplifierGlobalObservation = {
      schemaVersion: 1,
      observationId: generateTimestampId('amp-obs'),
      projectId,
      contextKey: 'project',
      appliesTo: candidate.appliesTo,
      text: candidate.text,
      confidence: 'tentative',
      sourceEventId: sourceEvent?.eventId ?? '',
      createdAt: nowIso(),
    };
    await globalService.appendGlobalObservation(observation);
  }
  void requestGlobalInterpretation();
}

function mergeProjectMemos(
  notebook: AmplifierProjectNotebook,
  parsed: NonNullable<ReturnType<typeof parseInterpreterJson>>,
  events: Array<{ eventId: string }>
): {
  notebook: AmplifierProjectNotebook;
  changes: Array<{
    scope: 'project' | 'current';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }>;
} {
  const now = nowIso();
  const evidenceIds = events.map((event) => event.eventId).slice(-20);
  const changes: Array<{
    scope: 'project' | 'current';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }> = [];

  // current: contextKey ごとに1件の解釈へ置き換える
  const currentMemos: Record<string, PreferenceMemo[]> = { ...notebook.currentMemos };
  for (const entry of parsed.current) {
    const existing = (currentMemos[entry.contextKey] ?? [])[0];
    const evidence = mergeEvidence(existing?.evidenceEventIds ?? [], evidenceIds);
    if (existing && existing.text === entry.text && existing.appliesTo === entry.appliesTo) {
      currentMemos[entry.contextKey] = [{ ...existing, evidenceEventIds: evidence }];
      continue;
    }
    const memo: PreferenceMemo = {
      memoId: existing?.memoId ?? generateTimestampId('amp-memo'),
      scope: 'current',
      appliesTo: entry.appliesTo,
      text: entry.text,
      confidence: existing?.confidence ?? 'tentative',
      evidenceEventIds: evidence,
      counterEvidenceEventIds: existing?.counterEvidenceEventIds ?? [],
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    currentMemos[entry.contextKey] = [memo];
    changes.push({
      scope: 'current',
      kind: 'memo_update',
      memoId: memo.memoId,
      ...(existing ? { beforeText: existing.text } : {}),
      afterText: memo.text,
    });
  }
  // 解釈対象の contextKey で今回は言及が無ければ残す（未確定のまま保持）

  // project: 出力リストを正本に置き換える（再解釈・設計書 10.3）
  const existingById = new Map(notebook.projectMemos.map((memo) => [memo.memoId, memo]));
  const seenIds = new Set<string>();
  const projectMemos: PreferenceMemo[] = [];
  for (const entry of parsed.project) {
    const id = entry.memoId && existingById.has(entry.memoId) ? entry.memoId : undefined;
    const existing = id ? existingById.get(id) : undefined;
    seenIds.add(id ?? '');
    if (
      id &&
      existing &&
      existing.text === (entry.text ?? '') &&
      existing.appliesTo === entry.appliesTo
    ) {
      projectMemos.push({
        ...existing,
        evidenceEventIds: mergeEvidence(existing.evidenceEventIds, evidenceIds),
      });
      continue;
    }
    const memo: PreferenceMemo = {
      memoId: id ?? generateTimestampId('amp-memo'),
      scope: 'project',
      appliesTo: entry.appliesTo ?? 'novel',
      text: entry.text ?? '',
      confidence: entry.confidence
        ? normalizeConfidence(entry.confidence)
        : existing?.confidence ?? 'tentative',
      evidenceEventIds: mergeEvidence(existing?.evidenceEventIds ?? [], evidenceIds),
      counterEvidenceEventIds: existing?.counterEvidenceEventIds ?? [],
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    projectMemos.push(memo);
    changes.push({
      scope: 'project',
      kind: 'memo_update',
      memoId: memo.memoId,
      ...(existing ? { beforeText: existing.text } : {}),
      afterText: memo.text,
    });
  }
  for (const memo of notebook.projectMemos) {
    if (!seenIds.has(memo.memoId)) {
      changes.push({
        scope: 'project',
        kind: 'memo_delete',
        memoId: memo.memoId,
        beforeText: memo.text,
      });
    }
  }

  return { notebook: { ...notebook, currentMemos, projectMemos }, changes };
}

function mergeEvidence(current: string[], newIds: string[]): string[] {
  const seen = new Set(current);
  for (const id of newIds) {
    if (id) seen.add(id);
  }
  return [...seen].slice(-20);
}

async function appendMemoRevisions(
  projectId: string,
  changes: Array<{
    scope: 'project' | 'current';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }>
): Promise<void> {
  const now = nowIso();
  for (const change of changes) {
    await storage.appendAmplifierNotebookRevision(projectId, {
      revisionId: generateTimestampId('amp-noterev'),
      scope: change.scope,
      kind: change.kind,
      ...(change.memoId ? { memoId: change.memoId } : {}),
      ...(change.beforeText !== undefined ? { beforeText: change.beforeText } : {}),
      ...(change.afterText !== undefined ? { afterText: change.afterText } : {}),
      createdAt: now,
    });
  }
}

// --- グローバル fold（設計書 9.2 / 10.4 昇格） ---

const globalFoldMutex = new KeyedMutex();

export async function requestGlobalInterpretation(): Promise<void> {
  await globalFoldMutex.runExclusive('global', () => interpretGlobalOnce()).catch((error) => {
    console.warn('Amplifier global interpretation failed', { error });
  });
}

async function interpretGlobalOnce(): Promise<void> {
  const prepared = await globalService.withGlobalMutexRun(async () => {
    const notebook = await globalService.readGlobalNotebook();
    // NOTE: グローバル学習オフ時は fold 自体を停止する（設計書 14.3）。観察は作られない
    // ため、ここに到達するのは手動再試行などの直接呼び出し経路。
    if (!notebook.globalLearningEnabled) return null;
    if (notebook.interpreter.state === 'pending') return null;
    const observations = await globalService.readGlobalObservations();
    const pending = observations.slice(notebook.foldedThroughSequence);
    const resetAt = notebook.globalLearningResetAt;
    const usable = resetAt
      ? pending.filter((observation) => observation.createdAt > resetAt)
      : pending;
    if (usable.length === 0) return null;
    const next: GlobalNotebook = {
      ...notebook,
      interpreter: { state: 'pending', pendingAt: nowIso() },
      revision: notebook.revision + 1,
      updatedAt: nowIso(),
    };
    await storage.writeGlobalAmplifierNotebook(next);
    return { notebook: next, observations: usable, expectedRevision: next.revision };
  });
  if (!prepared) return;

  let parsed: ReturnType<typeof parseInterpreterJson> | null = null;
  try {
    const previousMemos: PreferenceMemo[] = prepared.notebook.memos;
    const { systemInstructions, userPrompt } = buildInterpretationPrompt({
      mode: 'mixed',
      eventViews: [],
      previousMemos,
      corrections: prepared.notebook.corrections,
      contextKeys: [],
      isGlobal: true,
    });
    const userPromptWithObservations = [
      userPrompt,
      `【グローバル観察（作品をまたいだ抽象化済みの観察）】\n${prepared.observations
        .map((observation) => `- [${observation.appliesTo}/${observation.confidence}] ${observation.text}`)
        .join('\n')}`,
      'globalCandidates は使わず、観察と既存メモ・訂正だけから global メモ（appliesTo ごと）を統合せよ。',
    ].join('\n\n');

    const model = await resolveGlobalInterpretationModel();
    if (!model) {
      // モデルが利用できなければ pending を維持する（設計書 10.2）
      return;
    }
    const result = await runNonStreaming(model.provider, {
      debugLabel: 'amplifier.interpretGlobal',
      systemInstructions,
      userPrompt: userPromptWithObservations,
      outputLength: INTERPRET_OUTPUT_LENGTH,
      temperature: 0.3,
      timeoutMs: INTERPRET_TIMEOUT_MS,
      modelName: model.modelName ?? '',
    });
    parsed = parseInterpreterJson(result.text);
  } catch (error) {
    console.warn('Amplifier global interpretation model call failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let commitWasStale = false;
  await globalService.withGlobalMutexRun(async () => {
    const current = await globalService.readGlobalNotebook();
    if (current.revision !== prepared.expectedRevision) {
      // NOTE: 解釈中に別の更新が入っていたら結果を破棄し、pending を解除する
      // （design レビュー指摘: pending のままにすると再試行も何もしなくなる）。
      const next: GlobalNotebook = {
        ...current,
        interpreter: { state: 'idle' },
        revision: current.revision + 1,
        updatedAt: nowIso(),
      };
      await storage.writeGlobalAmplifierNotebook(next);
      commitWasStale = true;
      return;
    }
    if (!parsed) {
      const next: GlobalNotebook = {
        ...current,
        interpreter: {
          state: 'failed',
          failedAt: nowIso(),
          lastErrorCode: 'interpreter_failed',
        },
        revision: current.revision + 1,
        updatedAt: nowIso(),
      };
      await storage.writeGlobalAmplifierNotebook(next);
      return;
    }
    const merged = mergeGlobalMemos(current, parsed, prepared.observations);
    const next: GlobalNotebook = {
      ...merged.notebook,
      // NOTE: 解釈カーソルは畳み込み済み観察件数。リセット後も行数カウントで前進させる。
      foldedThroughSequence: current.foldedThroughSequence + prepared.observations.length,
      interpreter: { state: 'idle' },
      revision: current.revision + 1,
      updatedAt: nowIso(),
    };
    await storage.writeGlobalAmplifierNotebook(next);
    await appendGlobalMemoRevisions(merged.changes);
  });

  // NOTE: stale で結果を破棄した場合は、未処理観察が残っているので再予約する。
  if (commitWasStale) {
    void requestGlobalInterpretation();
  }
}

function mergeGlobalMemos(
  notebook: GlobalNotebook,
  parsed: NonNullable<ReturnType<typeof parseInterpreterJson>>,
  observations: AmplifierGlobalObservation[]
): {
  notebook: GlobalNotebook;
  changes: Array<{
    scope: 'global';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }>;
} {
  const now = nowIso();
  const existingById = new Map(notebook.memos.map((memo) => [memo.memoId, memo]));
  const seenIds = new Set<string>();
  const memos: PreferenceMemo[] = [];
  const changes: Array<{
    scope: 'global';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }> = [];

  // NOTE: 昇格（設計書 10.4）。観察の観点（appliesTo）を保持し、recurring は「複数の独立
  // イベント・反復・明示確認」を表す。解釈出力の project 欄をグローバルメモとして使う。
  for (const entry of parsed.project) {
    const id = entry.memoId && existingById.has(entry.memoId) ? entry.memoId : undefined;
    const existing = id ? existingById.get(id) : undefined;
    seenIds.add(id ?? '');
    if (
      id &&
      existing &&
      existing.text === (entry.text ?? '') &&
      existing.appliesTo === entry.appliesTo
    ) {
      memos.push(existing);
      continue;
    }
    const memo: PreferenceMemo = {
      memoId: id ?? generateTimestampId('amp-memo'),
      scope: 'global',
      appliesTo: entry.appliesTo ?? 'novel',
      text: entry.text ?? '',
      confidence: entry.confidence
        ? normalizeConfidence(entry.confidence)
        : existing?.confidence ?? 'tentative',
      evidenceEventIds: mergeEvidence(
        existing?.evidenceEventIds ?? [],
        observations.map((observation) => observation.sourceEventId)
      ),
      counterEvidenceEventIds: existing?.counterEvidenceEventIds ?? [],
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    memos.push(memo);
    changes.push({
      scope: 'global',
      kind: 'memo_update',
      memoId: memo.memoId,
      ...(existing ? { beforeText: existing.text } : {}),
      afterText: memo.text,
    });
  }
  for (const memo of notebook.memos) {
    if (!seenIds.has(memo.memoId)) {
      changes.push({
        scope: 'global',
        kind: 'memo_delete',
        memoId: memo.memoId,
        beforeText: memo.text,
      });
    }
  }

  return { notebook: { ...notebook, memos }, changes };
}

async function appendGlobalMemoRevisions(
  changes: Array<{
    scope: 'global';
    kind: 'memo_update' | 'memo_delete';
    memoId?: string;
    beforeText?: string;
    afterText?: string;
  }>
): Promise<void> {
  const now = nowIso();
  for (const change of changes) {
    await storage.appendGlobalAmplifierNotebookRevision({
      revisionId: generateTimestampId('amp-noterev'),
      scope: 'global',
      kind: change.kind,
      ...(change.memoId ? { memoId: change.memoId } : {}),
      ...(change.beforeText !== undefined ? { beforeText: change.beforeText } : {}),
      ...(change.afterText !== undefined ? { afterText: change.afterText } : {}),
      createdAt: now,
    });
  }
}

async function resolveGlobalInterpretationModel(): Promise<{
  provider: string;
  modelName?: string;
} | null> {
  const defaultModel = await resolveAppDefaultModelSettings();
  if (defaultModel) return defaultModel;
  return null;
}

// NOTE: 手動再試行（設定画面・設計書 14.1）。プロジェクト fold は「現在の作品」から
// モデルを解決するため projectId が必要。グローバルだけの再試行は既定モデルを使う。
export async function retryProjectInterpretation(projectId: string): Promise<void> {
  const notebook = await amplifier.readNotebook(projectId);
  if (notebook.interpreter.state === 'failed' || (await hasUnfoldedEvents(projectId, notebook))) {
    await requestProjectInterpretation(projectId);
  }
}

async function hasUnfoldedEvents(
  projectId: string,
  notebook: AmplifierProjectNotebook
): Promise<boolean> {
  const events = await amplifier.readInteractions(projectId);
  return events.some((event) => event.sequence > notebook.foldedThroughSequence);
}

export async function retryGlobalInterpretation(): Promise<void> {
  const notebook = await globalService.readGlobalNotebook();
  // NOTE: オフ時は手動再試行も行わない（設計書 14.3）。
  if (!notebook.globalLearningEnabled) return;
  const observations = await globalService.readGlobalObservations();
  const resetAt = notebook.globalLearningResetAt;
  const usable = resetAt
    ? observations.slice(notebook.foldedThroughSequence).filter((o) => o.createdAt > resetAt)
    : observations.slice(notebook.foldedThroughSequence);
  if (notebook.interpreter.state === 'failed' || usable.length > 0) {
    await requestGlobalInterpretation();
  }
}
