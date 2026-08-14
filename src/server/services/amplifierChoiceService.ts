// 妄想増幅器の選択肢生成サービス（設計書 5 / 12.2）
//
// NOTE: 本文・キャラクター応答と選択肢を同じLLM応答へ混ぜない（設計書 5.1）。
// 本文を保存した後、短い非ストリーミング呼び出しで選択肢を作る。共通の
// modelGenerationService.runNonStreaming を利用し、アダプター分岐や認証再読込を複製しない。
//
// 生成は prepare -> generate -> commit の三段階（設計書 12.2）。プロジェクトロックは
// prepare と commit だけで取得し、LLM呼び出し中はロックを保持しない。

import { nowIso } from '../utils/date.js';
import { generateId } from '../utils/id.js';
import { withProjectWriteLock } from './projectLock.js';
import * as amplifier from './amplifierService.js';
import { buildChoiceGenerationPrompt } from './amplifierPromptBuilder.js';
import { runNonStreaming, ModelClientError } from './modelGenerationService.js';
import * as globalService from './amplifierGlobalService.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import type {
  AmplifierAnchor,
  AmplifierChoice,
  AmplifierStrategy,
  AmplifierTurn,
  PreferenceAppliesTo,
} from '../types/index.js';

const storage = localProjectStorage();

export class AmplifierChoiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AmplifierChoiceError';
  }
}

export interface CreateTurnResult {
  turn: AmplifierTurn;
  stale: boolean;
}

const CHOICE_MIN_COUNT = 3;
const CHOICE_MAX_COUNT = 5;
const CHOICE_LABEL_MAX = 40;
const CHOICE_DESCRIPTION_MAX = 160;
const CHOICE_TIMEOUT_MS = 60_000;

// --- 正規化（設計書 5.4） ---

// NOTE: 空・重複・境界違反候補を除外し、3〜5件に揃える。choiceId / turnId はモデルに
// 作らせずサーバーで採番する。
export function normalizeChoiceCandidates(
  parsed: unknown,
  boundaryText: string
): AmplifierChoice[] {
  const result: AmplifierChoice[] = [];
  const seenLabels = new Set<string>();
  const strategies: AmplifierStrategy[] = ['exploit', 'variation', 'explore'];

  const pushStrategy = (strategy: AmplifierStrategy, rawList: unknown) => {
    if (!Array.isArray(rawList)) return;
    for (const item of rawList) {
      if (result.length >= CHOICE_MAX_COUNT) return;
      if (typeof item !== 'object' || item === null) continue;
      const raw = item as Record<string, unknown>;
      const label = typeof raw.label === 'string' ? raw.label.trim() : '';
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      if (!label || label.length > CHOICE_LABEL_MAX) continue;
      if (!description || description.length > CHOICE_DESCRIPTION_MAX) continue;
      const key = label.toLowerCase();
      if (seenLabels.has(key)) continue;
      if (violatesBoundary(`${label} ${description}`, boundaryText)) continue;
      seenLabels.add(key);
      result.push({
        choiceId: generateId('amp-choice'),
        strategy,
        label,
        description,
      });
    }
  };

  const parsedRecord = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
  for (const strategy of strategies) {
    pushStrategy(strategy, parsedRecord[strategy]);
  }

  // NOTE: 探索候補は通常最低1件含めるが、明示された現在欲求やハード境界と衝突する場合は
  // 無理に入れない（設計書 5.2）。explore が欠けていても3件以上あれば有効とする。
  return result.slice(0, CHOICE_MAX_COUNT);
}

