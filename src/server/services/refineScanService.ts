import { createHash } from 'node:crypto';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import { OpenAIAdapter } from '../adapters/openaiAdapter.js';
import { GeminiAdapter } from '../adapters/geminiAdapter.js';
import { DeepSeekAdapter } from '../adapters/deepseekAdapter.js';
import { XAIAdapter } from '../adapters/xaiAdapter.js';
import { ModelAdapter, ModelAdapterError } from '../adapters/modelAdapter.js';
import { reloadCredentials } from './credentialService.js';
import { resolveSystemPrompt } from '../prompts/systemPrompt.js';
import { readStoryStateDiffs, withStoryStateLock } from './storyStateService.js';
import type {
  Character,
  Project,
  RefineFinding,
  RefineFindingKind,
  RefineFindingTarget,
  RefineReviewReason,
  RefineReviewStatus,
  RefineScanResult,
  StoryStateDiffRecord,
  StoryState,
} from '../types/index.js';

const OUTPUT_LENGTH = 2200;
const TEMPERATURE = 0.35;
const TIMEOUT_MS = 90_000;
const MAX_FINDINGS = 8;
const CORE_CONCEPT_MAX_CHARS = 240;
const MESSAGE_MAX_CHARS = 220;
const DETAIL_MAX_CHARS = 320;
const SUGGESTED_FIX_MAX_CHARS = 320;
export const REFINE_NUDGE_DIFF_COUNT = 10;

const KIND_SET = new Set<RefineFindingKind>(['contradiction', 'undefined', 'suggestion']);

const adapterMap: Record<string, ModelAdapter> = {
  openai: new OpenAIAdapter(),
  gemini: new GeminiAdapter(),
  deepseek: new DeepSeekAdapter(),
  xai: new XAIAdapter(),
};

const refineScanMutexes = new Map<string, Promise<void>>();

export class RefineScanError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(message: string, code: string, retryable: boolean, status = 500) {
    super(message);
    this.name = 'RefineScanError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export async function readCachedRefineScan(
  projectId: string
): Promise<RefineScanResult | null> {
  return storage.readRefineScan(projectId);
}

export async function scanProjectSettings(
  projectId: string
): Promise<RefineScanResult> {
  return withRefineScanLock(projectId, () => scanProjectSettingsUnlocked(projectId));
}

