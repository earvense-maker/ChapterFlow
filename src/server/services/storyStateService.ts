import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { normalizeComparableText } from '../utils/characterStateMatching.js';
import * as storage from './storageService.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  Character,
  CharacterId,
  GenerationRecord,
  MemoryImportance,
  Project,
  StoryAuthorUndecidedRecord,
  StoryCharacterState,
  StoryClock,
  StoryEventRecord,
  StoryItemStatus,
  StoryState,
  StoryStateDiffRecord,
  StoryStateDiffSummary,
  StoryThreadRecord,
} from '../types/index.js';

// NOTE: Track 2A/2B により応答 JSON に addUnknownBy / removeUnknownBy /
// knowledge / removeKnowledge / actor / recipient が加わり、explicitlyUnknownBy が
// 反転運用で大量付与される。initial 4000 だと finishReason==='length' で throw する
// リスクが高いため、先んじて 6000 / retry 9000 に引き上げる。
const STORY_STATE_OUTPUT_LENGTH = 6000;
const STORY_STATE_RETRY_OUTPUT_LENGTH = 9000;
// NOTE: 明示的な最大出力トークン数（アダプタの maxOutputTokens に直接渡す）。
// state extraction は JSON なので、本文向けの estimateMaxOutputTokens（upper*3+2048）
// で見積もると OpenAI/xAI/OpenRouter のハードキャップ 16384 に張り付き、initial と
// retry が同じ枠になって retry の意味が消える（レビュー指摘 #3）。ここは JSON 前提
// の実測に近い値で initial=8192、retry=15000 を渡し、retry の実質的な headroom を
// 確保する（Gemini/DeepSeek はキャップに余裕があるのでそのまま通る）。
const STORY_STATE_MAX_OUTPUT_TOKENS_INITIAL = 8192;
const STORY_STATE_MAX_OUTPUT_TOKENS_RETRY = 15000;
const STORY_STATE_TEMPERATURE = 0.15;
const MAX_CURRENT_SITUATION = 12;
const MAX_CHARACTER_STATES = 24;
const MAX_IMPORTANT_EVENTS = 48;
const MAX_OPEN_THREADS = 36;
const MAX_AUTHOR_UNDECIDED = 12;
// NOTE: Track 2A: 4 → 12 に緩和。反転運用（同席していない主要人物を全員入れる）に
// 見合う容量を確保する。MAX_EVENT_KNOWN_BY と揃える。
const MAX_EXPLICITLY_UNKNOWN = 12;
const MAX_EVENT_KNOWN_BY = 12;
const MAX_DIFF_RECORDS = 20;
const MAX_DIFF_SNAPSHOTS = 3;
const storyStateMutexes = new Map<string, Promise<void>>();

export function createEmptyStoryState(updatedAt = nowIso()): StoryState {
  return {
    schemaVersion: 1,
    currentSituation: [],
    characterStates: [],
    importantEvents: [],
    openThreads: [],
    authorUndecided: [],
    clock: { day: 1 },
    processedGenerationIds: [],
    updatedAt,
  };
}

export async function readStoryState(projectId: string): Promise<StoryState> {
  return normalizeStoryState(await storage.readStoryState(projectId));
}

export async function updateStoryStateFromAcceptedScene(input: {
  project: Project;
  adapter: ModelAdapter;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
  timeoutMs: number;
}): Promise<StoryState | null> {
  const promptState = await readStoryState(input.project.projectId);
  const userPrompt = buildUpdatePrompt({
    previousState: promptState,
    generation: input.generation,
    characters: input.characters,
    worldText: input.worldText,
  });
  let parsed: unknown | null = null;

  const attempts = [
    {
      outputLength: STORY_STATE_OUTPUT_LENGTH,
      maxOutputTokens: STORY_STATE_MAX_OUTPUT_TOKENS_INITIAL,
    },
    {
      outputLength: STORY_STATE_RETRY_OUTPUT_LENGTH,
      maxOutputTokens: STORY_STATE_MAX_OUTPUT_TOKENS_RETRY,
    },
  ];
  for (const [attemptIndex, attempt] of attempts.entries()) {
    const result = await input.adapter.generateText({
      systemInstructions: buildSystemInstructions(),
      userPrompt,
      outputLength: attempt.outputLength,
      maxOutputTokens: attempt.maxOutputTokens,
      temperature: STORY_STATE_TEMPERATURE,
      timeoutMs: attemptIndex === 0 ? input.timeoutMs : Math.max(5_000, Math.floor(input.timeoutMs / 2)),
      modelName: input.project.activeModelName,
      responseMimeType: 'application/json',
    });

    if (result.finishReason === 'timeout') {
      throw new Error('物語の状態抽出がタイムアウトしました。少し待ってから再抽出してください。');
    }
    if (result.finishReason === 'error') {
      throw new Error(
        result.errorMessage ||
          (result.errorCode ? `物語の状態抽出に失敗しました（${result.errorCode}）。` : '物語の状態抽出に失敗しました。')
      );
    }
    if (result.finishReason === 'content_filter') {
      throw new Error('モデルの安全判定により物語の状態を抽出できませんでした。');
    }

    parsed = parseStoryStateJson(result.text);
    if (result.finishReason === 'length') {
      if (attemptIndex === attempts.length - 1) {
        throw new Error('物語の状態JSONが出力上限で途中までになりました。再抽出してください。');
      }
      parsed = null;
      continue;
    }
    if (parsed) break;
    // NOTE: 長期作品では差分JSONも出力上限に達することがある。JSON指定でも
    // 応答が途中で切れた場合だけ、一度だけ余裕を増やして再試行する。
  }

  if (!parsed) {
    throw new Error('モデルの応答が途中で切れたか、状態JSONとして読み取れませんでした。再抽出してください。');
  }

  return withStoryStateLock(input.project.projectId, async () => {
    const previousState = await readStoryState(input.project.projectId);
    const appliedAt = nowIso();
    const nextState = mergeStoryState(previousState, parsed, appliedAt, input.characters);
    nextState.processedGenerationIds = appendUnique(
      previousState.processedGenerationIds ?? [],
      input.generation.generationId
    );
    await storage.writeStoryState(input.project.projectId, nextState);
    await appendStoryStateDiff(input.project.projectId, {
      diffId: generateTimestampId('diff'),
      generationId: input.generation.generationId,
      sceneId: input.generation.sceneId,
      appliedAt,
      previousUpdatedAt: previousState.updatedAt,
      summary: summarizeDiff(previousState, nextState, input.characters),
      beforeState: previousState,
      resultUpdatedAt: nextState.updatedAt,
      reverted: false,
    });
    return nextState;
  });
}

