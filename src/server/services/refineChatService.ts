import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import { normalizeCharactersForStorage } from './projectService.js';
import { withProjectWriteLock } from './generationService.js';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { XAIAdapter } from '../adapters/xaiAdapter.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import type {
  Character,
  CharacterFieldPatch,
  CharacterRole,
  Project,
  RefineApplyResponse,
  RefineChatResponse,
  RefineMessage,
  RefinePatch,
  RefinePatchOperation,
  RefineSession,
  WorldReplaceOp,
} from '../types/index.js';

const OUTPUT_LENGTH = 2000;
const TEMPERATURE = 0.55;
const TIMEOUT_MS = 90_000;
const MAX_HISTORY = 24;
const MAX_PATCHES_PER_TURN = 6;
const MAX_USER_MESSAGE_CHARS = 4000;
const CHARACTER_ROLES: readonly CharacterRole[] = [
  'protagonist',
  'deuteragonist',
  'supporting',
  'other',
];

const sessionMutexes = new Map<string, Promise<void>>();

const adapterMap: Record<string, ModelAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
  xai: new XAIAdapter(),
};

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

export async function getOrCreateRefineSession(projectId: string): Promise<RefineSession> {
  const existing = await storage.readRefineSession(projectId);
  if (existing) return existing;

  const project = await storage.readProject(projectId);
  if (!project) {
    throw new RefineChatError('作品が見つかりません。', 'project_not_found', false, 404);
  }
  const now = nowIso();
  const session: RefineSession = {
    schemaVersion: 1,
    sessionId: generateTimestampId('refsess'),
    projectId,
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
  };
  await storage.writeRefineSession(projectId, session);
  return session;
}

export async function resetRefineSession(projectId: string): Promise<RefineSession> {
  return withSessionLock(projectId, async () => {
    await storage.deleteRefineSession(projectId);
    return getOrCreateRefineSession(projectId);
  });
}

export async function sendRefineMessage(
  projectId: string,
  userMessage: string
): Promise<RefineChatResponse> {
  const trimmed = userMessage.trim();
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
  return withSessionLock(projectId, () => sendRefineMessageUnlocked(projectId, trimmed));
}