function violatesBoundary(text: string, boundaryText: string): boolean {
  const boundary = boundaryText.trim();
  if (!boundary) return false;
  const normalized = text.toLowerCase();
  for (const line of boundary.split('\n')) {
    const candidate = line.trim();
    // NOTE: 短すぎる断片は「境界」として比較しない。8文字以上の行だけを部分一致で弾く。
    if (candidate.length >= 8 && normalized.includes(candidate.toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function isChoiceListComplete(choices: AmplifierChoice[]): boolean {
  return choices.length >= CHOICE_MIN_COUNT && choices.length <= CHOICE_MAX_COUNT;
}

// --- 候補収集 ---

async function collectChoiceContext(input: {
  projectId: string;
  mode: 'novel' | 'roleplay';
  contextKey: string;
  sessionId?: string;
}): Promise<{
  effectiveMemos: Array<{
    scope: 'current' | 'project' | 'global';
    contextKey?: string;
    appliesTo: string;
    text: string;
    kind: 'ai' | 'correction';
  }>;
  projectBoundary: string;
  globalBoundary: string;
  previousChoices: AmplifierChoice[];
}> {
  const notebook = await amplifier.readNotebook(input.projectId);
  const global = await globalService.collectGlobalMemosForPrompt(input.mode);

  const effectiveMemos: Array<{
    scope: 'current' | 'project' | 'global';
    contextKey?: string;
    appliesTo: string;
    text: string;
    kind: 'ai' | 'correction';
  }> = [];

  const pushMemo = (
    scope: 'current' | 'project' | 'global',
    appliesTo: PreferenceAppliesTo,
    text: string,
    kind: 'ai' | 'correction',
    contextKey?: string
  ) => {
    if (!text.trim()) return;
    effectiveMemos.push({ scope, appliesTo, text, kind, ...(contextKey ? { contextKey } : {}) });
  };

  const currentList = notebook.currentMemos[input.contextKey] ?? [];
  for (const memo of currentList) {
    pushMemo('current', memo.appliesTo, memo.text, 'ai', input.contextKey);
  }
  for (const memo of notebook.projectMemos) {
    pushMemo('project', memo.appliesTo, memo.text, 'ai');
  }
  for (const memo of global.memos) {
    pushMemo('global', memo.appliesTo, memo.text, 'ai');
  }
  const activeCorrections = [
    ...notebook.corrections,
    ...global.corrections.map((correction) => ({ ...correction, scope: 'global' as const })),
  ].filter((correction) => correction.status === 'active');
  for (const correction of activeCorrections) {
    const scope = correction.scope === 'global' ? 'global' : correction.scope;
    pushMemo(
      scope,
      correction.appliesTo,
      correction.text,
      'correction',
      scope === 'current' ? input.contextKey : undefined
    );
  }

  // 直前に提示した候補（同一 contextKey の最新 ready ターン）
  const previousTurn = await amplifier.findDisplayTurn(input.projectId, input.contextKey);
  return {
    effectiveMemos,
    projectBoundary: notebook.projectBoundary,
    globalBoundary: global.boundary,
    previousChoices: previousTurn?.choices ?? [],
  };
}

// --- 生成 ---

async function generateChoicesFromModel(input: {
  projectId: string;
  mode: 'novel' | 'roleplay';
  contextKey: string;
  sessionId?: string;
  excerpt: string;
  characterName?: string;
}): Promise<AmplifierChoice[]> {
  const { effectiveMemos, projectBoundary, globalBoundary, previousChoices } =
    await collectChoiceContext(input);
  const { systemInstructions, userPrompt } = buildChoiceGenerationPrompt({
    mode: input.mode,
    excerpt: input.excerpt,
    previousChoices,
    effectiveMemos,
    projectBoundary,
    globalBoundary,
    characterName: input.characterName,
  });

  const project = await storage.readProject(input.projectId);
  if (!project) {
    throw new AmplifierChoiceError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const provider = project.activeModelProvider;
  const modelName = project.activeModelName;

  const attempt = async (extraInstruction: string | null): Promise<string> => {
    const userPromptText = extraInstruction
      ? `${userPrompt}\n\n前回の出力はJSONとして解釈できなかった。余計な説明を一切含めず、次のJSONだけを出力し直せ。\n前回の出力:\n${extraInstruction.slice(-2000)}`
      : userPrompt;
    const result = await runNonStreaming(provider, {
      debugLabel: 'amplifier.choices',
      systemInstructions,
      userPrompt: userPromptText,
      outputLength: 1200,
      temperature: 0.9,
      timeoutMs: CHOICE_TIMEOUT_MS,
      modelName,
    });
    return result.text;
  };

  try {
    let text = await attempt(null);
    let parsed: unknown = tryParseJson(text);
    // NOTE: パース失敗時は修復呼び出しを最大1回だけ行う（設計書 5.4）。
    if (parsed === undefined) {
      const repaired = await attempt(text);
      parsed = tryParseJson(repaired);
    }
    const boundaryText = [projectBoundary, globalBoundary].filter(Boolean).join('\n');
    const choices = normalizeChoiceCandidates(parsed, boundaryText);
    if (!isChoiceListComplete(choices)) {
      throw new AmplifierChoiceError(
        '選択肢の生成結果が不正でした。',
        'amplifier_choices_invalid',
        true,
        502
      );
    }
    return choices;
  } catch (err) {
    if (err instanceof AmplifierChoiceError) throw err;
    if (err instanceof ModelClientError) {
      throw new AmplifierChoiceError(
        `選択肢の生成に失敗しました: ${err.message}`,
        err.code,
        err.retryable,
        502
      );
    }
    throw err;
  }
}

function tryParseJson(text: string): unknown {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 先頭・末尾の非JSON囲い（コードフェンス等）を剥がして再試行
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1].trim() : trimmed;
    try {
      return JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
}

// --- ターン作成（三段階・設計書 12.2） ---

// NOTE: 保存済み実効本文が確定してから作る。小説のNG自動書き換え・手動編集・履歴復元・
// 下書き切替・ロールプレイの初回greeting保存が本文を変えた場合は、旧turnをsupersededにし、
// 新しい改訂へ選択肢を作り直す（設計書 4.3）。ここでは同じアンカーの既存 turn を再利用し、
// アンカーが変わったターンは古いものとして扱う。
export async function createTurnForAnchor(
  projectId: string,
  anchor: AmplifierAnchor
): Promise<CreateTurnResult> {
  const project = await amplifier.assertAmplifierProject(projectId);
  const mode = project.projectType === 'roleplay' ? 'roleplay' : 'novel';

  // --- prepare（プロジェクトロック内） ---
  const prepared = await withProjectWriteLock(projectId, async () => {
    // 削除処理より後にロックを取得した非同期ジョブは、作品を再作成せず終了する。
    await amplifier.assertAmplifierProject(projectId);
    const resolved = await amplifier.resolveEffectiveAnchorText(projectId, anchor);
    if (!resolved.ok) {
      throw new AmplifierChoiceError(
        'アンカーの本文が見つかりません。',
        'amplifier_anchor_invalid',
        false,
        404
      );
    }
    const contextKey = amplifier.buildContextKey(
      mode,
      mode === 'roleplay' && anchor.kind === 'roleplay' ? anchor.sessionId : undefined
    );
    const existing = await amplifier.findTurnByAnchor(projectId, anchor, contextKey);
    if (existing) {
      if (existing.status === 'ready' || existing.status === 'failed') {
        return { turn: existing, stale: false };
      }
      if (existing.status === 'choices_pending') {
        throw new AmplifierChoiceError(
          '選択肢を生成中です。',
          'amplifier_turn_in_progress',
          true,
          409
        );
      }
    }
    const turn = amplifier.createEmptyTurn(
      projectId,
      contextKey,
      anchor,
      resolved.hash,
      resolved.text
    );
    const saved = await amplifier.writeTurn(projectId, turn);
    return { turn: saved, stale: false };
  });

  if (prepared.turn.status === 'ready') return prepared;
  if (prepared.turn.status === 'failed') {
    // 失敗したターンは同じアンカーで作り直す
    return regenerateTurnChoices(projectId, prepared.turn, anchor, mode);
  }

  const resolved = await amplifier.resolveEffectiveAnchorText(projectId, anchor);
  const characterName =
    mode === 'roleplay' && anchor.kind === 'roleplay'
      ? await resolveCharacterName(projectId, anchor.sessionId)
      : undefined;

  // --- generate（ロック外） ---
  let choices: AmplifierChoice[] | null = null;
  let errorCode: string | undefined;
  try {
    choices = await generateChoicesFromModel({
      projectId,
      mode,
      contextKey: prepared.turn.contextKey,
      sessionId: anchor.kind === 'roleplay' ? anchor.sessionId : undefined,
      excerpt: resolved.text,
      characterName,
    });
  } catch (err) {
    errorCode = err instanceof AmplifierChoiceError ? err.code : 'amplifier_choices_failed';
  }

  // --- commit（プロジェクトロック内・アンカー再検証） ---
  return withProjectWriteLock(projectId, async () => {
    const current = await amplifier.readTurn(projectId, prepared.turn.turnId);
    if (!current || current.status === 'superseded' || current.status === 'consumed') {
      return { turn: current ?? prepared.turn, stale: true };
    }
    const nowResolved = await amplifier.resolveEffectiveAnchorText(projectId, anchor);
    // NOTE: 生成中に本文・改訂が変わっていたら結果を破棄して stale にする（設計書 12.2）。
    if (
      !nowResolved.ok ||
      !amplifier.verifyAnchorAgainstCurrent(anchor, nowResolved, current.anchorTextHash)
    ) {
      const next: AmplifierTurn = {
        ...current,
        status: 'superseded',
        errorCode: 'stale_anchor',
        updatedAt: nowIso(),
      };
      const saved = await amplifier.writeTurn(projectId, next);
      return { turn: saved, stale: true };
    }
    const next: AmplifierTurn = {
      ...current,
      status: choices && choices.length >= 3 ? 'ready' : 'failed',
      ...(choices ? { choices } : {}),
      ...(errorCode ? { errorCode } : {}),
      updatedAt: nowIso(),
    };
    const saved = await amplifier.writeTurn(projectId, next);
    return { turn: saved, stale: false };
  });
}

async function regenerateTurnChoices(
  projectId: string,
  turn: AmplifierTurn,
  anchor: AmplifierAnchor,
  mode: 'novel' | 'roleplay'
): Promise<CreateTurnResult> {
  const resolved = await amplifier.resolveEffectiveAnchorText(projectId, anchor);
  if (!resolved.ok) {
    throw new AmplifierChoiceError(
      'アンカーの本文が見つかりません。',
      'amplifier_anchor_invalid',
      false,
      404
    );
  }
  const characterName =
    mode === 'roleplay' && anchor.kind === 'roleplay'
      ? await resolveCharacterName(projectId, anchor.sessionId)
      : undefined;
  let choices: AmplifierChoice[] | null = null;
  try {
    choices = await generateChoicesFromModel({
      projectId,
      mode,
      contextKey: turn.contextKey,
      sessionId: anchor.kind === 'roleplay' ? anchor.sessionId : undefined,
      excerpt: resolved.text,
      characterName,
    });
  } catch {
    // 再生成失敗時は failed のまま
  }
  return withProjectWriteLock(projectId, async () => {
    const current = await amplifier.readTurn(projectId, turn.turnId);
    if (!current || current.status === 'superseded' || current.status === 'consumed') {
      return { turn: current ?? turn, stale: true };
    }
    const next: AmplifierTurn = {
      ...current,
      status: choices && choices.length >= 3 ? 'ready' : 'failed',
      ...(choices ? { choices } : {}),
      ...(choices ? { errorCode: undefined } : {}),
      updatedAt: nowIso(),
    };
    const saved = await amplifier.writeTurn(projectId, next);
    return { turn: saved, stale: false };
  });
}

async function resolveCharacterName(projectId: string, sessionId: string): Promise<string | undefined> {
  const session = await storage.readRoleplaySession(projectId, sessionId);
  if (!session) return undefined;
  const characters = await storage.readCharacters(projectId);
  const character = characters.find((candidate) => candidate.characterId === session.characterId);
  return character?.name;
}

// --- 別の方向（設計書 8.3 / 7.4） ---

export async function createTurnAlternatives(input: {
  projectId: string;
  turnId: string;
  clientEventId: string;
  expectedTurnRevision: number;
}): Promise<CreateTurnResult> {
  const project = await amplifier.assertAmplifierProject(input.projectId);
  const mode = project.projectType === 'roleplay' ? 'roleplay' : 'novel';

  // 冪等チェック: 同じ clientEventId の alternatives リクエストが既にあれば、その結果を返す
  const existingEvent = await amplifier.findEventByClientId(input.projectId, input.clientEventId);
  if (existingEvent) {
    const oldTurn = await amplifier.readTurn(input.projectId, input.turnId);
    if (oldTurn) {
      const allTurns = await amplifier.readTurnsForContextKey(input.projectId, oldTurn.contextKey);
      const created = allTurns.find(
        (turn) => turn.supersedesTurnId === input.turnId && turn.createdAt >= oldTurn.updatedAt
      );
      if (created) {
        if (created.status === 'ready') return { turn: created, stale: false };
        if (created.status === 'failed') {
          return regenerateTurnChoices(input.projectId, created, created.anchor, mode);
        }
      }
    }
    // 作成途中で死んでいる場合は作り直す
  }

  const prepared = await withProjectWriteLock(input.projectId, async () => {
    const current = await amplifier.readTurn(input.projectId, input.turnId);
    if (!current) {
      throw new AmplifierChoiceError(
        'ターンが見つかりません。',
        'amplifier_turn_not_found',
        false,
        404
      );
    }
    if (current.revision !== input.expectedTurnRevision) {
      throw new AmplifierChoiceError(
        '選択肢が別の操作で更新されています。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }
    if (current.status === 'choices_pending') {
      throw new AmplifierChoiceError(
        '選択肢を生成中です。',
        'amplifier_turn_in_progress',
        true,
        409
      );
    }
    const notebook = await amplifier.readNotebook(input.projectId);
    const contextKey = current.contextKey;
    const sessionId = current.anchor.kind === 'roleplay' ? current.anchor.sessionId : undefined;
    await amplifier.recordInteractionUnlocked(input.projectId, {
      clientEventId: input.clientEventId,
      mode,
      type: 'choice_alternatives_requested',
      anchor: current.anchor,
      turnId: current.turnId,
      payload: { previousTurnId: current.turnId },
      // NOTE: 会話枠ごとのグローバル学習除外も反映する（設計書 14.2）。
      excludeFromGlobalLearning: await amplifier.resolveEventExcludeFromGlobalLearning(
        input.projectId,
        contextKey,
        notebook
      ),
      contextKey,
    });
    const superseded: AmplifierTurn = { ...current, status: 'superseded', updatedAt: nowIso() };
    await amplifier.writeTurn(input.projectId, superseded);
    const newTurn = amplifier.createEmptyTurn(
      input.projectId,
      contextKey,
      current.anchor,
      current.anchorTextHash,
      current.anchorExcerpt,
      current.turnId
    );
    const savedNewTurn = await amplifier.writeTurn(input.projectId, newTurn);
    return { newTurn: savedNewTurn, mode, sessionId };
  });

  const resolved = await amplifier.resolveEffectiveAnchorText(
    input.projectId,
    prepared.newTurn.anchor
  );
  const characterName =
    mode === 'roleplay' && prepared.newTurn.anchor.kind === 'roleplay'
      ? await resolveCharacterName(input.projectId, prepared.newTurn.anchor.sessionId)
      : undefined;

  let choices: AmplifierChoice[] | null = null;
  try {
    choices = await generateChoicesFromModel({
      projectId: input.projectId,
      mode,
      contextKey: prepared.newTurn.contextKey,
      sessionId: prepared.newTurn.anchor.kind === 'roleplay' ? prepared.newTurn.anchor.sessionId : undefined,
      excerpt: resolved.text,
      characterName,
    });
  } catch {
    // 生成失敗は failed ターンで表現
  }

  return withProjectWriteLock(input.projectId, async () => {
    const current = await amplifier.readTurn(input.projectId, prepared.newTurn.turnId);
    if (!current || current.status !== 'choices_pending') {
      return { turn: current ?? prepared.newTurn, stale: true };
    }
    const next: AmplifierTurn = {
      ...current,
      status: choices && choices.length >= 3 ? 'ready' : 'failed',
      ...(choices ? { choices } : {}),
      updatedAt: nowIso(),
    };
    const saved = await amplifier.writeTurn(input.projectId, next);
    return { turn: saved, stale: false };
  });
}

// --- 方向違い（設計書 7.4 / 13.1） ---

export async function recordDirectionRejection(input: {
  projectId: string;
  turnId: string;
  clientEventId: string;
  expectedTurnRevision: number;
  reason?: string;
}): Promise<void> {
  await amplifier.assertAmplifierProject(input.projectId);
  const existing = await amplifier.findEventByClientId(input.projectId, input.clientEventId);
  if (existing) return;
  await withProjectWriteLock(input.projectId, async () => {
    const turn = await amplifier.readTurn(input.projectId, input.turnId);
    if (!turn) {
      throw new AmplifierChoiceError(
        'ターンが見つかりません。',
        'amplifier_turn_not_found',
        false,
        404
      );
    }
    if (turn.revision !== input.expectedTurnRevision) {
      throw new AmplifierChoiceError(
        '選択肢が別の操作で更新されています。再読み込みしてください。',
        'amplifier_turn_stale',
        false,
        409
      );
    }
    const project = await storage.readProject(input.projectId);
    const notebook = await amplifier.readNotebook(input.projectId);
    await amplifier.recordInteractionUnlocked(input.projectId, {
      clientEventId: input.clientEventId,
      mode: project?.projectType === 'roleplay' ? 'roleplay' : 'novel',
      type: 'direction_rejected',
      anchor: turn.anchor,
      turnId: turn.turnId,
      payload: {
        turnId: turn.turnId,
        ...(input.reason ? { reason: input.reason.slice(0, 1000) } : {}),
      },
      // NOTE: 会話枠ごとのグローバル学習除外も反映する（設計書 14.2）。
      excludeFromGlobalLearning: await amplifier.resolveEventExcludeFromGlobalLearning(
        input.projectId,
        turn.contextKey,
        notebook
      ),
      contextKey: turn.contextKey,
    });
  });
}