function buildSystemInstructions(): string {
  return [
    'あなたは連載小説アプリの状態管理係です。',
    '採用済み本文だけを根拠に、次回生成で矛盾を避けるための構造化JSONを更新してください。',
    '小説本文や説明文を書かず、JSONオブジェクトだけを出力してください。',
    '本文にない事実や未確定の過去を勝手に確定しないでください。',
  ].join('\n');
}

function buildUpdatePrompt(input: {
  previousState: StoryState;
  generation: GenerationRecord;
  characters: Character[];
  worldText: string;
}): string {
  const characterHints = input.characters.map((character) => ({
    characterId: character.characterId,
    name: character.name,
    aliases: character.aliases ?? [],
    role: character.role,
    initialState: character.currentState || '',
    relationshipNotes: character.relationshipNotes || '',
  }));

  return [
    '【既存の物語状態JSON】',
    JSON.stringify(input.previousState, null, 2),
    '【人物ヒント】',
    JSON.stringify(characterHints, null, 2),
    '【世界設定抜粋】',
    input.worldText.trim().slice(0, 4000) || 'なし',
    '【今回採用された場面】',
    [
      `episodeId: ${input.generation.episodeId}`,
      `sceneId: ${input.generation.sceneId}`,
      input.generation.responseText,
    ].join('\n\n'),
    '【更新方針】',
    [
      '- 出力は既存JSONの全置換ではなく、今回の場面から必要になった差分だけにする。',
      '- currentSituation には、次の場面開始時点の現在状況だけを短く入れる。',
      '- characterStates には、新規または更新が必要な人物だけを入れる。',
      '- 人物ヒントの initialState は開始時点の状態であり、出力キーとして模倣しない。現在状態は characterStates[].currentState に返す。',
      '- characterStates.knowledge には、今回の場面で当該人物が新たに得た小さな知識・観察・仮説を短文で追加する（1件30字以内推奨、1人物あたり今回追加は最大3件）。イベント化するほどでもないが「以降その人物の描写に効く」性質のもの。例: 「Bの好みが苦味に偏っていることに気づいた」「Cが左利きだと知った」「Dの職業を疑い始めた」。',
      '- 既存の knowledge から取り消したい項目がある場合、characterStates.removeKnowledge に完全一致する文字列を並べる。誤抽出の巻き戻し用。',
      '- 重複する内容や、importantEvents に既に載せた事件そのものは knowledge に書かない。',
      '- importantEvents には、新規または更新が必要な不可逆な出来事・約束・秘密の開示だけを入れる。',
      '- importantEvents の characters は出来事の当事者名、presentCharacters はその場に居合わせた人物のcharacterId、learnedBy は伝聞・立ち聞き・観察などでこの場面で新たに知った人物のcharacterId。',
      '- knownBy / addUnknownBy / removeUnknownBy には人物ヒントのcharacterIdだけを使う。本文中の呼び名・あだ名は aliases を参照して必ずcharacterIdへ解決する。',
      '- explicitlyUnknownBy はパッチキーとしては使わない。代わりに addUnknownBy / removeUnknownBy を使う。',
      '- addUnknownBy には、この場面終了時点で、その場に居合わせず、伝聞・立ち聞き・観察・記録の閲覧などによっても知り得ない人物のcharacterIdを入れる。原則として knownBy 以外の主要人物は全員入れる。',
      '  - 判定は「この場面が終わった瞬間」で切る。次の場面で当人に伝えに行く予定があっても、この場面終了時点ではまだ知らないので addUnknownBy に入れる。実際に情報が伝わる場面の抽出で learnedBy 経由で knownBy へ移す。',
      '  - 次の人物は含めない: 人物一覧に無い脇役、明かされること自体に意味のない情報（周知の日常的事実、天候など）。',
      '- removeUnknownBy は、以前の抽出で誤って explicitlyUnknownBy に入れた人物を取り消したいときにcharacterIdを列挙する。既存イベントの誤抽出訂正専用。',
      '- 主要人物とは、人物ヒントの role が protagonist / deuteragonist の人物、および当該場面直前の characterStates に登場する人物とする。',
      '- actor は「その出来事の主体（発話者・行為者・宣言者）」のcharacterId。単独行為なら recipient は null。',
      '- recipient は「その出来事の受け手・宛先（宣告された相手、告白された相手など）」のcharacterId。宛先が特定できない出来事（独白・情景・自然現象）では null にする。',
      '- actor / recipient は当事者性が明確な場合にのみ埋める。誰が主体か本文から読み取れない場合は null にする（推測しない）。',
      '- actor / recipient に指定する characterId は、人物ヒントに存在するIDに限る。名前一致で複数候補ある場合は null にする。',
      '- actor / recipient は「主客の構造」を残すためのものであり、知識状態（knownBy / explicitlyUnknownBy）とは独立に扱う。actor だからといって自動で knownBy に含める、といった暗黙の連動はしない。知識状態は presentCharacters / learnedBy / knownBy / explicitlyUnknownBy 側で別途判断する。',
      '- openThreads には、作中で提示済みの謎・伏線だけを入れる。作者がまだ決めていない事項は authorUndecided であり、抽出・更新しない。解決済みは既存threadIdを使い status を resolved にする。',
      '- clock には場面終了時点の物語内時間を入れる。経過が読み取れない場合は既存値をそのまま返す。日をまたいだ描写があればdayを進める。',
      '- 既存項目を更新する場合は eventId/threadId/characterId を維持する。',
      '- 古い項目を出力から省略しても削除にはならない。削除したい場合は archiveEventIds または archiveThreadIds にIDを入れる。',
      '- 各配列は簡潔に保つ。長い本文引用は入れない。',
      '- 新規項目の eventId/threadId は空文字でもよい。',
    ].join('\n'),
    '【差分JSON形式】',
    JSON.stringify(
      {
        currentSituation: ['次の場面開始時点の現在状況'],
        characterStates: [
          {
            characterId: '既存characterIdまたはnull',
            name: '人物名',
            currentState: '今回更新が必要な現在状態',
            relationships: ['今回更新が必要な関係変化'],
            knowledge: ['今回追加する知識・観察（各30字以内、最大3件）'],
            removeKnowledge: ['既存knowledgeから削除する完全一致文字列'],
          },
        ],
        clock: {
          day: input.previousState.clock?.day ?? 1,
          timeOfDay: input.previousState.clock?.timeOfDay ?? '',
          note: input.previousState.clock?.note ?? '',
        },
        importantEvents: [
          {
            eventId: '既存eventIdまたは空文字',
            sceneId: input.generation.sceneId,
            summary: '今回追加または更新が必要な重要イベント',
            characters: ['関係人物'],
            presentCharacters: ['char-id'],
            learnedBy: ['char-id'],
            knownBy: ['char-id'],
            addUnknownBy: ['char-id'],
            removeUnknownBy: ['char-id'],
            actor: '主体のcharacterIdまたはnull',
            recipient: '受け手のcharacterIdまたはnull',
            importance: 'high',
            status: 'active',
          },
        ],
        openThreads: [
          {
            threadId: '既存threadIdまたは空文字',
            summary: '今回追加または更新が必要な未解決事項',
            relatedCharacters: ['関係人物'],
            importance: 'medium',
            status: 'active',
          },
        ],
        archiveEventIds: ['不要になった既存eventId'],
        archiveThreadIds: ['不要になった既存threadId'],
      },
      null,
      2
    ),
  ].join('\n\n---\n\n');
}

