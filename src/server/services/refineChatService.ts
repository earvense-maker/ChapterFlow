import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { KeyedMutex } from '../utils/keyedMutex.js';
import * as storage from './storageService.js';
import { normalizeCharactersForStorage } from './projectService.js';
import { normalizeCharacterTraits } from '../../shared/characterSchema.js';
import { withProjectWriteLock } from './projectLock.js';
import {
  assertGenerationNotBlockedByMaintenance,
  MaintenanceInProgressError,
  maintenanceBlocksGeneration,
} from './refineAutomationGuard.js';
import { adapterMap } from '../adapters/index.js';
import { ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import {
  hasCompleteCanonicalWorldStructure,
  parseWorldMd,
} from '../utils/worldMd.js';
import { isRefineFindingDispositionAllowed } from '../../shared/refineFinding.js';
import { ensureFindingFingerprints } from './refineFindingFingerprint.js';
import {
  DATA_QUOTE_CONTRACT_LINE,
  dataLine,
  renderAnnotatedDataBlock,
  renderDataBlock,
  sanitizePromptLabel,
} from '../prompts/promptData.js';
import type {
  Character,
  CharacterFieldPatch,
  CharacterRole,
  Project,
  RefineApplyResponse,
  RefineChatRequest,
  RefineChatResponse,
  RefineConsultationNote,
  RefineConsultationNoteKind,
  RefineConsultationState,
  RefineConsultationTarget,
  RefineFindingDisposition,
  RefineFindingDispositionResponse,
  RefineFindingDispositionStatus,
  RefineMessage,
  RefinePatch,
  RefinePatchOperation,
  RefineResponseMode,
  RefineScanResult,
  RefineSession,
  RefineSuggestedAction,
  RefineTurnIntent,
  WorldAppendOp,
  WorldReplaceOp,
} from '../types/index.js';

// NOTE: 相談モードの visibleReply は複数案とその理由を含むため、旧「1〜3文」前提の
// 2000 では JSON が途中で切れてパース失敗になる。responseMode ごとに枠を変え、
// 要約更新ターンはさらに上乗せする（設計書 6.5）。
const OUTPUT_LENGTH_BY_MODE: Record<RefineResponseMode, number> = {
  auto: 3000,
  consult: 3000,
  'prepare-patch': 4000,
};
const SUMMARY_TURN_EXTRA_OUTPUT_LENGTH = 1200;
const TEMPERATURE = 0.55;
const TIMEOUT_MS = 90_000;
const MAX_HISTORY = 24;
const MAX_PATCHES_PER_TURN = 6;
const MAX_USER_MESSAGE_CHARS = 4000;
const MAX_VISIBLE_REPLY_CHARS = 6000;
const MAX_SUGGESTED_ACTIONS = 4;
const MAX_SUGGESTED_ACTION_LABEL_CHARS = 40;
const MAX_SUGGESTED_ACTION_MESSAGE_CHARS = 1000;
const MAX_NOTES_PER_TURN = 8;
const MAX_NOTE_TEXT_CHARS = 240;
const MAX_STORED_NOTES = 60;
const MAX_CONVERSATION_SUMMARY_CHARS = 1200;
// NOTE: プロンプトへ載せる履歴は直近10件のまま。それを超えて話が伸びたときに
// 採否の記憶を失わないよう、assistant 応答がこの件数を超えたターンから要約を更新する。
const SUMMARY_TRIGGER_ASSISTANT_COUNT = 12;
const MAX_ACTIVE_PREFERENCE_HYPOTHESES = 5;
const MAX_TARGET_LABEL_CHARS = 120;
// NOTE: 本文根拠の投入予算。全採用本文を毎ターン渡さない（設計書 2.2 / 6.2）。
// 優先順は finding の保存済み引用 → StoryState の関連項目 → 直近採用場面の抜粋。
// 前の段階で予算を使い切ったら後段は載せない。
const CONSULTATION_EVIDENCE_BUDGET_CHARS = 3000;
const CONSULTATION_SCENE_EXCERPT_CHARS = 700;
const CONSULTATION_MAX_SCENES = 2;
const CONSULTATION_MAX_STORY_STATE_LINES = 12;
const CHARACTER_ROLES: readonly CharacterRole[] = [
  'protagonist',
  'deuteragonist',
  'supporting',
  'other',
];
const NOTE_KINDS: readonly RefineConsultationNoteKind[] = [
  'confirmed',
  'candidate',
  'undecided',
  'preference-hypothesis',
];
const TURN_INTENTS: readonly RefineTurnIntent[] = [
  'explore',
  'clarify',
  'direct-edit',
  'prepare-patch',
];

const sessionMutex = new KeyedMutex();


export class RefineChatError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(message: string, code: string, retryable: boolean, status = 500) {
    super(message);
    this.name = 'RefineChatError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

// NOTE: fingerprint 導入前のキャッシュでも target 照合と disposition 保存ができるよう、
// 読み込み時に不足分を補ってから使う。
async function readScanWithFingerprints(projectId: string): Promise<RefineScanResult | null> {
  const scan = await storage.readRefineScan(projectId);
  return scan ? ensureFindingFingerprints(scan) : null;
}

function emptyConsultationState(): RefineConsultationState {
  return { notes: [], findingDispositions: [] };
}

function createFreshRefineSession(project: Project): RefineSession {
  const now = nowIso();
  return {
    schemaVersion: 3,
    sessionId: generateTimestampId('refsess'),
    projectId: project.projectId,
    usedModel: {
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
    },
    messages: [],
    patches: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    consultationState: emptyConsultationState(),
  };
}

export async function getOrCreateRefineSession(projectId: string): Promise<RefineSession> {
  const existing = await storage.readRefineSession(projectId);
  if (existing) return migrateRefineSession(existing);

  const project = await storage.readProject(projectId);
  if (!project) {
    throw new RefineChatError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const session = createFreshRefineSession(project);
  await storage.writeRefineSession(projectId, session);
  return session;
}

// NOTE: getOrCreateRefineSession は migration / 新規作成でファイルを書く。GET 経路が
// ロック無しでこれを呼ぶと、同時に走る自動レビュー run と lost update になり得る。
// 読み取り専用に見えるルートでも、書き込む可能性がある以上 session lock を通す。
export async function readRefineSessionForClient(projectId: string): Promise<RefineSession> {
  return withSessionLock(projectId, () => getOrCreateRefineSession(projectId));
}

async function migrateRefineSession(session: RefineSession): Promise<RefineSession> {
  if (session.schemaVersion === 3 && session.consultationState) return session;
  const now = nowIso();
  // NOTE: schema 1 → 2 の「保留パッチを stale にする」処理は world 保存形式の変更に
  // 紐づくので、1 から来た場合だけ適用する。2 → 3 は相談状態の追加だけで、既存の
  // messages / patches には手を触れない。
  const patches =
    session.schemaVersion === 1
      ? session.patches.map((patch) =>
          patch.status === 'pending'
            ? {
                ...patch,
                status: 'stale' as const,
                applyError:
                  '世界設定の保存形式が更新されたため、この古い保留パッチは適用できません。もう一度提案を作成してください。',
              }
            : patch
        )
      : session.patches;
  const migrated: RefineSession = {
    ...session,
    schemaVersion: 3,
    patches,
    // NOTE: 既存 assistant メッセージの suggestedActions / turnIntent は欠損のままでよい。
    // 過去ターンの候補ボタンはどのみち押せない（末尾メッセージだけが操作可能）。
    consultationState: session.consultationState ?? emptyConsultationState(),
    revision: session.revision + 1,
    updatedAt: now,
  };
  // NOTE: safeWriteJson の1回置換。失敗時は旧ファイルが残り、呼び出しは例外で終わる。
  // 中途半端に書き換えた session を返さない。
  await storage.writeRefineSession(session.projectId, migrated);
  return migrated;
}

export async function resetRefineSession(projectId: string): Promise<RefineSession> {
  return withSessionLock(projectId, async () => {
    await assertGenerationNotBlockedByMaintenance(projectId);
    // NOTE: 自動レビュー由来の patch (origin='auto-scan') は監査履歴の一部として
    // refineAutomation.json 側の run 記録と対で扱われる。chat 履歴をリセットしても
    // 監査を消してはいけないので、これらだけは新しい session へ引き継ぐ。
    // 参照する自動レビュー run の side に relate する system message も併せて残す
    // ことで、UI 側の orphan-run 描画が過去の履歴を失わずに済む。
    const [existing, project] = await Promise.all([
      storage.readRefineSession(projectId),
      storage.readProject(projectId),
    ]);
    if (!project) {
      throw new RefineChatError('作品が見つかりません。', 'project_not_found', false, 404);
    }
    const preservedPatches = existing
      ? existing.patches.filter((patch) => patch.origin === 'auto-scan')
      : [];
    const preservedRunIds = new Set(
      preservedPatches
        .map((p) => p.automationRunId)
        .filter((id): id is string => typeof id === 'string')
    );
    const preservedMessages = existing
      ? existing.messages.filter(
          (msg) => msg.automationRunId && preservedRunIds.has(msg.automationRunId)
        )
      : [];
    // NOTE: finding の判断（意図的な空白・解決済み）は「相談の履歴」ではなく作品への
    // 判断なので、履歴リセットで失わせない。一方 notes と conversationSummary は消した
    // messages そのものの要約なので、残すと存在しない会話を前提に相談が続いてしまう。
    const preservedDispositions = existing?.consultationState?.findingDispositions ?? [];
    const fresh = createFreshRefineSession(project);
    const merged: RefineSession = {
      ...fresh,
      messages: preservedMessages,
      patches: preservedPatches,
      consultationState: { notes: [], findingDispositions: preservedDispositions },
      revision: preservedPatches.length > 0 || preservedMessages.length > 0 ? 1 : 0,
    };
    // NOTE: delete→create の二段階にすると、2回目の保存失敗時に旧監査履歴まで失う。
    // safeWriteJson の置換を1回だけ行い、失敗時は既存sessionをそのまま残す。
    await storage.writeRefineSession(projectId, merged);
    return merged;
  });
}

export async function sendRefineMessage(
  projectId: string,
  request: RefineChatRequest
): Promise<RefineChatResponse> {
  const trimmed = request.content.trim();
  if (!trimmed) {
    throw new RefineChatError('メッセージが空です。', 'empty_message', false, 400);
  }
  if (trimmed.length > MAX_USER_MESSAGE_CHARS) {
    throw new RefineChatError(
      `メッセージは ${MAX_USER_MESSAGE_CHARS} 文字以内で入力してください。`,
      'message_too_long',
      false,
      400
    );
  }
  const responseMode = normalizeResponseMode(request.responseMode);
  // NOTE: scanning 中に手動相談を始めると、終了時に双方が同じ RefineSession を保存して
  // lost update になり得る。ここでは lease 正規化を含む preflight を行い、実際の
  // session 書き込みは既存の session lock で自動 run と直列化する。
  await assertGenerationNotBlockedByMaintenance(projectId);
  return withSessionLock(projectId, () =>
    sendRefineMessageUnlocked(projectId, trimmed, responseMode, request.target)
  );
}

async function sendRefineMessageUnlocked(
  projectId: string,
  userMessage: string,
  responseMode: RefineResponseMode,
  rawTarget: RefineConsultationTarget | undefined
): Promise<RefineChatResponse> {
  await reloadCredentials();

  const [session, project, worldText, characters, scan] = await Promise.all([
    getOrCreateRefineSession(projectId),
    storage.readProject(projectId),
    storage.readWorldPromptText(projectId),
    storage.readCharacters(projectId),
    // NOTE: クライアントは GET 側で補完された fingerprint を持って送ってくる。
    // ここで生の scan を読むと、fingerprint 導入前のキャッシュでは照合が必ず外れて
    // 旧データの気づきを相談できなくなる。読み取り経路をそろえる。
    readScanWithFingerprints(projectId),
  ]);
  if (!project) {
    throw new RefineChatError('作品が見つかりません。', 'project_not_found', false, 404);
  }

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) {
    throw new RefineChatError(
      `対応していないプロバイダーです: ${project.activeModelProvider}`,
      'unsupported_provider',
      false,
      400
    );
  }

  // NOTE: 不正な target はモデルを呼ぶ前に弾く。存在しない人物 ID などを
  // そのままプロンプトへ載せると、モデルが架空の対象について語り出す。
  const target = resolveConsultationTarget(rawTarget, characters, scan, session);

  const now = nowIso();
  const userMsg: RefineMessage = {
    messageId: generateTimestampId('msg'),
    role: 'user',
    content: userMessage,
    createdAt: now,
    responseMode,
    ...(target ? { target } : {}),
  };

  // NOTE: apply 済み以外のパッチは stale 扱いにしておく。ユーザーの新しい
  // 発話でパッチ体系が変わっているため、古い pending は履歴として残しても
  // 反映ボタンは押せない状態に。
  const stalePatches = session.patches.map((p) =>
    p.status === 'pending' ? { ...p, status: 'stale' as const } : p
  );

  const workingSession: RefineSession = {
    ...session,
    messages: truncateHistory([...session.messages, userMsg]),
    patches: stalePatches,
    revision: session.revision + 1,
    updatedAt: now,
    usedModel: {
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
    },
    lastError: null,
  };
  await storage.writeRefineSession(projectId, workingSession);

  const consultationState = workingSession.consultationState ?? emptyConsultationState();
  const assistantTurnCount = workingSession.messages.filter((m) => m.role === 'assistant').length;
  const needsSummaryUpdate = assistantTurnCount >= SUMMARY_TRIGGER_ASSISTANT_COUNT;

  const evidenceContext = await buildConsultationEvidence(project, target, characters, scan);

  const { systemInstructions, userPrompt } = buildChatPrompt({
    project,
    world: worldText,
    characters,
    history: workingSession.messages,
    userMessage,
    responseMode,
    target,
    consultationState,
    needsSummaryUpdate,
    scan,
    evidenceContext,
  });

  let adapterResult;
  try {
    adapterResult = await adapter.generateText({
      systemInstructions,
      userPrompt,
      outputLength:
        OUTPUT_LENGTH_BY_MODE[responseMode] +
        (needsSummaryUpdate ? SUMMARY_TURN_EXTRA_OUTPUT_LENGTH : 0),
      temperature: TEMPERATURE,
      timeoutMs: TIMEOUT_MS,
      modelName: project.activeModelName,
      // NOTE: 応答は JSON 前提。Structured Output で前置き文混入や思考モードでの
      // 空応答を減らす。
      responseMimeType: 'application/json',
    });
  } catch (err) {
    const errorSession = await writeSessionError(workingSession, err);
    if (err instanceof ModelAdapterError) {
      throw new RefineChatError(
        `モデル呼び出しに失敗しました: ${err.message}`,
        err.code,
        err.retryable,
        503
      );
    }
    // NOTE: 予期しないエラーは session に記録した上で再送出。UI 側でトースト表示。
    void errorSession;
    throw err;
  }

  if (adapterResult.finishReason === 'error' || adapterResult.finishReason === 'timeout') {
    await writeSessionError(workingSession, new Error(adapterResult.errorMessage || 'error'));
    throw new RefineChatError(
      adapterResult.errorMessage || 'モデルからの応答が得られませんでした。',
      adapterResult.errorCode || 'model_error',
      adapterResult.retryable,
      503
    );
  }

  const parsed = parseChatResult(adapterResult.text);
  const assistantMsg: RefineMessage = {
    messageId: generateTimestampId('msg'),
    role: 'assistant',
    content:
      truncate(parsed?.visibleReply?.trim() ?? '', MAX_VISIBLE_REPLY_CHARS) ||
      '（応答を解釈できませんでした。もう一度お伝えください）',
    createdAt: nowIso(),
    responseMode,
  };

  if (parsed?.freeText) {
    // NOTE: 自然文フォールバック。壊れた JSON 断片ではないと判定できた場合だけ
    // 本文として見せる。state / suggestedActions / patches は一切更新しない。
    const fallbackSession: RefineSession = {
      ...workingSession,
      messages: truncateHistory([...workingSession.messages, assistantMsg]),
      revision: workingSession.revision + 1,
      updatedAt: nowIso(),
      lastError: null,
    };
    await storage.writeRefineSession(projectId, fallbackSession);
    return { session: fallbackSession, assistantMessage: assistantMsg, newPatches: [] };
  }

  if (parsed) {
    assistantMsg.turnIntent = parsed.turnIntent;
    const suggestedActions = normalizeSuggestedActions(parsed.suggestedActions);
    if (suggestedActions.length > 0) assistantMsg.suggestedActions = suggestedActions;
    if (target) assistantMsg.target = target;
  }

  const newPatches: RefinePatch[] = [];
  const patchesAllowed = parsed ? shouldAcceptPatches(responseMode, parsed.turnIntent) : false;
  if (parsed && parsed.patches.length > 0 && !patchesAllowed) {
    console.warn('Refine chat patches discarded by response mode', {
      projectId,
      responseMode,
      turnIntent: parsed.turnIntent,
      discardedCount: parsed.patches.length,
    });
  }
  if (parsed && patchesAllowed) {
    for (const rawPatch of parsed.patches.slice(0, MAX_PATCHES_PER_TURN)) {
      const normalized = normalizePatch(rawPatch, assistantMsg.messageId, characters);
      if (normalized) newPatches.push(normalized);
    }
    if (newPatches.length > 0) {
      assistantMsg.patchIds = newPatches.map((p) => p.patchId);
    }
  }

  if (!parsed) {
    console.warn('Refine chat JSON parse failed', {
      projectId,
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
      finishReason: adapterResult.finishReason,
      debugInfo: adapterResult.debugInfo,
      textPreview: (adapterResult.text ?? '').slice(0, 400),
    });
  }

  const nextConsultationState = parsed
    ? applyConsultationStatePatch(consultationState, parsed, assistantMsg.messageId, {
        userMessage,
        needsSummaryUpdate,
      })
    : consultationState;

  const nextSession: RefineSession = {
    ...workingSession,
    messages: truncateHistory([...workingSession.messages, assistantMsg]),
    patches: [...workingSession.patches, ...newPatches],
    consultationState: nextConsultationState,
    revision: workingSession.revision + 1,
    updatedAt: nowIso(),
    lastError: parsed
      ? null
      : buildChatParseFailureMessage(
          adapterResult.text,
          adapterResult.debugInfo,
          adapterResult.finishReason
        ),
  };
  await storage.writeRefineSession(projectId, nextSession);

  return {
    session: nextSession,
    assistantMessage: assistantMsg,
    newPatches,
  };
}

// NOTE: パッチ可否の一次境界はクライアントが送る responseMode、二次境界がモデルの
// turnIntent（設計書 4.5）。auto + prepare-patch を通さないのは、パッチ作成の合意は
// クライアント側の明示操作でしか成立しないという一次境界を崩さないため。
export function shouldAcceptPatches(
  responseMode: RefineResponseMode,
  turnIntent: RefineTurnIntent | undefined
): boolean {
  if (responseMode === 'prepare-patch') return true;
  if (responseMode === 'auto') return turnIntent === 'direct-edit';
  return false;
}

export async function updateRefineFindingDisposition(
  projectId: string,
  fingerprint: string,
  status: RefineFindingDispositionStatus,
  note?: string
): Promise<RefineFindingDispositionResponse> {
  // NOTE: LLM を呼ばない更新だが、書き込む先は自動レビューと同じ RefineSession なので
  // 同じ session lock を通す。
  return withSessionLock(projectId, async () => {
    await assertRefineMutationNotBlockedUnlocked(projectId);
    const [session, scan] = await Promise.all([
      getOrCreateRefineSession(projectId),
      readScanWithFingerprints(projectId),
    ]);
    const finding = scan?.findings.find((f) => f.fingerprint === fingerprint);
    if (!finding) {
      throw new RefineChatError(
        'この気づきは最新の走査結果に見つかりませんでした。再走査してからお試しください。',
        'finding_not_found',
        false,
        404
      );
    }
    if (!isRefineFindingDispositionAllowed(finding, status)) {
      throw new RefineChatError(
        'この気づきにはその判断を保存できません。',
        'finding_disposition_not_allowed',
        false,
        400
      );
    }

    const disposition: RefineFindingDisposition = {
      fingerprint,
      status,
      updatedAt: nowIso(),
      ...(note?.trim() ? { note: truncate(note.trim(), MAX_NOTE_TEXT_CHARS) } : {}),
      // NOTE: deferred は走査単位、resolved は設定内容単位で失効させる。判断した時点の
      // 識別子を一緒に残さないと、いつ再表示すべきかを後から決められない。
      ...(status === 'deferred' ? { scanGeneratedAt: scan?.generatedAt ?? null } : {}),
      ...(status === 'resolved'
        ? { staticInputHash: scan?.reviewedStaticInputHash ?? null }
        : {}),
    };

    const state = session.consultationState ?? emptyConsultationState();
    const nextSession: RefineSession = {
      ...session,
      consultationState: {
        ...state,
        findingDispositions: [
          ...state.findingDispositions.filter((d) => d.fingerprint !== fingerprint),
          disposition,
        ],
      },
      revision: session.revision + 1,
      updatedAt: nowIso(),
    };
    await storage.writeRefineSession(projectId, nextSession);
    return { session: nextSession, disposition };
  });
}

export async function applyRefinePatch(
  projectId: string,
  patchId: string
): Promise<RefineApplyResponse> {
  return withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, () => applyRefinePatchUnlocked(projectId, patchId))
  );
}