async function sendRefineMessageUnlocked(
  projectId: string,
  userMessage: string
): Promise<RefineChatResponse> {
  await reloadCredentials();

  const [session, project, world, characters] = await Promise.all([
    getOrCreateRefineSession(projectId),
    storage.readProject(projectId),
    storage.readWorld(projectId),
    storage.readCharacters(projectId),
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

  const now = nowIso();
  const userMsg: RefineMessage = {
    messageId: generateTimestampId('msg'),
    role: 'user',
    content: userMessage,
    createdAt: now,
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

  const { systemInstructions, userPrompt } = buildChatPrompt({
    project,
    world,
    characters,
    history: workingSession.messages,
    userMessage,
  });

  let adapterResult;
  try {
    adapterResult = await adapter.generateText({
      systemInstructions,
      userPrompt,
      outputLength: OUTPUT_LENGTH,
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
    content: parsed?.visibleReply?.trim() || '（応答を解釈できませんでした。もう一度お伝えください）',
    createdAt: nowIso(),
  };

  const newPatches: RefinePatch[] = [];
  if (parsed?.patches) {
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

  const nextSession: RefineSession = {
    ...workingSession,
    messages: truncateHistory([...workingSession.messages, assistantMsg]),
    patches: [...workingSession.patches, ...newPatches],
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
  const session = await storage.readRefineSession(projectId);
  if (!session) {
    throw new RefineChatError('セッションがありません。', 'session_not_found', false, 404);
  }
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

  const [world, characters] = await Promise.all([
    storage.readWorld(projectId),
    storage.readCharacters(projectId),
  ]);

  // NOTE: 全 operation を先に検証し、1 つでも失敗すれば全体を rollback（何も
  // 書かない）。中途半端に適用した状態を残さないため。
  let nextWorld = world;
  let nextCharacters = [...characters];

  for (const op of patch.operations) {
    switch (op.kind) {
      case 'world-replace': {
        const applied = applyWorldReplace(nextWorld, op.op);
        if (!applied.ok) {
          return recordApplyError(session, patchIndex, applied.error);
        }
        nextWorld = applied.text;
        break;
      }
      case 'world-append': {
        const suffix = op.op.text.trim();
        if (!suffix) break;
        nextWorld = nextWorld.trim() ? `${nextWorld.trimEnd()}\n\n${suffix}` : suffix;
        break;
      }
      case 'character-update': {
        const idx = nextCharacters.findIndex((c) => c.characterId === op.characterId);
        if (idx < 0) {
          return recordApplyError(
            session,
            patchIndex,
            `人物が見つかりません: ${op.characterId}`
          );
        }
        nextCharacters[idx] = { ...nextCharacters[idx], ...op.fields };
        break;
      }
      case 'character-add': {
        if (nextCharacters.some((c) => c.characterId === op.character.characterId)) {
          return recordApplyError(
            session,
            patchIndex,
            `同じ ID の人物が既にいます: ${op.character.characterId}`
          );
        }
        nextCharacters = [...nextCharacters, op.character];
        break;
      }
      case 'character-remove': {
        const before = nextCharacters.length;
        nextCharacters = nextCharacters.filter((c) => c.characterId !== op.characterId);
        if (nextCharacters.length === before) {
          return recordApplyError(
            session,
            patchIndex,
            `削除対象の人物が見つかりません: ${op.characterId}`
          );
        }
        break;
      }
    }
  }

  if (nextWorld !== world) {
    await storage.writeWorld(projectId, nextWorld);
  }
  if (nextCharacters !== characters) {
    // NOTE: 全書き込み境界で共通正規化を通す（review §5.4）。ここを迂回すると
    // roleplay 型プロジェクトで greeting/dialogueExamples の上限が保証されず、
    // 設計書 2.1 の「同じ正規化を通す」不変条件が壊れる。
    await storage.writeCharacters(projectId, normalizeCharactersForStorage(nextCharacters));
  }

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
  await storage.writeRefineSession(projectId, nextSession);

  return { session: nextSession, patch: appliedPatch };
}

export async function rejectRefinePatch(
  projectId: string,
  patchId: string
): Promise<RefineApplyResponse> {
  return withSessionLock(projectId, async () => {
    const session = await storage.readRefineSession(projectId);
    if (!session) {
      throw new RefineChatError('セッションがありません。', 'session_not_found', false, 404);
    }
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
  });
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

function truncateHistory(messages: RefineMessage[]): RefineMessage[] {
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
}

function buildChatPrompt(input: BuildChatPromptInput): {
  systemInstructions: string;
  userPrompt: string;
} {
  const systemInstructions = [
    'あなたは長編小説の設定編集アシスタントです。ユーザーの依頼を読み、',
    '「世界設定 (world)」と「人物設定 (characters)」の差分パッチを提案します。',
    '',
    '出力は次の JSON スキーマだけを、コードブロックの中に返してください:',
    '```json',
    '{',
    '  "visibleReply": "ユーザーへの返答（何をどう変えるか、なぜかを1〜3文で）",',
    '  "patches": [',
    '    {',
    '      "summary": "このパッチが何をするかの1行説明",',
    '      "operations": [',
    '        { "kind": "world-replace", "anchor": "既存 world の中の一意な原文", "replacement": "書き換え後の文字列" },',
    '        { "kind": "world-append", "text": "世界設定に付け足す段落（world がほぼ空か新規追加時のみ）" },',
    '        { "kind": "character-update", "characterId": "<既存のid>", "fields": { "description": "..." } },',
    '        { "kind": "character-add", "character": { "characterId": "char-<slug>", "name": "...", "role": "protagonist|deuteragonist|supporting|other", "description": "..." } },',
    '        { "kind": "character-remove", "characterId": "<既存のid>" }',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '重要なルール:',
    '- world-replace の anchor は、必ず入力の world 本文中にちょうど 1 回だけ現れる文字列にすること。同じ文字列が複数箇所にある場合は前後の文をつなげて一意にする。',
    '- world 全文の書き換えは絶対にしない。変更したい箇所だけを anchor / replacement で示す。',
    '- character-update の characterId は必ず入力の <人物> セクションから引く。',
    '- character-add の characterId は "char-" で始まる短い ID を新規に生成する（例: "char-yamada"）。',
    '- 変更が不要な場合は "patches": [] を返す。visibleReply だけで応答すればよい。',
    '- patches の数は 1 ターンあたり最大 6 個まで。',
    '- 出力は JSON コードブロック 1 つのみ。前後に挨拶や解説を書かない。',
  ].join('\n');

  const historyForPrompt = input.history
    .filter((m) => m.role !== 'system')
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'ユーザー' : 'アシスタント'}: ${m.content}`)
    .join('\n\n');

  const userPrompt = [
    '【現在の作品情報】',
    `タイトル: ${input.project.title}`,
    '',
    '【現在の world（設定原文）】',
    input.world.trim() || '（未設定）',
    '',
    '【現在の characters】',
    renderCharactersForPrompt(input.characters),
    '',
    '【これまでのやり取り（直近まで）】',
    historyForPrompt || '（新規セッション）',
    '',
    '【今回のユーザー発話】',
    input.userMessage,
    '',
    '以上を踏まえて、指定 JSON スキーマだけで応答してください。',
  ].join('\n');

  return { systemInstructions, userPrompt };
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
      if ((c.currentState ?? '').trim()) lines.push(`  currentState: ${c.currentState!.trim()}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

// ---------- パース ----------

interface ParsedChat {
  visibleReply: string;
  patches: unknown[];
}

function parseChatResult(text: string): ParsedChat | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const visibleReply = typeof obj.visibleReply === 'string' ? obj.visibleReply : '';
  const patches = Array.isArray(obj.patches) ? obj.patches : [];
  return { visibleReply, patches };
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
    const op = normalizeOperation(opRaw, characters);
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

function normalizeOperation(
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
  if (typeof raw.currentState === 'string') out.currentState = raw.currentState;
  return out;
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

async function withSessionLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = sessionMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  sessionMutexes.set(projectId, next);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (sessionMutexes.get(projectId) === next) sessionMutexes.delete(projectId);
  }
}