export function parseStoryStateJson(text: string): unknown | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function mergeStoryState(
  previousValue: unknown,
  patchValue: unknown,
  fallbackUpdatedAt = nowIso(),
  characters: Character[] = []
): StoryState {
  const previous = normalizeStoryState(previousValue, fallbackUpdatedAt, characters);
  if (!isRecord(patchValue)) {
    return previous;
  }

  const next: StoryState = {
    ...previous,
    currentSituation: hasField(patchValue, 'currentSituation')
      ? asStringArray(patchValue.currentSituation, MAX_CURRENT_SITUATION)
      : previous.currentSituation,
    characterStates: mergeCharacterStates(
      previous.characterStates,
      patchValue.characterStates,
      fallbackUpdatedAt,
      characters
    ),
    importantEvents: mergeEventRecords(
      previous.importantEvents,
      patchValue.importantEvents,
      fallbackUpdatedAt,
      characters
    ),
    openThreads: mergeThreadRecords(
      previous.openThreads,
      patchValue.openThreads,
      fallbackUpdatedAt
    ),
    authorUndecided: previous.authorUndecided,
    clock: hasField(patchValue, 'clock')
      ? mergeClock(previous.clock, patchValue.clock)
      : previous.clock,
    processedGenerationIds: previous.processedGenerationIds,
    updatedAt: fallbackUpdatedAt,
  };

  return {
    ...next,
    importantEvents: archiveEvents(
      next.importantEvents,
      asStringArray(patchValue.archiveEventIds, MAX_IMPORTANT_EVENTS),
      fallbackUpdatedAt
    ).slice(0, MAX_IMPORTANT_EVENTS),
    openThreads: archiveThreads(
      next.openThreads,
      asStringArray(patchValue.archiveThreadIds, MAX_OPEN_THREADS),
      fallbackUpdatedAt
    ).slice(0, MAX_OPEN_THREADS),
  };
}