async function applyRefinePatchUnlocked(
  projectId: string,
  patchId: string
): Promise<RefineApplyResponse> {
  await assertRefineMutationNotBlockedUnlocked(projectId);
  const storedSession = await storage.readRefineSession(projectId);
  if (!storedSession) {
    throw new RefineChatError('セッションがありません。', 'session_not_found', false, 404);
  }
  const session = await migrateRefineSession(storedSession);
  const patchIndex = session.patches.findIndex((p) => p.patchId === patchId);
  if (patchIndex < 0) {
    throw new RefineChatError('パッチが見つかりません。', 'patch_not_found', false, 404);
  }
  const patch = session.patches[patchIndex];
  if (patch.status !== 'pending') {
    throw new RefineChatError(
      `このパッチは既に ${patch.status} 状態です。`,
      'patch_not_pending',
      false,
      409
    );
  }

  // NOTE: draft、または draft を含む mixed 根拠の auto patch は、対応する生成案が
  // 採用されるまで手動 apply でも通さない（設計書 4.3 / 7.1）。mixed でも source
  // generation が残っている場合は draft 由来を否定できないため保守的に扱う。
  const requiresAcceptedSource =
    patch.origin === 'auto-scan' &&
    (patch.evidenceScope === 'draft' ||
      (patch.evidenceScope === 'mixed' && patch.sourceGenerationId !== undefined));
  if (requiresAcceptedSource) {
    if (!patch.sourceGenerationId) {
      throw new RefineChatError(
        '根拠となる生成案が特定できないため、このパッチは適用できません。',
        'patch_source_generation_missing',
        false,
        409
      );
    }
    const sourceGeneration = await storage.findGenerationRecord(projectId, patch.sourceGenerationId);
    if (!sourceGeneration || sourceGeneration.status !== 'accepted') {
      throw new RefineChatError(
        '根拠となる生成案がまだ採用されていません。採用後にもう一度お試しください。',
        'patch_source_generation_not_accepted',
        false,
        409
      );
    }
  }

  if (patch.origin === 'auto-scan' && patch.automationRunId) {
    const run = (await storage.readRefineAutomation(projectId))?.runs.find(
      (candidate) => candidate.runId === patch.automationRunId
    );
    if (!run || run.status === 'stale') {
      throw new RefineChatError(
        'この自動レビューは既に古くなったため、パッチを適用できません。',
        'automation_patch_stale',
        false,
        409
      );
    }
  }

  const [originalWorldText, characters] = await Promise.all([
    storage.readWorldText(projectId),
    storage.readCharacters(projectId),
  ]);

  const applied = applyPatchOperationsToSnapshot(originalWorldText, characters, patch.operations);
  if (!applied.ok) {
    return recordApplyError(session, patchIndex, applied.error);
  }
  const { worldText: nextWorldText, characters: normalizedCharacters, worldChanged, charactersChanged } =
    applied;

  const nowStr = nowIso();
  const appliedPatch: RefinePatch = {
    ...patch,
    status: 'applied',
    appliedAt: nowStr,
    applyError: undefined,
  };
  const nextPatches = [...session.patches];
  nextPatches[patchIndex] = appliedPatch;
  const nextSession: RefineSession = {
    ...session,
    patches: nextPatches,
    revision: session.revision + 1,
    updatedAt: nowStr,
    lastError: null,
  };
  try {
    if (worldChanged) await storage.writeWorld(projectId, parseWorldMd(nextWorldText));
    if (charactersChanged) await storage.writeCharacters(projectId, normalizedCharacters);
    await storage.writeRefineSession(projectId, nextSession);
  } catch (error) {
    // NOTE: world / characters / session は別ファイルなので、後段失敗時は読み込み時の
    // スナップショットへ戻し、パッチだけが部分適用された状態を残さない。
    const rollbackResults = await Promise.allSettled([
      ...(worldChanged ? [storage.restoreWorldText(projectId, originalWorldText)] : []),
      ...(charactersChanged ? [storage.writeCharacters(projectId, characters)] : []),
      storage.writeRefineSession(projectId, session),
    ]);
    if (rollbackResults.some((result) => result.status === 'rejected')) {
      console.error('Refine patch rollback failed', { projectId, patchId });
    }
    throw error;
  }

  return { session: nextSession, patch: appliedPatch };
}