async function scanProjectSettingsUnlocked(projectId: string): Promise<RefineScanResult> {
  await reloadCredentials();

  const [project, world, characters, presets, previousScan, storySnapshot] = await Promise.all([
    storage.readProject(projectId),
    storage.readWorld(projectId),
    storage.readCharacters(projectId),
    storage.readPresets(projectId),
    storage.readRefineScan(projectId),
    readStoryStateSnapshot(projectId),
  ]);
  if (!project) {
    throw new RefineScanError('作品が見つかりません。', 'project_not_found', false, 404);
  }

  const adapter = adapterMap[project.activeModelProvider];
  if (!adapter) {
    throw new RefineScanError(
      `対応していないプロバイダーです: ${project.activeModelProvider}`,
      'unsupported_provider',
      false,
      400
    );
  }

  const systemPromptResolution = await resolveSystemPrompt(
    project.activePresetIds,
    presets?.customSystemPrompt ?? null
  );

  const { systemInstructions, userPrompt } = buildScanPrompt({
    project,
    world,
    characters,
    storyState: storySnapshot.storyState,
    systemPrompt: systemPromptResolution.systemPrompt,
  });
  const staticInputHash = createStaticInputHash({
    project,
    world,
    characters,
    systemPrompt: systemPromptResolution.systemPrompt,
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
      // NOTE: Structured JSON output を有効化。前置き文や思考モードでの空応答を減らす。
      responseMimeType: 'application/json',
    });
  } catch (err) {
    if (err instanceof ModelAdapterError) {
      throw new RefineScanError(
        `モデル呼び出しに失敗しました: ${err.message}`,
        err.code,
        err.retryable,
        503
      );
    }
    throw err;
  }

  if (adapterResult.finishReason === 'error' || adapterResult.finishReason === 'timeout') {
    throw new RefineScanError(
      adapterResult.errorMessage || 'モデルからの応答が得られませんでした。',
      adapterResult.errorCode || 'model_error',
      adapterResult.retryable,
      503
    );
  }

  const parsed = parseScanResult(adapterResult.text);
  const findings = parsed
    ? normalizeFindings(parsed.findings, characters)
    : [];
  const coreConcept = parsed?.coreConcept
    ? truncate(parsed.coreConcept, CORE_CONCEPT_MAX_CHARS)
    : '';

  const lastError = parsed
    ? null
    : buildParseFailureMessage(adapterResult.text, adapterResult.debugInfo, adapterResult.finishReason);

  // NOTE: パース失敗はサーバー側にも残しておくと後で追跡しやすい。
  // 応答テキストは長くなり得るので 400 字に切って出す。
  if (!parsed) {
    console.warn('Refine scan JSON parse failed', {
      projectId,
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
      finishReason: adapterResult.finishReason,
      debugInfo: adapterResult.debugInfo,
      textPreview: (adapterResult.text ?? '').slice(0, 400),
    });
  }

  const result: RefineScanResult = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    usedModel: {
      provider: project.activeModelProvider,
      modelName: project.activeModelName,
    },
    coreConcept,
    findings,
    lastError,
    ...(lastError
      ? reviewMetadataFrom(previousScan)
      : {
          reviewedStoryStateDiffId: storySnapshot.diffs[0]?.diffId ?? null,
          reviewedStoryStateUpdatedAt: storySnapshot.storyState?.updatedAt ?? null,
          reviewedStaticInputHash: staticInputHash,
        }),
  };

  await storage.writeRefineScan(projectId, result);
  return result;
}

export async function getRefineReviewStatus(projectId: string): Promise<RefineReviewStatus> {
  const [project, world, characters, presets, cachedScan, storySnapshot] = await Promise.all([
    storage.readProject(projectId),
    storage.readWorld(projectId),
    storage.readCharacters(projectId),
    storage.readPresets(projectId),
    storage.readRefineScan(projectId),
    readStoryStateSnapshot(projectId),
  ]);
  if (!project) {
    throw new RefineScanError('作品が見つかりません。', 'project_not_found', false, 404);
  }

  const systemPromptResolution = await resolveSystemPrompt(
    project.activePresetIds,
    presets?.customSystemPrompt ?? null
  );
  const staticInputHash = createStaticInputHash({
    project,
    world,
    characters,
    systemPrompt: systemPromptResolution.systemPrompt,
  });

  return calculateRefineReviewStatus({
    cachedScan,
    storyState: storySnapshot.storyState,
    diffs: storySnapshot.diffs,
    staticInputHash,
  });
}

export function calculateRefineReviewStatus(input: {
  cachedScan: RefineScanResult | null;
  storyState: StoryState | null;
  diffs: StoryStateDiffRecord[];
  staticInputHash: string;
}): RefineReviewStatus {
  const diffs = sortDiffsNewestFirst(input.diffs);
  const reasons = new Set<RefineReviewReason>();
  const cursor = input.cachedScan?.reviewedStoryStateDiffId;
  let backlogCountLowerBound: number;

  if (cursor === undefined || cursor === null) {
    backlogCountLowerBound = diffs.length;
    if (backlogCountLowerBound >= REFINE_NUDGE_DIFF_COUNT) {
      reasons.add('story_progressed');
    }
  } else {
    const cursorIndex = diffs.findIndex((diff) => diff.diffId === cursor);
    if (cursorIndex < 0) {
      backlogCountLowerBound = REFINE_NUDGE_DIFF_COUNT;
      reasons.add('history_truncated');
    } else {
      backlogCountLowerBound = cursorIndex;
      if (backlogCountLowerBound >= REFINE_NUDGE_DIFF_COUNT) {
        reasons.add('story_progressed');
      }
    }
  }

  const reviewedHash = input.cachedScan?.reviewedStaticInputHash;
  if (typeof reviewedHash === 'string' && reviewedHash && reviewedHash !== input.staticInputHash) {
    reasons.add('settings_changed');
  }

  if (hasStoryStateBeenEditedSinceReview(input.cachedScan, input.storyState, diffs)) {
    reasons.add('story_state_edited');
  }

  const reasonOrder: RefineReviewReason[] = [
    'settings_changed',
    'story_state_edited',
    'history_truncated',
    'story_progressed',
  ];
  const orderedReasons = reasonOrder.filter((reason) => reasons.has(reason));

  return {
    backlogCountLowerBound,
    needsReview: orderedReasons.length > 0,
    threshold: REFINE_NUDGE_DIFF_COUNT,
    reasons: orderedReasons,
  };
}