export function normalizeStoryState(
  value: unknown,
  fallbackUpdatedAt = nowIso(),
  characters: Character[] = [],
  options: { strictActorRecipientIds?: boolean } = {}
): StoryState {
  if (!isRecord(value)) return createEmptyStoryState(fallbackUpdatedAt);

  return {
    schemaVersion: 1,
    currentSituation: asStringArray(value.currentSituation, MAX_CURRENT_SITUATION),
    characterStates: asArray(value.characterStates)
      .map((item) => normalizeCharacterState(item, fallbackUpdatedAt))
      .filter((item): item is StoryCharacterState => item !== null)
      .slice(0, MAX_CHARACTER_STATES),
    importantEvents: asArray(value.importantEvents)
      .map((item) =>
        normalizeEventRecord(
          item,
          fallbackUpdatedAt,
          characters,
          options.strictActorRecipientIds === true
        )
      )
      .filter((item): item is StoryEventRecord => item !== null)
      .slice(0, MAX_IMPORTANT_EVENTS),
    openThreads: asArray(value.openThreads)
      .map((item) => normalizeThreadRecord(item, fallbackUpdatedAt))
      .filter((item): item is StoryThreadRecord => item !== null)
      .slice(0, MAX_OPEN_THREADS),
    authorUndecided: asArray(value.authorUndecided)
      .map((item) => normalizeAuthorUndecided(item, fallbackUpdatedAt))
      .filter((item): item is StoryAuthorUndecidedRecord => item !== null)
      .slice(0, MAX_AUTHOR_UNDECIDED),
    clock: normalizeClock(value.clock),
    processedGenerationIds: asStringArray(value.processedGenerationIds, Number.MAX_SAFE_INTEGER),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeCharacterState(value: unknown, fallbackUpdatedAt: string): StoryCharacterState | null {
  if (!isRecord(value)) return null;

  const name = asString(value.name);
  const currentState = asString(value.currentState);
  if (!name && !currentState) return null;

  return {
    characterId: asNullableString(value.characterId),
    name: name || 'Unknown',
    currentState,
    knowledge: asStringArray(value.knowledge, 12),
    relationships: asStringArray(value.relationships, 12),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeAuthorUndecided(
  value: unknown,
  fallbackUpdatedAt: string
): StoryAuthorUndecidedRecord | null {
  if (!isRecord(value)) return null;
  const text = asString(value.text);
  if (!text) return null;
  return {
    id: normalizeId(value.id, 'und'),
    text,
    reason: asString(value.reason) || undefined,
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function normalizeClock(value: unknown): StoryClock | undefined {
  if (!isRecord(value)) return undefined;
  const dayValue = value.day;
  const day =
    typeof dayValue === 'number' && Number.isFinite(dayValue)
      ? Math.max(1, Math.floor(dayValue))
      : 1;
  return {
    day,
    timeOfDay: asString(value.timeOfDay) || undefined,
    note: asString(value.note) || undefined,
  };
}

function mergeClock(previous: StoryClock | undefined, patch: unknown): StoryClock | undefined {
  const next = normalizeClock(patch);
  if (!next) return previous;
  if (previous && next.day < previous.day) return previous;
  if (!isRecord(patch)) return next;
  return {
    day: next.day,
    timeOfDay: hasField(patch, 'timeOfDay') ? next.timeOfDay : previous?.timeOfDay,
    note: hasField(patch, 'note') ? next.note : previous?.note,
  };
}

function mergeCharacterStates(
  previous: StoryCharacterState[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryCharacterState[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findCharacterStateIndex(next, raw, characters);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeCharacterStatePatch(raw, existing, fallbackUpdatedAt, characters);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_CHARACTER_STATES);
}

function normalizeCharacterStatePatch(
  value: Record<string, unknown>,
  existing: StoryCharacterState | undefined,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryCharacterState | null {
  const rawName = hasField(value, 'name') ? asString(value.name) : existing?.name ?? '';
  const matchedCharacter = rawName ? findCharacterByNameOrAlias(characters, rawName) : null;
  const characterId = hasField(value, 'characterId')
    ? asNullableString(value.characterId) ?? matchedCharacter?.characterId ?? null
    : existing?.characterId ?? matchedCharacter?.characterId ?? null;
  const name = matchedCharacter?.name ?? rawName;
  const currentState = hasField(value, 'currentState')
    ? asString(value.currentState)
    : existing?.currentState ?? '';
  if (!name && !currentState) return null;

  // NOTE: Track 2B: knowledge を差分パッチで追加削除できるようにする。
  // - knowledge: 追加する新規知識（1件30字は指示側で誘導、コード上限は3件/差分）。
  // - removeKnowledge: 既存 knowledge から取り消す文字列（normalizeComparableText で照合）。
  // 全体上限 12 件は既存 (normalizeCharacterState) と揃える。上限超過時は古いものから捨てる。
  const knowledgeAdd = hasField(value, 'knowledge') ? asStringArray(value.knowledge, 3) : [];
  const knowledgeRemove = hasField(value, 'removeKnowledge')
    ? asStringArray(value.removeKnowledge, 12)
    : [];
  const knowledge = mergeKnowledgeList(existing?.knowledge ?? [], knowledgeAdd, knowledgeRemove);

  return {
    characterId,
    name: name || existing?.name || 'Unknown',
    currentState,
    knowledge,
    relationships: hasField(value, 'relationships')
      ? asStringArray(value.relationships, 12)
      : existing?.relationships ?? [],
    updatedAt: fallbackUpdatedAt,
  };
}

// NOTE: knowledge の追加削除ロジック。テスト容易性のためエクスポートする。
// - まず remove を既存から取り除き、その後 add を末尾に append する。
//   同一パッチで add と remove が同一項目を含むケースは、remove 済みの後に
//   add が末尾に戻るので、結果的に add が勝つ（項目は残る）。
// - normalizeComparableText で重複除去。
// - 上限12件を超えたら古いものから切り捨て（末尾を優先して残す）。
// 照合の限界: normalizeComparableText は NFKC + trim + 連続空白の1個化 + 小文字化。
// 空白の有無自体は吸収しないため、removeKnowledge は既存 knowledge の空白位置と
// 厳密に一致させる必要がある。
export function mergeKnowledgeList(
  existing: string[],
  add: string[],
  remove: string[]
): string[] {
  const removeKeys = new Set(remove.map(normalizeComparableText).filter(Boolean));
  const filtered = existing.filter((text) => !removeKeys.has(normalizeComparableText(text)));
  const combined = mergeUniqueStrings([...filtered, ...add]);
  return combined.length > 12 ? combined.slice(combined.length - 12) : combined;
}

function findCharacterStateIndex(
  states: StoryCharacterState[],
  raw: Record<string, unknown>,
  characters: Character[]
): number {
  const characterId = asString(raw.characterId);
  if (characterId) {
    const byId = states.findIndex((state) => state.characterId === characterId);
    if (byId >= 0) return byId;
  }

  const name = asString(raw.name);
  if (name) {
    const byName = states.findIndex((state) => state.name === name);
    if (byName >= 0) return byName;
    const canonical = findCharacterByNameOrAlias(characters, name);
    if (canonical) {
      const byCanonicalId = states.findIndex((state) => state.characterId === canonical.characterId);
      if (byCanonicalId >= 0) return byCanonicalId;
      const byCanonicalName = states.findIndex((state) => state.name === canonical.name);
      if (byCanonicalName >= 0) return byCanonicalName;
    }
  }
  return -1;
}

function normalizeEventRecord(
  value: unknown,
  fallbackUpdatedAt: string,
  characters: Character[] = [],
  forceStrictActorRecipientIds = false
): StoryEventRecord | null {
  if (!isRecord(value)) return null;

  const summary = asString(value.summary);
  if (!summary) return null;
  const knownBy = normalizeCharacterIdList(value.knownBy, characters, MAX_EVENT_KNOWN_BY);
  const explicitlyUnknownBy = normalizeCharacterIdList(
    value.explicitlyUnknownBy,
    characters,
    MAX_EXPLICITLY_UNKNOWN
  ).filter((id) => !knownBy.includes(id));
  // NOTE: 読み込み経路（characters が渡らないケース）では既に検証済みの ID を
  // 破壊しないよう preserve を使う。書き込み経路（mergeEventRecords 経由の
  // normalizeEventPatch）は strict な normalizeSingleCharacterId を使う。
  const useStrict = forceStrictActorRecipientIds || characters.length > 0;
  const actor = hasField(value, 'actor')
    ? useStrict
      ? normalizeSingleCharacterId(value.actor, characters)
      : preserveStoredCharacterId(value.actor)
    : undefined;
  const recipient = hasField(value, 'recipient')
    ? useStrict
      ? normalizeSingleCharacterId(value.recipient, characters)
      : preserveStoredCharacterId(value.recipient)
    : undefined;

  return {
    eventId: normalizeId(value.eventId, 'evt'),
    sceneId: asNullableString(value.sceneId),
    summary,
    characters: asStringArray(value.characters, 12),
    visibility: asString(value.visibility),
    knownBy,
    explicitlyUnknownBy,
    ...(actor !== undefined ? { actor } : {}),
    ...(recipient !== undefined ? { recipient } : {}),
    importance: asImportance(value.importance, 'medium'),
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function mergeEventRecords(
  previous: StoryEventRecord[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryEventRecord[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findEventIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeEventPatch(raw, existing, fallbackUpdatedAt, characters);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_IMPORTANT_EVENTS);
}

function normalizeEventPatch(
  value: Record<string, unknown>,
  existing: StoryEventRecord | undefined,
  fallbackUpdatedAt: string,
  characters: Character[]
): StoryEventRecord | null {
  const summary = hasField(value, 'summary') ? asString(value.summary) : existing?.summary ?? '';
  if (!summary) return null;
  const validExistingKnown = normalizeCharacterIdList(
    existing?.knownBy ?? [],
    characters,
    MAX_EVENT_KNOWN_BY
  );
  const explicitKnownPatchIds = hasField(value, 'knownBy')
    ? normalizeCharacterIdList(value.knownBy, characters, MAX_EVENT_KNOWN_BY)
    : [];
  const presentIds = normalizeCharacterIdList(value.presentCharacters, characters, MAX_EVENT_KNOWN_BY);
  const learnedIds = normalizeCharacterIdList(value.learnedBy, characters, MAX_EVENT_KNOWN_BY);
  const knownBy = mergeUniqueStrings([
    ...validExistingKnown,
    ...explicitKnownPatchIds,
    ...presentIds,
    ...learnedIds,
  ]).slice(0, MAX_EVENT_KNOWN_BY);
  // NOTE: Track 2A: explicitlyUnknownBy はパッチキーとして受け付けない。
  // addUnknownBy（追加）/ removeUnknownBy（削除）で追加・削除操作に統一する。
  // 旧形式 explicitlyUnknownBy キーが混入した場合は既存値を破壊しないよう無視し、
  // warn ログを残す（LLM のプロンプト無視 or 古いクライアント経由の異常ケース検知用）。
  if (hasField(value, 'explicitlyUnknownBy')) {
    console.warn(
      'StoryState patch contains legacy explicitlyUnknownBy key; ignoring. Use addUnknownBy / removeUnknownBy instead.'
    );
  }
  const existingExplicitUnknown = normalizeCharacterIdList(
    existing?.explicitlyUnknownBy ?? [],
    characters,
    MAX_EXPLICITLY_UNKNOWN
  );
  const addUnknownIds = normalizeCharacterIdList(
    value.addUnknownBy,
    characters,
    MAX_EXPLICITLY_UNKNOWN
  );
  const removeUnknownIds = new Set(
    normalizeCharacterIdList(value.removeUnknownBy, characters, MAX_EXPLICITLY_UNKNOWN)
  );
  const explicitlyUnknownBy = mergeUniqueStrings([
    ...existingExplicitUnknown,
    ...addUnknownIds,
  ])
    .filter((id) => !removeUnknownIds.has(id))
    .filter((id) => !knownBy.includes(id))
    .slice(0, MAX_EXPLICITLY_UNKNOWN);

  const actor = hasField(value, 'actor')
    ? normalizeSingleCharacterId(value.actor, characters)
    : existing?.actor;
  const recipient = hasField(value, 'recipient')
    ? normalizeSingleCharacterId(value.recipient, characters)
    : existing?.recipient;

  return {
    eventId: existing?.eventId ?? normalizeId(value.eventId, 'evt'),
    sceneId: hasField(value, 'sceneId')
      ? asNullableString(value.sceneId)
      : existing?.sceneId ?? null,
    summary,
    characters: hasField(value, 'characters')
      ? asStringArray(value.characters, 12)
      : existing?.characters ?? [],
    visibility: hasField(value, 'visibility') ? asString(value.visibility) : existing?.visibility ?? '',
    knownBy,
    explicitlyUnknownBy,
    ...(actor !== undefined ? { actor } : {}),
    ...(recipient !== undefined ? { recipient } : {}),
    importance: hasField(value, 'importance')
      ? asImportance(value.importance, existing?.importance ?? 'medium')
      : existing?.importance ?? 'medium',
    status: hasField(value, 'status')
      ? asStatus(value.status, existing?.status ?? 'active')
      : existing?.status ?? 'active',
    updatedAt: fallbackUpdatedAt,
  };
}

function findEventIndex(events: StoryEventRecord[], raw: Record<string, unknown>): number {
  const eventId = asString(raw.eventId);
  if (eventId) {
    const byId = events.findIndex((event) => event.eventId === eventId);
    if (byId >= 0) return byId;
  }

  const summary = normalizeComparableSummary(asString(raw.summary));
  return summary
    ? events.findIndex((event) => normalizeComparableSummary(event.summary) === summary)
    : -1;
}

function archiveEvents(
  events: StoryEventRecord[],
  eventIds: string[],
  fallbackUpdatedAt: string
): StoryEventRecord[] {
  if (eventIds.length === 0) return events;
  const archiveSet = new Set(eventIds);
  return events.map((event) =>
    archiveSet.has(event.eventId)
      ? { ...event, status: 'archived', updatedAt: fallbackUpdatedAt }
      : event
  );
}

function normalizeThreadRecord(value: unknown, fallbackUpdatedAt: string): StoryThreadRecord | null {
  if (!isRecord(value)) return null;

  const summary = asString(value.summary);
  if (!summary) return null;

  return {
    threadId: normalizeId(value.threadId, 'thread'),
    summary,
    relatedCharacters: asStringArray(value.relatedCharacters, 12),
    importance: asImportance(value.importance, 'medium'),
    status: asStatus(value.status, 'active'),
    updatedAt: asString(value.updatedAt) || fallbackUpdatedAt,
  };
}

function mergeThreadRecords(
  previous: StoryThreadRecord[],
  rawUpdates: unknown,
  fallbackUpdatedAt: string
): StoryThreadRecord[] {
  const next = previous.map((item) => ({ ...item }));

  for (const raw of asArray(rawUpdates)) {
    if (!isRecord(raw)) continue;
    const existingIndex = findThreadIndex(next, raw);
    const existing = existingIndex >= 0 ? next[existingIndex] : undefined;
    const merged = normalizeThreadPatch(raw, existing, fallbackUpdatedAt);
    if (!merged) continue;
    if (existingIndex >= 0) {
      next[existingIndex] = merged;
    } else {
      next.push(merged);
    }
  }

  return next.slice(0, MAX_OPEN_THREADS);
}

function normalizeThreadPatch(
  value: Record<string, unknown>,
  existing: StoryThreadRecord | undefined,
  fallbackUpdatedAt: string
): StoryThreadRecord | null {
  const summary = hasField(value, 'summary') ? asString(value.summary) : existing?.summary ?? '';
  if (!summary) return null;

  return {
    threadId: existing?.threadId ?? normalizeId(value.threadId, 'thread'),
    summary,
    relatedCharacters: hasField(value, 'relatedCharacters')
      ? asStringArray(value.relatedCharacters, 12)
      : existing?.relatedCharacters ?? [],
    importance: hasField(value, 'importance')
      ? asImportance(value.importance, existing?.importance ?? 'medium')
      : existing?.importance ?? 'medium',
    status: hasField(value, 'status')
      ? asStatus(value.status, existing?.status ?? 'active')
      : existing?.status ?? 'active',
    updatedAt: fallbackUpdatedAt,
  };
}

function findThreadIndex(threads: StoryThreadRecord[], raw: Record<string, unknown>): number {
  const threadId = asString(raw.threadId);
  if (threadId) {
    const byId = threads.findIndex((thread) => thread.threadId === threadId);
    if (byId >= 0) return byId;
  }

  const summary = normalizeComparableSummary(asString(raw.summary));
  return summary
    ? threads.findIndex((thread) => normalizeComparableSummary(thread.summary) === summary)
    : -1;
}

function archiveThreads(
  threads: StoryThreadRecord[],
  threadIds: string[],
  fallbackUpdatedAt: string
): StoryThreadRecord[] {
  if (threadIds.length === 0) return threads;
  const archiveSet = new Set(threadIds);
  return threads.map((thread) =>
    archiveSet.has(thread.threadId)
      ? { ...thread, status: 'archived', updatedAt: fallbackUpdatedAt }
      : thread
  );
}

function normalizeCharacterIdList(value: unknown, characters: Character[], maxItems: number): CharacterId[] {
  const validIds = new Set(characters.map((character) => character.characterId));
  const allowAny = validIds.size === 0;
  const result: CharacterId[] = [];
  for (const id of asStringArray(value, maxItems * 2)) {
    if (!allowAny && !validIds.has(id)) continue;
    if (result.includes(id)) continue;
    result.push(id);
    if (result.length >= maxItems) break;
  }
  return result;
}

// NOTE: actor / recipient 用の単数版。**strict**:
//  - 人物一覧に無い ID は null に落とす（LLM 出力の混入防止）。
//  - characters が空でも null（allowAny 分岐を継承しない）。
//  - LLM パッチ経由（mergeEventRecords → normalizeEventPatch）で使う。
// 読み込み経路（characters=[] で保存済みデータをそのまま復元する経路）は、
// preserveStoredCharacterId を使う。両者を混同すると LLM が返した名前
// （"太郎"、"nobody" 等）が actor/recipient として保存され得るため、
// 関数ごと分けて別名にしている（引数フラグより誤用が起きにくい）。
function normalizeSingleCharacterId(
  value: unknown,
  characters: Character[]
): CharacterId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const validIds = new Set(characters.map((character) => character.characterId));
  return validIds.has(trimmed) ? trimmed : null;
}

// NOTE: 保存済み StoryState の読み込み専用。characters コンテキストなしで
// normalizeStoryState → normalizeEventRecord に流れるとき、既に検証済みの
// actor/recipient を破壊しないためだけの関数。書き込み経路で使ってはいけない。
function preserveStoredCharacterId(value: unknown): CharacterId | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function mergeUniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const key = normalizeComparableSummary(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function findCharacterByNameOrAlias(characters: Character[], value: string): Character | null {
  const normalized = normalizeComparableSummary(value);
  if (!normalized) return null;
  const candidates = characters.filter(
    (character) =>
      normalizeComparableSummary(character.name) === normalized ||
      (character.aliases ?? []).some(
        (alias) => normalizeComparableSummary(alias) === normalized
      )
  );
  // NOTE: LLM が名前だけを返した場合も、同名・同別名で任意の人物 ID を補完しない。
  return candidates.length === 1 ? candidates[0] : null;
}

function characterNameForId(characterId: string, characters: Character[]): string | null {
  return characters.find((character) => character.characterId === characterId)?.name ?? null;
}

export async function readStoryStateDiffs(projectId: string): Promise<StoryStateDiffRecord[]> {
  const diffs = await storage.readStoryStateDiffs(projectId);
  return normalizeDiffRecords(diffs);
}

export async function revertLatestStoryStateDiff(
  projectId: string,
  diffId: string
): Promise<{ storyState: StoryState; diff: StoryStateDiffRecord }> {
  return withStoryStateLock(projectId, async () => {
    const diffs = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
    const latest = findLatestRevertibleDiff(diffs);
    if (!latest || latest.diffId !== diffId) {
      throw new StoryStateServiceError(
        '取り消せるのは最新の自動更新だけです。',
        'story_state_diff_not_latest',
        409
      );
    }
    if (!latest.beforeState) {
      throw new StoryStateServiceError(
        'この自動更新は復元用データが残っていません。',
        'story_state_snapshot_missing',
        409
      );
    }

    const current = await readStoryState(projectId);
    if (current.updatedAt !== latest.resultUpdatedAt) {
      throw new StoryStateServiceError(
        '状態が手動編集されているため取り消せません。',
        'story_state_stale',
        409
      );
    }

    await storage.writeStoryState(projectId, latest.beforeState);
    const { beforeState: _beforeState, ...diffWithoutSnapshot } = latest;
    const nextDiff = { ...diffWithoutSnapshot, reverted: true };
    const nextDiffs = diffs.map((diff) => (diff.diffId === diffId ? nextDiff : diff));
    await storage.writeStoryStateDiffs(projectId, nextDiffs);
    return { storyState: latest.beforeState, diff: nextDiff };
  });
}

export async function revertLatestStoryStateDiffForGeneration(
  projectId: string,
  generationId: string
): Promise<boolean> {
  return withStoryStateLock(projectId, async () => {
    const diffs = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
    const latest = findLatestRevertibleDiff(diffs);
    if (!latest || latest.generationId !== generationId || !latest.beforeState) return false;
    const current = await readStoryState(projectId);
    if (current.updatedAt !== latest.resultUpdatedAt) return false;

    await storage.writeStoryState(projectId, latest.beforeState);
    const { beforeState: _beforeState, ...diffWithoutSnapshot } = latest;
    await storage.writeStoryStateDiffs(
      projectId,
      diffs.map((diff) =>
        diff.diffId === latest.diffId ? { ...diffWithoutSnapshot, reverted: true } : diff
      )
    );
    return true;
  });
}

export async function replaceStoryState(input: {
  projectId: string;
  storyState: unknown;
  characters: Character[];
}): Promise<StoryState> {
  return withStoryStateLock(input.projectId, async () => {
    const existing = await readStoryState(input.projectId);
    // NOTE: replace は保存済みデータの読み込みではなくユーザー入力の書き込み。
    // 人物が0件でも actor / recipient の任意文字列を通さない。
    const normalized = normalizeStoryState(input.storyState, nowIso(), input.characters, {
      strictActorRecipientIds: true,
    });
    const next: StoryState = {
      ...normalized,
      processedGenerationIds: existing.processedGenerationIds ?? [],
      updatedAt: nowIso(),
    };
    await storage.writeStoryState(input.projectId, next);
    return next;
  });
}

async function appendStoryStateDiff(
  projectId: string,
  record: StoryStateDiffRecord
): Promise<void> {
  const existing = normalizeDiffRecords(await storage.readStoryStateDiffs(projectId));
  const next = [record, ...existing].slice(0, MAX_DIFF_RECORDS);
  let snapshotsLeft = MAX_DIFF_SNAPSHOTS;
  const trimmed = next.map((diff) => {
    if (diff.reverted || !diff.beforeState) return diff;
    if (snapshotsLeft > 0) {
      snapshotsLeft -= 1;
      return diff;
    }
    const { beforeState: _beforeState, ...rest } = diff;
    return rest;
  });
  await storage.writeStoryStateDiffs(projectId, trimmed);
}

function normalizeDiffRecords(value: unknown): StoryStateDiffRecord[] {
  return asArray(value)
    .map((item): StoryStateDiffRecord | null => {
      if (!isRecord(item)) return null;
      const diffId = asString(item.diffId);
      const generationId = asString(item.generationId);
      const sceneId = asString(item.sceneId);
      if (!diffId || !generationId || !sceneId) return null;
      const beforeState = isRecord(item.beforeState)
        ? normalizeStoryState(item.beforeState, asString(item.appliedAt) || nowIso())
        : undefined;
      const previousUpdatedAt = asString(item.previousUpdatedAt);
      return {
        diffId,
        generationId,
        sceneId,
        appliedAt: asString(item.appliedAt) || nowIso(),
        ...(previousUpdatedAt ? { previousUpdatedAt } : {}),
        summary: normalizeDiffSummary(item.summary),
        ...(beforeState ? { beforeState } : {}),
        resultUpdatedAt: asString(item.resultUpdatedAt),
        reverted: item.reverted === true,
      };
    })
    .filter((item): item is StoryStateDiffRecord => item !== null)
    .slice(0, MAX_DIFF_RECORDS);
}

function normalizeDiffSummary(value: unknown): StoryStateDiffSummary {
  const record = isRecord(value) ? value : {};
  return {
    addedEvents: asStringArray(record.addedEvents, 8),
    updatedEvents: asStringArray(record.updatedEvents, 8),
    addedThreads: asStringArray(record.addedThreads, 8),
    resolvedThreads: asStringArray(record.resolvedThreads, 8),
    updatedCharacters: asStringArray(record.updatedCharacters, 8),
    clockChanged: record.clockChanged === true,
  };
}

function findLatestRevertibleDiff(diffs: StoryStateDiffRecord[]): StoryStateDiffRecord | null {
  return diffs.find((diff) => !diff.reverted) ?? null;
}

function summarizeDiff(
  previous: StoryState,
  next: StoryState,
  characters: Character[]
): StoryStateDiffSummary {
  const previousEvents = new Map(previous.importantEvents.map((event) => [event.eventId, event]));
  const addedEvents: string[] = [];
  const updatedEvents: string[] = [];
  for (const event of next.importantEvents) {
    const before = previousEvents.get(event.eventId);
    if (!before) {
      addedEvents.push(event.summary);
    } else if (JSON.stringify(before) !== JSON.stringify(event)) {
      updatedEvents.push(event.summary);
    }
  }

  const previousThreads = new Map(previous.openThreads.map((thread) => [thread.threadId, thread]));
  const addedThreads: string[] = [];
  const resolvedThreads: string[] = [];
  for (const thread of next.openThreads) {
    const before = previousThreads.get(thread.threadId);
    if (!before) {
      addedThreads.push(thread.summary);
    } else if (before.status !== 'resolved' && thread.status === 'resolved') {
      resolvedThreads.push(thread.summary);
    }
  }

  const previousCharacters = new Map(previous.characterStates.map((state) => [state.characterId ?? state.name, state]));
  const updatedCharacters = next.characterStates
    .filter((state) => {
      const before = previousCharacters.get(state.characterId ?? state.name);
      return !before || JSON.stringify(before) !== JSON.stringify(state);
    })
    .map((state) => characterNameForId(state.characterId ?? '', characters) ?? state.name)
    .filter(Boolean);

  return {
    addedEvents: addedEvents.slice(0, 8),
    updatedEvents: updatedEvents.slice(0, 8),
    addedThreads: addedThreads.slice(0, 8),
    resolvedThreads: resolvedThreads.slice(0, 8),
    updatedCharacters: mergeUniqueStrings(updatedCharacters).slice(0, 8),
    clockChanged: JSON.stringify(previous.clock) !== JSON.stringify(next.clock),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasField(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  return asArray(value)
    .map(asString)
    .filter(Boolean)
    .slice(0, maxItems);
}

function asImportance(value: unknown, fallback: MemoryImportance): MemoryImportance {
  return value === 'high' || value === 'medium' || value === 'low' ? value : fallback;
}

function asStatus(value: unknown, fallback: StoryItemStatus): StoryItemStatus {
  return value === 'active' || value === 'resolved' || value === 'archived' ? value : fallback;
}

function normalizeId(value: unknown, prefix: string): string {
  const text = asString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : generateTimestampId(prefix);
}

function normalizeComparableSummary(value: string): string {
  return normalizeComparableText(value);
}

export async function withStoryStateLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = storyStateMutexes.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  storyStateMutexes.set(projectId, next);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (storyStateMutexes.get(projectId) === next) {
      storyStateMutexes.delete(projectId);
    }
  }
}

export class StoryStateServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'StoryStateServiceError';
  }
}