export async function rejectRefinePatch(
  projectId: string,
  patchId: string
): Promise<RefineApplyResponse> {
  return withSessionLock(projectId, () =>
    withProjectWriteLock(projectId, async () => {
      await assertRefineMutationNotBlockedUnlocked(projectId);
    const storedSession = await storage.readRefineSession(projectId);
    if (!storedSession) {
      throw new RefineChatError('セッションがありません。', 'session_not_found', false, 404);
    }
    const session = await migrateRefineSession(storedSession);
    const patchIndex = session.patches.findIndex((p) => p.patchId === patchId);
    if (patchIndex < 0) {
      throw new RefineChatError('パッチが見つかりません。', 'patch_not_found', false, 404);
    }
    if (session.patches[patchIndex].status !== 'pending') {
      throw new RefineChatError(
        `このパッチは既に ${session.patches[patchIndex].status} 状態です。`,
        'patch_not_pending',
        false,
        409
      );
    }
    const nowStr = nowIso();
    const rejected: RefinePatch = {
      ...session.patches[patchIndex],
      status: 'rejected',
      appliedAt: nowStr,
    };
    const nextPatches = [...session.patches];
    nextPatches[patchIndex] = rejected;
    const nextSession: RefineSession = {
      ...session,
      patches: nextPatches,
      revision: session.revision + 1,
      updatedAt: nowStr,
    };
    await storage.writeRefineSession(projectId, nextSession);
      return { session: nextSession, patch: rejected };
    })
  );
}