async function readStoryStateSnapshot(projectId: string): Promise<{
  storyState: StoryState | null;
  diffs: StoryStateDiffRecord[];
}> {
  // NOTE: snapshot 取得だけを mutex 内で行い、遅い LLM 呼び出し中はロックしない。
  return withStoryStateLock(projectId, async () => {
    const [storyState, diffs] = await Promise.all([
      storage.readStoryState(projectId),
      readStoryStateDiffs(projectId),
    ]);
    return { storyState, diffs: sortDiffsNewestFirst(diffs) };
  });
}

function createStaticInputHash(input: {
  project: Project;
  world: string;
  characters: Character[];
  systemPrompt: string;
}): string {
  const normalizedCharacters = input.characters
    .map((character) => ({
      characterId: normalizeHashText(character.characterId),
      name: normalizeHashText(character.name),
      aliases: (character.aliases ?? []).map(normalizeHashText).filter(Boolean).sort(),
      role: character.role,
      description: normalizeHashText(character.description),
      speechStyle: normalizeHashText(character.speechStyle ?? ''),
      relationshipNotes: normalizeHashText(character.relationshipNotes ?? ''),
      secrets: normalizeHashText(character.secrets ?? ''),
      initialState: normalizeHashText(character.currentState ?? ''),
    }))
    .sort((a, b) => a.characterId.localeCompare(b.characterId));
  const payload = JSON.stringify({
    title: normalizeHashText(input.project.title),
    world: normalizeHashText(input.world),
    systemPrompt: normalizeHashText(input.systemPrompt),
    characters: normalizedCharacters,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function normalizeHashText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function reviewMetadataFrom(scan: RefineScanResult | null): Pick<
  RefineScanResult,
  'reviewedStoryStateDiffId' | 'reviewedStoryStateUpdatedAt' | 'reviewedStaticInputHash'
> {
  return {
    ...(scan?.reviewedStoryStateDiffId !== undefined
      ? { reviewedStoryStateDiffId: scan.reviewedStoryStateDiffId }
      : {}),
    ...(scan?.reviewedStoryStateUpdatedAt !== undefined
      ? { reviewedStoryStateUpdatedAt: scan.reviewedStoryStateUpdatedAt }
      : {}),
    ...(scan?.reviewedStaticInputHash !== undefined
      ? { reviewedStaticInputHash: scan.reviewedStaticInputHash }
      : {}),
  };
}

function sortDiffsNewestFirst(diffs: StoryStateDiffRecord[]): StoryStateDiffRecord[] {
  return [...diffs].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
}

function hasStoryStateBeenEditedSinceReview(
  cachedScan: RefineScanResult | null,
  storyState: StoryState | null,
  diffs: StoryStateDiffRecord[]
): boolean {
  if (cachedScan?.reviewedStoryStateUpdatedAt === undefined) return false;

  const reviewedUpdatedAt = cachedScan.reviewedStoryStateUpdatedAt;
  const activeDiffs = diffs.filter((diff) => !diff.reverted);
  const latestActiveDiff = activeDiffs[0];
  const currentUpdatedAt = storyState?.updatedAt ?? null;
  const expectedUpdatedAt = latestActiveDiff?.resultUpdatedAt ?? reviewedUpdatedAt;

  // NOTE: 現在値が自動更新の最新結果と一致しない場合は、従来どおり即座に検知する。
  if (currentUpdatedAt !== expectedUpdatedAt) return true;
  if (!latestActiveDiff || !reviewedUpdatedAt) return false;

  const reviewedCursor = cachedScan.reviewedStoryStateDiffId;
  if (
    typeof reviewedCursor === 'string' &&
    !diffs.some((diff) => diff.diffId === reviewedCursor)
  ) {
    // NOTE: 保持上限で確認済みカーソルが落ちた場合、連鎖が切れた理由を手動編集と
    // 断定できない。history_truncated のナッジだけを出す。
    return false;
  }

  // NOTE: 手動編集後に自動更新が続くと、現在値だけでは最新 diff と一致してしまう。
  // previousUpdatedAt を後ろ向きにたどり、最後のレビュー時点まで連続しているかを確かめる。
  return !hasContinuousAutomaticStateChain(activeDiffs, reviewedUpdatedAt);
}

function hasContinuousAutomaticStateChain(
  activeDiffs: StoryStateDiffRecord[],
  reviewedUpdatedAt: string
): boolean {
  let currentIndex = 0;

  while (currentIndex < activeDiffs.length) {
    const current = activeDiffs[currentIndex];
    if (current.resultUpdatedAt === reviewedUpdatedAt) return true;

    const previousUpdatedAt = current.previousUpdatedAt;
    // L5 導入前の履歴には predecessor がない。誤検知を避けて従来の比較に委ねる。
    if (!previousUpdatedAt) return true;
    if (previousUpdatedAt === reviewedUpdatedAt) return true;

    const previousIndex = activeDiffs.findIndex(
      (candidate, index) => index > currentIndex && candidate.resultUpdatedAt === previousUpdatedAt
    );
    if (previousIndex < 0) return false;
    currentIndex = previousIndex;
  }

  return false;
}

async function withRefineScanLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = refineScanMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  refineScanMutexes.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (refineScanMutexes.get(projectId) === next) refineScanMutexes.delete(projectId);
  }
}

interface BuildScanPromptInput {
  project: Project;
  world: string;
  characters: Character[];
  storyState: StoryState | null;
  systemPrompt: string;
}

function buildScanPrompt(input: BuildScanPromptInput): {
  systemInstructions: string;
  userPrompt: string;
} {
  const systemInstructions = [
    'あなたは長編小説の設定レビュー担当です。以下に渡す作品設定を横断的に読み、',
    '「作品の芯」の要約と、気になる点のリストを日本語で JSON として返してください。',
    '',
    '出力は必ず次の JSON スキーマだけを、コードブロックの中に返すこと:',
    '```json',
    '{',
    '  "coreConcept": "作品の芯を1〜2行で。読者が期待できる物語像を1文で。",',
    '  "findings": [',
    '    {',
    '      "kind": "contradiction" | "undefined" | "suggestion",',
    '      "target": { "kind": "world" | "systemPrompt" | "storyState" }',
    '                | { "kind": "character", "characterId": "<id>", "characterName": "<name>" }',
    '                | { "kind": "other", "label": "<短い対象名>" },',
    '      "message": "気づきを1〜2文で",',
    '      "detail": "根拠や補足（省略可）",',
    '      "suggestedFix": "具体的な修正案（省略可）"',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'kind の判断基準:',
    '- contradiction: 既存設定同士が食い違っている。人物設定と world、storyState と characters など。',
    '- undefined: 生成が安定しない原因になりそうな空欄・欠落。年齢、口調、舞台の季節など。',
    '- suggestion: あった方が良い追加情報。過度な提案は避け、価値の高いものだけ。',
    '- initialState は開始時点の状態であり、storyState の現在と食い違うこと自体は正常。矛盾として指摘しない。',
    '- description / relationshipNotes / world が storyState の現在と食い違う場合は、物語の進行による陳腐化として contradiction で指摘し、suggestedFix に現状を反映した書き換え案を書く。',
    '',
    'ルール:',
    `- findings は最大 ${MAX_FINDINGS} 件。重要度の高い順に並べる。`,
    '- character を対象にする場合、characterId は必ず入力の <人物> 節の id を使う。',
    '- 「文字数を増やしましょう」のような些末な指摘は書かない。',
    '- 気になる点がなければ findings: [] を返す。',
    '- JSON 以外の文字（挨拶、まとめ、Markdown 見出し）は一切含めない。',
  ].join('\n');

  const userPrompt = [
    '【作品情報】',
    `タイトル: ${input.project.title}`,
    '',
    '【システムプロンプト（現在有効な文体・視点の指示）】',
    input.systemPrompt.trim() || '（未設定）',
    '',
    '【世界】',
    input.world.trim() || '（未設定）',
    '',
    '【人物】',
    renderCharactersForPrompt(input.characters),
    '',
    '【現在のストーリー状態（本文が既にある場合の圧縮版）】',
    renderStoryStateForPrompt(input.storyState),
    '',
    '以上の内容を読み、指定の JSON スキーマだけを返してください。',
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
      if ((c.speechStyle ?? '').trim()) {
        lines.push(`  speechStyle: ${c.speechStyle!.trim()}`);
      }
      if ((c.relationshipNotes ?? '').trim()) {
        lines.push(`  relationshipNotes: ${c.relationshipNotes!.trim()}`);
      }
      if ((c.secrets ?? '').trim()) {
        lines.push(`  secrets: ${c.secrets!.trim()}`);
      }
      if ((c.currentState ?? '').trim()) {
        lines.push(`  initialState（開始時点）: ${c.currentState!.trim()}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function renderStoryStateForPrompt(state: StoryState | null): string {
  if (!state) return '（本文未生成）';
  const parts: string[] = [];
  if (state.currentSituation.length) {
    parts.push('- 現在の状況:');
    for (const line of state.currentSituation) parts.push(`  - ${line}`);
  }
  if (state.characterStates.length) {
    parts.push('- 人物の状態:');
    for (const cs of state.characterStates) {
      const extras: string[] = [];
      if (cs.knowledge.length) extras.push(`知っていること: ${cs.knowledge.join(' / ')}`);
      if (cs.relationships.length) extras.push(`関係: ${cs.relationships.join(' / ')}`);
      const suffix = extras.length ? `（${extras.join(' / ')}）` : '';
      parts.push(`  - ${cs.name}: ${cs.currentState}${suffix}`.trim());
    }
  }
  if (state.importantEvents.length) {
    parts.push('- 重要な出来事:');
    for (const ev of state.importantEvents) parts.push(`  - ${ev.summary}`);
  }
  if (state.openThreads.length) {
    parts.push('- 未回収の伏線:');
    for (const th of state.openThreads) parts.push(`  - ${th.summary}`);
  }
  return parts.length > 0 ? parts.join('\n') : '（記録なし）';
}

interface ParsedScan {
  coreConcept: string;
  findings: unknown[];
}

function parseScanResult(text: string): ParsedScan | null {
  const obj = parseJsonObject(text);
  if (!obj) return null;
  const coreConcept = typeof obj.coreConcept === 'string' ? obj.coreConcept : '';
  const findings = Array.isArray(obj.findings) ? obj.findings : [];
  return { coreConcept, findings };
}

// NOTE: 頑健化した JSON パーサ。responseMimeType='application/json' を指定
// してもモデルが flag を無視して前置き文を混ぜてくることがあるため、複数の
// 戦略を順に試す。
// 1. そのまま JSON.parse
// 2. コードフェンス ```json ... ``` を抽出して parse
// 3. 最初の '{' から最後の '}' を切り出して parse
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

  // 戦略 1: そのまま（responseMimeType=json が効いていればこれで通る）
  const direct = tryParse(trimmed);
  if (direct) return direct;

  // 戦略 2: コードブロックを抽出
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const inner = tryParse(fenceMatch[1].trim());
    if (inner) return inner;
  }

  // 戦略 3: {...} を切り出す（前置き/後置きの説明文を無視）
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sliced = tryParse(trimmed.slice(start, end + 1));
    if (sliced) return sliced;
  }

  return null;
}

function buildParseFailureMessage(
  rawText: string,
  debugInfo: string | undefined,
  finishReason: string
): string {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) {
    // NOTE: Gemini 2.5 系で thinking モードが maxOutputTokens を使い切ると
    // 起きる事故が最も多い。ユーザーに具体的な誘導を出す。
    const parts = ['AI が空の応答を返しました。'];
    if (finishReason === 'length') {
      parts.push('思考モードで出力枠を使い切った可能性があります。技術設定タブから出力字数を大きくするか、DeepSeek に切り替えると安定します。');
    } else if (finishReason === 'content_filter') {
      parts.push('安全フィルタでブロックされた可能性があります。DeepSeek への切り替えを試してください。');
    } else {
      parts.push('もう一度お試しください。繰り返し空になる場合は技術設定タブで別のモデルに切り替えてください。');
    }
    if (debugInfo) parts.push(`診断: ${debugInfo}`);
    return parts.join('\n');
  }
  return [
    'AI の応答を JSON として解釈できませんでした。もう一度お試しください。',
    `応答の一部: ${truncate(trimmed, 200)}`,
  ].join('\n');
}

function normalizeFindings(raw: unknown[], characters: Character[]): RefineFinding[] {
  const characterById = new Map(characters.map((c) => [c.characterId, c]));
  const result: RefineFinding[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const kindRaw = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
    if (!KIND_SET.has(kindRaw as RefineFindingKind)) continue;
    const message = truncate(asString(item.message), MESSAGE_MAX_CHARS);
    if (!message) continue;
    const target = normalizeTarget(item.target, characterById);
    if (!target) continue;
    const detail = item.detail !== undefined ? truncate(asString(item.detail), DETAIL_MAX_CHARS) : '';
    const suggestedFix =
      item.suggestedFix !== undefined
        ? truncate(asString(item.suggestedFix), SUGGESTED_FIX_MAX_CHARS)
        : '';

    result.push({
      id: generateTimestampId('finding'),
      kind: kindRaw as RefineFindingKind,
      target,
      message,
      ...(detail ? { detail } : {}),
      ...(suggestedFix ? { suggestedFix } : {}),
    });
    if (result.length >= MAX_FINDINGS) break;
  }
  return result;
}

function normalizeTarget(
  raw: unknown,
  characterById: Map<string, Character>
): RefineFindingTarget | null {
  if (!isRecord(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  switch (kind) {
    case 'world':
      return { kind: 'world' };
    case 'systemPrompt':
      return { kind: 'systemPrompt' };
    case 'storyState':
      return { kind: 'storyState' };
    case 'character': {
      const characterId = asString(raw.characterId);
      // NOTE: モデルが id を偽装するケースがあるため、実在チェックを通す。
      // 該当が無ければ「name のみで other 扱い」にフォールバック。
      const existing = characterById.get(characterId);
      const providedName = asString(raw.characterName);
      if (existing) {
        return {
          kind: 'character',
          characterId: existing.characterId,
          characterName: existing.name || providedName || '（名前未設定）',
        };
      }
      if (providedName) {
        return { kind: 'other', label: `人物: ${providedName}` };
      }
      return null;
    }
    case 'other': {
      const label = truncate(asString(raw.label), 60);
      return label ? { kind: 'other', label } : null;
    }
    default:
      return null;
  }
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