async function assertRefineMutationNotBlockedUnlocked(projectId: string): Promise<void> {
  const maintenance = (await storage.readState(projectId))?.refineMaintenance;
  if (maintenanceBlocksGeneration(maintenance?.phase)) {
    throw new MaintenanceInProgressError();
  }
}

// ---------- ヘルパー ----------

async function recordApplyError(
  session: RefineSession,
  patchIndex: number,
  errorMessage: string
): Promise<RefineApplyResponse> {
  const nowStr = nowIso();
  const failed: RefinePatch = {
    ...session.patches[patchIndex],
    applyError: errorMessage,
  };
  const nextPatches = [...session.patches];
  nextPatches[patchIndex] = failed;
  const nextSession: RefineSession = {
    ...session,
    patches: nextPatches,
    revision: session.revision + 1,
    updatedAt: nowStr,
    lastError: errorMessage,
  };
  await storage.writeRefineSession(session.projectId, nextSession);
  throw new RefineChatError(errorMessage, 'patch_apply_failed', false, 422);
}

interface WorldApplyOk {
  ok: true;
  text: string;
}
interface WorldApplyErr {
  ok: false;
  error: string;
}

// NOTE: アンカー式置換。anchor が本文中にちょうど 1 回だけ現れる必要がある。
// 0 回: 対象が見つからない（多分 world が編集された）。エラー。
// 2 回以上: 曖昧すぎて別の場所を書き換える危険。エラーで返し、
// AI に「もっと固有な文字列で anchor を絞る」よう次周で伝える。
export function applyWorldReplace(
  world: string,
  op: WorldReplaceOp
): WorldApplyOk | WorldApplyErr {
  const anchor = op.anchor;
  if (!anchor.trim()) {
    return { ok: false, error: '置換対象（anchor）が空です。' };
  }
  const first = world.indexOf(anchor);
  if (first < 0) {
    return {
      ok: false,
      error: `置換対象の文字列を世界設定内で特定できませんでした（anchor: "${truncate(anchor, 60)}"）`,
    };
  }
  const second = world.indexOf(anchor, first + 1);
  if (second >= 0) {
    return {
      ok: false,
      error: `置換対象が複数箇所に一致しました。より固有な文字列で指定してください（anchor: "${truncate(anchor, 60)}"）`,
    };
  }
  return {
    ok: true,
    text: world.slice(0, first) + op.replacement + world.slice(first + anchor.length),
  };
}

export function applyWorldAppend(worldText: string, op: WorldAppendOp): string {
  const suffix = op.text.trim();
  if (!suffix) return worldText;
  return worldText.trim() ? `${worldText.trimEnd()}\n\n${suffix}\n` : suffix;
}

export interface ApplyOperationsResult {
  ok: true;
  worldText: string;
  characters: Character[];
  worldChanged: boolean;
  charactersChanged: boolean;
}
export interface ApplyOperationsFailure {
  ok: false;
  error: string;
}

// NOTE: 手動チャットの patch 適用 (applyRefinePatchUnlocked) と自動レビュー
// (refineAutomationService) の両方から呼ばれる共有ロジック。副作用（I/O・throw）を
// 持たない純粋関数とし、失敗は例外ではなく ok:false で返す。アンカー0/複数マッチ・
// 対象人物不在・カノニカル世界構造の破壊は、ここが正本の検出場所。
export function applyPatchOperationsToSnapshot(
  worldText: string,
  characters: Character[],
  operations: RefinePatchOperation[]
): ApplyOperationsResult | ApplyOperationsFailure {
  let nextWorldText = worldText;
  let nextCharacters = [...characters];
  let charactersChanged = false;

  for (const op of operations) {
    switch (op.kind) {
      case 'world-replace': {
        const applied = applyWorldReplace(nextWorldText, op.op);
        if (!applied.ok) {
          return { ok: false, error: applied.error };
        }
        nextWorldText = applied.text;
        break;
      }
      case 'world-append': {
        nextWorldText = applyWorldAppend(nextWorldText, op.op);
        break;
      }
      case 'character-update': {
        const idx = nextCharacters.findIndex((c) => c.characterId === op.characterId);
        if (idx < 0) {
          return { ok: false, error: `人物が見つかりません: ${op.characterId}` };
        }
        nextCharacters[idx] = { ...nextCharacters[idx], ...op.fields };
        charactersChanged = true;
        break;
      }
      case 'character-add': {
        if (nextCharacters.some((c) => c.characterId === op.character.characterId)) {
          return { ok: false, error: `同じ ID の人物が既にいます: ${op.character.characterId}` };
        }
        nextCharacters = [...nextCharacters, op.character];
        charactersChanged = true;
        break;
      }
      case 'character-remove': {
        const before = nextCharacters.length;
        nextCharacters = nextCharacters.filter((c) => c.characterId !== op.characterId);
        if (nextCharacters.length === before) {
          return { ok: false, error: `削除対象の人物が見つかりません: ${op.characterId}` };
        }
        charactersChanged = true;
        break;
      }
    }
  }

  const worldChanged = nextWorldText !== worldText;
  if (worldChanged) {
    if (
      hasCompleteCanonicalWorldStructure(worldText) &&
      !hasCompleteCanonicalWorldStructure(nextWorldText)
    ) {
      return {
        ok: false,
        error: 'world パッチ適用でカノニカル見出しが壊れました。anchor を見直してください。',
      };
    }
  }
  // NOTE: 全書き込み境界で共通正規化を通す（review §5.4）。ここを迂回すると
  // roleplay 型プロジェクトで greeting/dialogueExamples の上限が保証されない。
  const normalizedCharacters = charactersChanged
    ? normalizeCharactersForStorage(nextCharacters)
    : characters;

  return {
    ok: true,
    worldText: nextWorldText,
    characters: normalizedCharacters,
    worldChanged,
    charactersChanged,
  };
}

async function writeSessionError(session: RefineSession, err: unknown): Promise<RefineSession> {
  const nextSession: RefineSession = {
    ...session,
    lastError: err instanceof Error ? err.message : String(err),
    revision: session.revision + 1,
    updatedAt: nowIso(),
  };
  await storage.writeRefineSession(session.projectId, nextSession);
  return nextSession;
}

// NOTE: refineAutomationService も同じ 24 件上限を適用するため export する。
export function truncateHistory(messages: RefineMessage[]): RefineMessage[] {
  if (messages.length <= MAX_HISTORY) return messages;
  return messages.slice(-MAX_HISTORY);
}

// ---------- プロンプト構築 ----------

interface BuildChatPromptInput {
  project: Project;
  world: string;
  characters: Character[];
  history: RefineMessage[];
  userMessage: string;
  responseMode: RefineResponseMode;
  target: RefineConsultationTarget | null;
  consultationState: RefineConsultationState;
  needsSummaryUpdate: boolean;
  scan: RefineScanResult | null;
  evidenceContext: string | null;
}

const PATCH_OPERATION_SCHEMA_LINES = [
  '      "operations": [',
  '        { "kind": "world-replace", "anchor": "既存 world の中の一意な原文", "replacement": "書き換え後の文字列" },',
  '        { "kind": "world-append", "text": "世界設定に付け足す段落（world がほぼ空か新規追加時のみ）" },',
  '        { "kind": "character-update", "characterId": "<既存のid>", "fields": { "description": "...", "traits": [{ "label": "こだわり", "text": "..." }] } },',
  '        { "kind": "character-add", "character": { "characterId": "char-<slug>", "name": "...", "role": "protagonist|deuteragonist|supporting|other", "description": "...", "traits": [{ "label": "動機", "text": "..." }] } },',
  '        { "kind": "character-remove", "characterId": "<既存のid>" }',
  '      ]',
];

const PATCH_OPERATION_RULES = [
  '- world-replace の anchor は、必ず入力の world 本文中にちょうど 1 回だけ現れる文字列にすること。同じ文字列が複数箇所にある場合は前後の文をつなげて一意にする。',
  '- world-replace の anchor に `## 世界の土台` / `## 開始時点の状況` の見出し行そのものは含めない。これらを削除・書き換えるパッチは失敗する。',
  '- world-append は開始時点の状況セクションの末尾に追記される。',
  '- world 全文の書き換えは絶対にしない。変更したい箇所だけを anchor / replacement で示す。',
  '- character-update の characterId は必ず入力の <人物> セクションから引く。',
  '- character の currentState は物語/会話の開始時点の状態である。進行中の状態を上書きする用途には使わない。',
  '- character-add の characterId は "char-" で始まる短い ID を新規に生成する（例: "char-yamada"）。',
  `- patches の数は 1 ターンあたり最大 ${MAX_PATCHES_PER_TURN} 個まで。`,
];

export function buildChatPrompt(input: BuildChatPromptInput): {
  systemInstructions: string;
  userPrompt: string;
} {
  const { responseMode } = input;
  const patchesAllowed = responseMode !== 'consult';

  const lines: string[] = [
    'あなたは、既にある作品の設定を作者と一緒に育てる相談相手です。',
    '設定を機械的に書き換える編集係ではありません。まず現在の設定を読み、この作品固有の言葉で話してください。',
    '',
    '■ 相談の姿勢',
    '- 現在の世界設定と人物設定を先に読み、その作品の固有名詞・関係・雰囲気を使って返す。',
    '- ユーザーの発話を言い換えるだけで終わらない。必ず一歩進んだ見立てか具体案を添える。',
    '- 質問だけで返さない。確認したいことがあっても、少なくとも一つの具体案または見立てを一緒に出す。',
    '- 方向が曖昧なときは、違いのはっきりした2〜3案を短く並べ、それぞれ何が変わるかを書く。案は混ぜてよいと伝える。',
    '- 今の設定の良さも言葉にする。変更で失われそうなものがあれば正直に書く。',
    '- 一度に論点を広げすぎない。最後に次に話すとよい話題を一つだけ提案する。',
    '- ユーザーが直接的な変更だけを求めているときは、不要な相談を強制しない。',
    '',
    '■ 真意の読み取り',
    'ユーザーの言葉の背後にあるものを、次の層で考えてください。',
    '1. 直接の変更対象（性格・口調・背景・関係など）',
    '2. 求めている物語上の効果（緊張・親密さ・危うさ・意外性など）',
    '3. 守りたい既存の魅力（優しさ・余白・テンポ・読後感など）',
    '',
    'ただし断定はしません。守ること:',
    '- 「あなたの本当の望みは〜です」と言い切らない。「もしかすると〜でしょうか」の形にする。',
    '- 推測は推測、ユーザーが明言したことは明言したこととして、文中で区別する。',
    '- ユーザー本人の心理状態・性格・個人的な属性は推測しない。対象はあくまで作品である。',
    '- 確度が低いときは一案に絞らず、A/B/C の複数案にする。確度が高くても仮説の形は保ち、具体案まで進める。',
    '- 確認の質問だけでターンを終わらせない。',
    '',
    '■ 空欄の扱い',
    '- 空欄をすべて欠陥として埋めようとしない。意図的な余白も正当な選択として尊重する。',
    '- 人物に固定の項目一式を要求しない。その作品を動かすのに必要な軸だけを提案する。',
    '',
    '■ 出力 JSON',
    '出力は次のスキーマの JSON だけを返してください。',
    '```json',
    '{',
    '  "visibleReply": "ユーザーへ見せる自然な相談返答（Markdownの段落・箇条書き・**太字** は使ってよい）",',
    `  "turnIntent": "${TURN_INTENTS.join(' | ')}",`,
    '  "suggestedActions": [',
    '    { "label": "ボタンの短い見出し", "message": "押したとき次のユーザー発話として送る文", "responseMode": "consult | prepare-patch" }',
    '  ],',
    '  "consultationStatePatch": {',
    '    "add": [{ "kind": "confirmed | candidate | undecided | preference-hypothesis", "text": "短い1行" }],',
    '    "archiveIds": ["もう有効でなくなった既存メモのID"]',
    '  },',
    ...(input.needsSummaryUpdate ? ['  "conversationSummary": "これまでの相談の要約（後述）",'] : []),
    '  "patches": []',
    '}',
    '```',
    '',
    '■ turnIntent の選び方',
    '- explore: 方向を一緒に探している。複数案を出した、見立てを述べた。',
    '- clarify: ユーザーの意図を仮説として確かめている（ただし具体案も添えること）。',
    '- direct-edit: ユーザーが具体的な変更内容を明示して指示した（例「年齢を28歳にして」）。',
    '- prepare-patch: 相談で固まった方向を変更候補としてまとめた。',
    '',
    '■ suggestedActions',
    `- 0〜${MAX_SUGGESTED_ACTIONS} 件。label は ${MAX_SUGGESTED_ACTION_LABEL_CHARS} 字以内、message は短い定型文にする。`,
    '- 例: 「この解釈が近い」「少し違う」「AとBを混ぜる」「別の案を見る」「あえて未設定にする」「この方向で変更候補を作る」。',
    '- 変更候補を作る提案だけ responseMode を "prepare-patch" にする。それ以外は "consult"。',
    '',
    '■ consultationStatePatch',
    '- confirmed: ユーザーが明言した、または明示的に採用した内容だけ。',
    '- candidate: あなたの提案、まだ確認されていない真意の仮説。',
    '- undecided: 今は決めない、本文で自然に決める、意図的に余白として残すと決めた内容。',
    '- preference-hypothesis: この作品の相談内で見えてきた作者の好みの傾向（例「単純な悪人にはしたくない」）。',
    `- add は 1 ターン最大 ${MAX_NOTES_PER_TURN} 件、各 ${MAX_NOTE_TEXT_CHARS} 字以内。ID や日時は書かない（システムが付ける）。`,
    '- ユーザーが今回のターンで明示的に採用していないものを confirmed にしない。',
  ];

  if (input.needsSummaryUpdate) {
    lines.push(
      '',
      '■ conversationSummary（このターンは更新してください）',
      `- ${MAX_CONVERSATION_SUMMARY_CHARS} 字以内。既存の要約を踏まえて書き直す。`,
      '- 含めるもの: 採用した方向と理由、却下した方向と理由、意図的に未確定にした内容、この作品内だけの好みの仮説。',
      '- 含めないもの: APIキー・ファイルパス・内部プロンプト、作品本文の長い引用、ユーザー個人の属性に関する推測。',
      '- 古くなった preference-hypothesis はここへ畳み込み、archiveIds に入れる。'
    );
  }

  lines.push('', '■ パッチ（変更候補）');
  if (patchesAllowed) {
    lines.push(
      ...(responseMode === 'prepare-patch'
        ? [
            '今回は「この方向で変更候補を作る」が選ばれています。合意できている内容から変更候補を作ってください。',
            'visibleReply には必ず次を書く:',
            '- 何を変更候補にしたか',
            '- なぜ現在の作品に合うか',
            '- まだ未確定として残した点',
            '- この変更で失われる可能性がある要素',
            'summary と operations だけを返して説明を省略しない。',
            '安全な差分を作れない、合意内容が足りない、または既に同じ内容になっている場合は "patches": [] を返し、その理由と次にできることを visibleReply に書く。',
          ]
        : [
            '今回は通常の相談です。パッチを作るのは、ユーザーが具体的な変更内容を明示して指示した場合だけです。',
            'その場合は turnIntent を "direct-edit" にし、patches を返してください。',
            'それ以外（方向を探している、仮説を確かめている段階）では必ず "patches": [] を返します。急いで差分にしない。',
          ]),
      '',
      'パッチのスキーマ:',
      '```json',
      '{ "patches": [ {',
      '      "summary": "このパッチが何をするかの1行説明",',
      ...PATCH_OPERATION_SCHEMA_LINES,
      '} ] }',
      '```',
      ...PATCH_OPERATION_RULES
    );
  } else {
    lines.push(
      '今回は相談だけのターンです。"patches" は必ず空配列 [] を返してください。',
      'ここでパッチを返してもシステム側で破棄されます。変更したい方向が固まったら、',
      'suggestedActions に responseMode "prepare-patch" のボタンを添えて、ユーザーに変更候補の作成を選んでもらってください。'
    );
  }

  lines.push(
    '',
    '■ 安全境界',
    '- 人物の重大な過去、秘密、事件の真相、人物の削除は、ユーザーが明示的に依頼したときだけパッチにする。',
    '- 本文に根拠のない創作は「候補」と分かる書き方にし、既に決まっている事実のように書かない。',
    `- ${DATA_QUOTE_CONTRACT_LINE}`,
    '',
    '- 出力は JSON 1 つのみ。前後に挨拶や解説を書かない。'
  );

  const systemInstructions = lines.join('\n');

  const historyForPrompt = input.history
    .filter((m) => m.role !== 'system')
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${m.content}`)
    .join('\n\n');

  // NOTE: 作品データ・会話データは必ず renderDataBlock 経由で入れる。全行が `> ` の
  // 引用行になるので、データ中の `---` や `【指示】` がトップレベルの区画と一致せず、
  // 新しい指示区画として解釈されない（promptData.ts の方針をそのまま使う）。
  const sections = [
    renderDataBlock(
      '【現在の作品情報】',
      [
        dataLine('タイトル', input.project.title),
        dataLine(
          '作品種別',
          input.project.projectType === 'roleplay' ? 'ロールプレイ（会話）' : '小説'
        ),
      ]
        .filter(Boolean)
        .join('\n')
    ),
    renderDataBlock('【現在の world（設定原文）】', input.world.trim() || '（未設定）'),
    renderDataBlock('【現在の characters】', renderCharactersForPrompt(input.characters)),
  ];

  const targetSection = renderConsultationTarget(input.target, input.characters, input.scan);
  if (targetSection) sections.push(renderDataBlock('【今回の相談対象】', targetSection));

  if (input.evidenceContext) {
    sections.push(
      renderAnnotatedDataBlock(
        '【本文・物語状態からの根拠】',
        ['ここに引用された本文は既に確定した事実である。ここに無い内容は候補として扱う。'],
        input.evidenceContext
      )
    );
  }

  const summary = input.consultationState.conversationSummary?.trim();
  if (summary) sections.push(renderDataBlock('【これまでの相談の要約】', summary));

  const notesSection = renderConsultationNotes(input.consultationState.notes);
  if (notesSection) sections.push(renderDataBlock('【相談で整理済みの内容】', notesSection));

  sections.push(
    renderDataBlock('【これまでのやり取り（直近まで）】', historyForPrompt || '（新規セッション）'),
    renderDataBlock('【今回のユーザー発話】', input.userMessage),
    // NOTE: モードと締めの一文はデータではなく、あなたへの指示なので引用しない。
    `【今回のモード】${describeResponseMode(responseMode)}`,
    '以上を踏まえて、指定 JSON スキーマだけで応答してください。'
  );

  return { systemInstructions, userPrompt: sections.filter(Boolean).join('\n\n') };
}

// NOTE: 設定だけでは足りない相談（人物の背景、本文との矛盾）のために、限定された
// 本文根拠を組み立てる。対象が人物か finding のときだけ働き、それ以外では null を
// 返して従来どおり設定だけで相談する。roleplay は StoryState を正本にしないので除く。
export async function buildConsultationEvidence(
  project: Project,
  target: RefineConsultationTarget | null,
  characters: Character[],
  scan: RefineScanResult | null
): Promise<string | null> {
  if (!target || project.projectType === 'roleplay') return null;
  if (target.kind !== 'character' && target.kind !== 'finding') return null;

  const finding =
    target.kind === 'finding' ? (scan?.findings.find((f) => f.id === target.findingId) ?? null) : null;
  const findingCharacterId =
    finding && finding.target.kind === 'character' ? finding.target.characterId : null;
  const focusCharacterId = target.kind === 'character' ? target.characterId : findingCharacterId;
  const focusCharacter = focusCharacterId
    ? (characters.find((c) => c.characterId === focusCharacterId) ?? null)
    : null;

  let budget = CONSULTATION_EVIDENCE_BUDGET_CHARS;
  const sections: string[] = [];

  const storyState = await storage.readStoryState(project.projectId);
  const storyLines = selectStoryStateLines(storyState, focusCharacter);
  if (storyLines.length > 0) {
    const block = ['現在の物語状態（関連分のみ）:', ...storyLines].join('\n');
    if (block.length <= budget) {
      sections.push(block);
      budget -= block.length;
    }
  }

  // NOTE: finding が根拠に挙げた場面だけを読む。全採用本文の走査はしない。
  const evidence = (finding?.evidence ?? []).slice(0, CONSULTATION_MAX_SCENES);
  for (const item of evidence) {
    if (budget <= 0) break;
    const record = await storage.findGenerationRecord(project.projectId, item.generationId);
    // NOTE: 未採用の下書きは根拠にしない。採用済みだけを既出の事実として扱う。
    if (!record || record.status !== 'accepted') continue;
    const excerpt = extractExcerptAround(record.responseText, item.quote);
    const block = [`採用済み本文の抜粋（場面 ${item.sceneId}）:`, excerpt].join('\n');
    if (block.length > budget) continue;
    sections.push(block);
    budget -= block.length;
  }

  return sections.length > 0 ? sections.join('\n\n') : null;
}

function selectStoryStateLines(
  storyState: Awaited<ReturnType<typeof storage.readStoryState>>,
  focusCharacter: Character | null
): string[] {
  if (!storyState) return [];
  const names = focusCharacter
    ? [focusCharacter.name, ...(focusCharacter.aliases ?? [])].filter(Boolean)
    : [];
  const mentionsFocus = (text: string) =>
    names.length === 0 || names.some((name) => text.includes(name));

  const lines: string[] = [];
  for (const state of storyState.characterStates) {
    if (names.length > 0 && !names.includes(state.name)) continue;
    const extras: string[] = [];
    if (state.knowledge.length) extras.push(`知っていること: ${state.knowledge.join(' / ')}`);
    if (state.relationships.length) extras.push(`関係: ${state.relationships.join(' / ')}`);
    lines.push(
      `- ${state.name}: ${state.currentState}${extras.length ? `（${extras.join(' / ')}）` : ''}`
    );
  }
  for (const event of storyState.importantEvents) {
    if (event.status === 'archived') continue;
    if (!mentionsFocus(event.summary)) continue;
    lines.push(`- 出来事: ${event.summary}`);
  }
  for (const thread of storyState.openThreads) {
    if (thread.status !== 'active') continue;
    if (!mentionsFocus(thread.summary)) continue;
    lines.push(`- 未解決: ${thread.summary}`);
  }
  return lines.slice(0, CONSULTATION_MAX_STORY_STATE_LINES);
}

// NOTE: 引用の周辺だけを切り出す。引用が見つからない場合（本文が編集された等）は
// 冒頭を使い、本文全体は渡さない。
function extractExcerptAround(text: string, quote: string): string {
  const index = quote ? text.indexOf(quote) : -1;
  if (index < 0) return truncate(text, CONSULTATION_SCENE_EXCERPT_CHARS);
  const margin = Math.max(0, Math.floor((CONSULTATION_SCENE_EXCERPT_CHARS - quote.length) / 2));
  const start = Math.max(0, index - margin);
  const end = Math.min(text.length, index + quote.length + margin);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function describeResponseMode(mode: RefineResponseMode): string {
  switch (mode) {
    case 'consult':
      return 'consult（相談のみ。パッチは作らない）';
    case 'prepare-patch':
      return 'prepare-patch（合意内容から変更候補を作る）';
    case 'auto':
      return 'auto（通常送信。明示的な変更依頼のときだけ direct-edit としてパッチを作る）';
  }
}

// NOTE: 相談対象ラベルは改行・制御文字を落としてから載せる。プロンプト内の
// セクション見出しを偽装されないようにするため（設計書 7.4）。
function sanitizeTargetLabel(value: string): string {
  // NOTE: 相談対象は文の中へ埋め込むので、共通の sanitizePromptLabel で改行と制御文字を
  // 落として必ず1行にする。ブロック全体は renderDataBlock が引用行にするので、
  // ここでの役割は「1行に保つ」と「長さを抑える」だけ。
  return truncate(sanitizePromptLabel(value), MAX_TARGET_LABEL_CHARS);
}

function renderConsultationTarget(
  target: RefineConsultationTarget | null,
  characters: Character[],
  scan: RefineScanResult | null
): string | null {
  if (!target || target.kind === 'general') return null;
  switch (target.kind) {
    case 'world':
      return target.section === 'foundation'
        ? '世界設定のうち「世界の土台」について'
        : target.section === 'initialSituation'
          ? '世界設定のうち「開始時点の状況」について'
          : '世界設定について';
    case 'character': {
      const character = characters.find((c) => c.characterId === target.characterId);
      const name = sanitizeTargetLabel(character?.name || target.characterId);
      return target.field
        ? `人物「${name}」の ${sanitizeTargetLabel(target.field)} について`
        : `人物「${name}」について`;
    }
    case 'finding': {
      const finding = scan?.findings.find((f) => f.id === target.findingId);
      if (!finding) return '設定走査で挙がった気づきについて';
      const lines = [
        `設定走査で挙がった気づき（${finding.kind}）: ${sanitizeTargetLabel(finding.message)}`,
      ];
      if (finding.detail) lines.push(`補足: ${sanitizeTargetLabel(finding.detail)}`);
      if (finding.suggestedFix) {
        lines.push(`走査時の提案: ${sanitizeTargetLabel(finding.suggestedFix)}`);
      }
      for (const evidence of finding.evidence ?? []) {
        lines.push(`根拠（採用済み本文の抜粋）: 「${sanitizeTargetLabel(evidence.quote)}」`);
      }
      return lines.join('\n');
    }
    case 'patch':
      return '直前に作った変更候補の調整について';
  }
}

function renderConsultationNotes(notes: RefineConsultationNote[]): string | null {
  const active = notes.filter((n) => n.status === 'active');
  if (active.length === 0) return null;
  const labels: Record<RefineConsultationNoteKind, string> = {
    confirmed: '確定（ユーザーの明言）',
    candidate: '候補（未確認の提案・仮説）',
    undecided: '意図的に未確定',
    'preference-hypothesis': 'この作品での好みの傾向（仮説）',
  };
  const lines: string[] = [];
  for (const kind of NOTE_KINDS) {
    // NOTE: 好み仮説だけは古いものを落とす。全部載せると会話が古い推測に引きずられる。
    const items =
      kind === 'preference-hypothesis'
        ? active.filter((n) => n.kind === kind).slice(-MAX_ACTIVE_PREFERENCE_HYPOTHESES)
        : active.filter((n) => n.kind === kind);
    if (items.length === 0) continue;
    lines.push(`- ${labels[kind]}:`);
    for (const item of items) lines.push(`  - [${item.noteId}] ${item.text}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

function renderCharactersForPrompt(characters: Character[]): string {
  if (characters.length === 0) return '（未設定）';
  return characters
    .map((c) => {
      const lines = [
        `- id: ${c.characterId}`,
        `  name: ${c.name || '（名前未設定）'}`,
        `  role: ${c.role}`,
        `  description: ${c.description.trim() || '（未記入）'}`,
      ];
      if ((c.speechStyle ?? '').trim()) lines.push(`  speechStyle: ${c.speechStyle!.trim()}`);
      if ((c.relationshipNotes ?? '').trim())
        lines.push(`  relationshipNotes: ${c.relationshipNotes!.trim()}`);
      if ((c.secrets ?? '').trim()) lines.push(`  secrets: ${c.secrets!.trim()}`);
      for (const trait of c.traits ?? []) {
        lines.push(`  ${trait.label}: ${indentContinuation(trait.text, 4)}`);
      }
      if ((c.currentState ?? '').trim()) {
        lines.push(`  currentState（開始時点の初期状態）: ${c.currentState!.trim()}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------- パース ----------

interface ParsedChat {
  visibleReply: string;
  turnIntent: RefineTurnIntent | undefined;
  suggestedActions: unknown[];
  notesToAdd: unknown[];
  archiveIds: string[];
  conversationSummary: string | null;
  patches: unknown[];
  // NOTE: JSON ではなく自然文だけが返ってきた場合。本文としては見せるが、
  // state / suggestedActions / patches は一切更新しない（設計書 6.3）。
  freeText: boolean;
}

function parseChatResult(text: string): ParsedChat | null {
  const obj = parseJsonObject(text);
  if (!obj) {
    const freeText = extractPlainTextReply(text);
    if (!freeText) return null;
    return {
      visibleReply: freeText,
      turnIntent: undefined,
      suggestedActions: [],
      notesToAdd: [],
      archiveIds: [],
      conversationSummary: null,
      patches: [],
      freeText: true,
    };
  }
  const statePatch = isRecord(obj.consultationStatePatch) ? obj.consultationStatePatch : {};
  return {
    visibleReply: typeof obj.visibleReply === 'string' ? obj.visibleReply : '',
    turnIntent: TURN_INTENTS.includes(obj.turnIntent as RefineTurnIntent)
      ? (obj.turnIntent as RefineTurnIntent)
      : undefined,
    suggestedActions: Array.isArray(obj.suggestedActions) ? obj.suggestedActions : [],
    notesToAdd: Array.isArray(statePatch.add) ? statePatch.add : [],
    archiveIds: Array.isArray(statePatch.archiveIds)
      ? statePatch.archiveIds.filter((id): id is string => typeof id === 'string')
      : [],
    conversationSummary:
      typeof obj.conversationSummary === 'string' ? obj.conversationSummary : null,
    patches: Array.isArray(obj.patches) ? obj.patches : [],
    freeText: false,
  };
}

// NOTE: setup 相談と同じ扱い。JSON として読めなかったテキストのうち、壊れた JSON の
// 断片ではないと言えるものだけを自然文の返答として通す。中括弧や "visibleReply":
// が混ざっているものは、切れた JSON の可能性が高いのでフォールバックしない。
function extractPlainTextReply(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
  if (/[{}[\]]/.test(trimmed)) return null;
  if (/"\s*(visibleReply|patches|turnIntent|suggestedActions)\s*"/.test(trimmed)) return null;
  if (trimmed.includes('```')) return null;
  return truncate(trimmed, MAX_VISIBLE_REPLY_CHARS);
}

function normalizeResponseMode(raw: unknown): RefineResponseMode {
  // NOTE: 未指定は 'auto'。既存クライアントの `{ content }` だけの送信を
  // 従来どおり自由入力欄からの送信として扱う。
  if (raw === 'consult' || raw === 'prepare-patch' || raw === 'auto') return raw;
  return 'auto';
}

// NOTE: suggestedActions の responseMode を省略・未知値のまま通すと、候補ボタンが
// 'auto' で送られて「候補を押しただけでパッチが出る」経路ができる。consult へ倒す。
export function normalizeSuggestedActions(raw: unknown[]): RefineSuggestedAction[] {
  const result: RefineSuggestedAction[] = [];
  for (const item of raw) {
    if (result.length >= MAX_SUGGESTED_ACTIONS) break;
    if (!isRecord(item)) continue;
    const label = truncate(asString(item.label), MAX_SUGGESTED_ACTION_LABEL_CHARS);
    const message = truncate(asString(item.message), MAX_SUGGESTED_ACTION_MESSAGE_CHARS);
    if (!label || !message) continue;
    const responseMode = item.responseMode === 'prepare-patch' ? 'prepare-patch' : 'consult';
    result.push({ label, message, responseMode });
  }
  return result;
}

interface ApplyConsultationStateOptions {
  userMessage: string;
  needsSummaryUpdate: boolean;
}

// NOTE: モデルが返した相談メモの差分を、サーバー採番の ID・時刻を付けて反映する。
// archiveIds は session を読み直した後の active な note にだけ効かせる。
export function applyConsultationStatePatch(
  current: RefineConsultationState,
  parsed: Pick<ParsedChat, 'notesToAdd' | 'archiveIds' | 'conversationSummary'>,
  sourceMessageId: string,
  options: ApplyConsultationStateOptions
): RefineConsultationState {
  const activeIds = new Set(
    current.notes.filter((n) => n.status === 'active').map((n) => n.noteId)
  );
  const toArchive = new Set<string>();
  for (const id of parsed.archiveIds) {
    if (activeIds.has(id)) {
      toArchive.add(id);
    } else {
      // NOTE: 存在しない／既に archived な ID はターン全体を失敗させず警告だけ残す。
      console.warn('Refine consultation archiveId ignored', { noteId: id });
    }
  }

  const now = nowIso();
  const added: RefineConsultationNote[] = [];
  for (const raw of parsed.notesToAdd.slice(0, MAX_NOTES_PER_TURN)) {
    if (!isRecord(raw)) continue;
    const text = truncate(asString(raw.text), MAX_NOTE_TEXT_CHARS);
    if (!text) continue;
    const kindRaw = typeof raw.kind === 'string' ? raw.kind : '';
    if (!NOTE_KINDS.includes(kindRaw as RefineConsultationNoteKind)) continue;
    added.push({
      noteId: generateTimestampId('note'),
      // NOTE: ユーザーが今回のターンで明示的に採用していない内容を confirmed に
      // させない。モデルが仮説を確定扱いで返してきたら candidate へ降格する
      // （設計書 7.3）。
      kind: normalizeNoteKind(kindRaw as RefineConsultationNoteKind, options.userMessage),
      text,
      sourceMessageId,
      createdAt: now,
      status: 'active',
    });
  }

  const notes = [...current.notes, ...added]
    .map((note) => (toArchive.has(note.noteId) ? { ...note, status: 'archived' as const } : note))
    .slice(-MAX_STORED_NOTES);

  const nextSummary =
    options.needsSummaryUpdate && parsed.conversationSummary?.trim()
      ? truncate(parsed.conversationSummary.trim(), MAX_CONVERSATION_SUMMARY_CHARS)
      : current.conversationSummary;

  return {
    ...current,
    notes,
    ...(nextSummary ? { conversationSummary: nextSummary } : {}),
  };
}

// NOTE: confirmed は「ユーザーが明言した」ことの記録なので、判定は狭く取る。
// 既定は candidate なので、取りこぼしても失われるのは記録の強さだけだが、誤って
// confirmed にすると AI が以後それを決定事項として扱う（設計書 7.3）。
//
// 「お願い」「にして」のような単独の依頼表現は使わない。「別案をいくつかお願い」も
// 一致してしまい、探索中のターンを確定扱いにするため。指示語や案の識別子と、
// 決定を表す語の組み合わせだけを採る。
const EXPLICIT_ACCEPTANCE_PATTERN =
  /((それ|これ|そちら|こちら|上記|前者|後者|[A-CＡ-Ｃ]案)で(いい|良い|よい|お願い|進め|行き|いき|いこ|大丈夫|確定|決定)|(その|この)方向で(いい|良い|よい|お願い|進め|行き|いき|いこ|大丈夫)|そうし(ます|よう|ましょう)|そうする|それを採用|採用し(ます|よう|ましょう)|(で|に)決まり|確定で(いい|お願い)|それが(いい|良い|よい|正しい))/;

// NOTE: 探索・否定を含むターンは、たとえ受諾表現が混ざっていても確定にしない。
// 「A案でいいけど、他の案も見たい」のような複合発話を確定扱いにしないため。
const EXPLORATORY_PATTERN =
  /(別の?案|他の?案|もう(少し|一?つ|一度)|違う|ではなく|じゃなく|ではない|迷って|悩んで|どちら|どっち|比べ|保留|一旦|いったん)/;

export function hasExplicitAcceptance(userMessage: string): boolean {
  if (EXPLORATORY_PATTERN.test(userMessage)) return false;
  return EXPLICIT_ACCEPTANCE_PATTERN.test(userMessage);
}

function normalizeNoteKind(
  kind: RefineConsultationNoteKind,
  userMessage: string
): RefineConsultationNoteKind {
  if (kind !== 'confirmed') return kind;
  return hasExplicitAcceptance(userMessage) ? 'confirmed' : 'candidate';
}

function resolveConsultationTarget(
  raw: RefineConsultationTarget | undefined,
  characters: Character[],
  scan: RefineScanResult | null,
  session: RefineSession
): RefineConsultationTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.kind) {
    case 'general':
      return { kind: 'general' };
    case 'world':
      return raw.section === 'foundation' || raw.section === 'initialSituation'
        ? { kind: 'world', section: raw.section }
        : { kind: 'world' };
    case 'character': {
      if (!characters.some((c) => c.characterId === raw.characterId)) {
        throw new RefineChatError(
          '相談対象の人物が見つかりません。',
          'invalid_consultation_target',
          false,
          400
        );
      }
      return raw.field
        ? { kind: 'character', characterId: raw.characterId, field: raw.field }
        : { kind: 'character', characterId: raw.characterId };
    }
    case 'finding': {
      // NOTE: 走査中の途中結果は使わず、完了済みキャッシュとだけ照合する。
      // 走査中の送信自体は maintenance guard が先に弾く。
      const finding = scan?.findings.find(
        (f) => f.id === raw.findingId && f.fingerprint === raw.fingerprint
      );
      if (!finding) {
        throw new RefineChatError(
          '相談対象の気づきが最新の走査結果に見つかりません。再走査してからお試しください。',
          'invalid_consultation_target',
          false,
          400
        );
      }
      return { kind: 'finding', findingId: finding.id, fingerprint: raw.fingerprint };
    }
    case 'patch': {
      if (!session.patches.some((p) => p.patchId === raw.patchId)) {
        throw new RefineChatError(
          '相談対象の変更候補が見つかりません。',
          'invalid_consultation_target',
          false,
          400
        );
      }
      return { kind: 'patch', patchId: raw.patchId };
    }
    default:
      return null;
  }
}

// NOTE: refineScanService と同じ多段フォールバック。responseMimeType=json を
// 指定しても、モデルによっては前置き文やコードフェンスを付けてくる。
function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(trimmed);
  if (direct) return direct;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = tryParse(fenceMatch[1].trim());
    if (inner) return inner;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return null;
}

function normalizePatch(
  raw: unknown,
  sourceMessageId: string,
  characters: Character[]
): RefinePatch | null {
  if (!isRecord(raw)) return null;
  const summary = asString(raw.summary) || '設定の変更';
  const opsRaw = Array.isArray(raw.operations) ? raw.operations : [];
  const operations: RefinePatchOperation[] = [];
  for (const opRaw of opsRaw) {
    const op = normalizeRefinePatchOperation(opRaw, characters);
    if (op) operations.push(op);
  }
  if (operations.length === 0) return null;
  return {
    patchId: generateTimestampId('patch'),
    createdAt: nowIso(),
    sourceMessageId,
    summary,
    operations,
    status: 'pending',
  };
}

export function normalizeRefinePatchOperation(
  raw: unknown,
  characters: Character[]
): RefinePatchOperation | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  switch (kind) {
    case 'world-replace': {
      const anchor = asString(raw.anchor);
      const replacement = typeof raw.replacement === 'string' ? raw.replacement : '';
      if (!anchor) return null;
      return { kind: 'world-replace', op: { anchor, replacement } };
    }
    case 'world-append': {
      const text = typeof raw.text === 'string' ? raw.text : '';
      if (!text.trim()) return null;
      return { kind: 'world-append', op: { text } };
    }
    case 'character-update': {
      const characterId = asString(raw.characterId);
      if (!characters.some((c) => c.characterId === characterId)) return null;
      const fields = normalizeCharacterFields(raw.fields);
      if (Object.keys(fields).length === 0) return null;
      return { kind: 'character-update', characterId, fields };
    }
    case 'character-add': {
      const characterRaw = isRecord(raw.character) ? raw.character : null;
      if (!characterRaw) return null;
      const name = asString(characterRaw.name);
      if (!name) return null;
      const roleRaw = typeof characterRaw.role === 'string' ? characterRaw.role : 'supporting';
      const role: CharacterRole = CHARACTER_ROLES.includes(roleRaw as CharacterRole)
        ? (roleRaw as CharacterRole)
        : 'supporting';
      const providedId = asString(characterRaw.characterId);
      const characterId =
        providedId && !characters.some((c) => c.characterId === providedId)
          ? providedId
          : generateTimestampId('char');
      const traits = normalizeCharacterTraits(characterRaw.traits);
      const character: Character = {
        characterId,
        name,
        role,
        description: asString(characterRaw.description),
        ...(asString(characterRaw.speechStyle)
          ? { speechStyle: asString(characterRaw.speechStyle) }
          : {}),
        ...(asString(characterRaw.relationshipNotes)
          ? { relationshipNotes: asString(characterRaw.relationshipNotes) }
          : {}),
        ...(asString(characterRaw.secrets) ? { secrets: asString(characterRaw.secrets) } : {}),
        ...(traits.length > 0 ? { traits } : {}),
        ...(asString(characterRaw.currentState)
          ? { currentState: asString(characterRaw.currentState) }
          : {}),
      };
      return { kind: 'character-add', character };
    }
    case 'character-remove': {
      const characterId = asString(raw.characterId);
      if (!characters.some((c) => c.characterId === characterId)) return null;
      return { kind: 'character-remove', characterId };
    }
    default:
      return null;
  }
}

function normalizeCharacterFields(raw: unknown): CharacterFieldPatch {
  if (!isRecord(raw)) return {};
  const out: CharacterFieldPatch = {};
  if (typeof raw.name === 'string') out.name = raw.name.trim();
  if (typeof raw.role === 'string' && CHARACTER_ROLES.includes(raw.role as CharacterRole)) {
    out.role = raw.role as CharacterRole;
  }
  if (typeof raw.description === 'string') out.description = raw.description;
  if (typeof raw.speechStyle === 'string') out.speechStyle = raw.speechStyle;
  if (typeof raw.relationshipNotes === 'string') out.relationshipNotes = raw.relationshipNotes;
  if (typeof raw.secrets === 'string') out.secrets = raw.secrets;
  if (Array.isArray(raw.traits)) {
    out.traits = normalizeCharacterTraits(raw.traits);
  }
  if (typeof raw.currentState === 'string') out.currentState = raw.currentState;
  return out;
}

function indentContinuation(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return value.replace(/\r\n?/g, '\n').replace(/\n/g, `\n${indent}`);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars - 1) + '…';
}

function buildChatParseFailureMessage(
  rawText: string,
  debugInfo: string | undefined,
  finishReason: string
): string {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) {
    const parts = ['AI が空の応答を返しました。'];
    if (finishReason === 'length') {
      parts.push('思考モードで出力枠を使い切った可能性があります。技術設定タブで出力字数を大きくするか、DeepSeek に切り替えると安定します。');
    } else if (finishReason === 'content_filter') {
      parts.push('安全フィルタでブロックされた可能性があります。DeepSeek への切り替えを試してください。');
    } else {
      parts.push('もう一度お試しください。');
    }
    if (debugInfo) parts.push(`診断: ${debugInfo}`);
    return parts.join('\n');
  }
  return [
    'AI 応答を JSON として解釈できませんでした。',
    `応答の一部: ${truncate(trimmed, 200)}`,
  ].join('\n');
}

// ---------- ロック ----------

// NOTE: refineAutomationService もこの mutex を再利用する（session lock → project lock
// の順序で自動 run を直列化するため）。export はそのためだけの最小限の変更で、
// ロック自体の挙動は変えない。
export async function withSessionLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  return sessionMutex.runExclusive(projectId, task);
}
