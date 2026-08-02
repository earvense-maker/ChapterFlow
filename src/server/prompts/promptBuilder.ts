import {
  getContextGenerationIdsThroughCurrentScene,
  getContextSummary,
  getCurrentSceneReferenceText,
  getRecentContext,
  getStoryState,
} from './contextAssembler.js';
import { resolveSystemPrompt } from './systemPrompt.js';
import {
  allocateSectionBudget,
  NOVEL_KNOWLEDGE_MAX_CHARS,
  NOVEL_RECENT_CONTEXT_MIN_CHARS,
  NOVEL_USER_PROMPT_MAX_CHARS,
  NOVEL_WORLD_MAX_CHARS,
  type BudgetSectionInput,
} from './promptBudget.js';
import {
  indentContinuation,
  renderAnnotatedDataBlock,
  renderDataBlock,
  sanitizePromptLabel,
} from './promptData.js';
import {
  renderChunkBody,
  selectKnowledgeChunksForPrompt,
  selectWorldChunksForPrompt,
  type PromptChunk,
  type PromptChunkQuery,
} from '../services/knowledgePromptSelector.js';
import { getApproximateOutputRange } from '../utils/outputLength.js';
import {
  matchStoryCharacterStates,
  type CharacterStateMatchResult,
} from '../utils/characterStateMatching.js';
import {
  splitWorldByConvention as splitWorldMdByConvention,
  type WorldSegment,
} from '../utils/worldMd.js';
import { trimTrailingTextToSentenceBoundary } from '../utils/textBoundary.js';
import { extractFrequentPhrases } from '../utils/phraseFrequency.js';
import { renderStyleLensPrompt } from '../services/styleVariationService.js';
import { normalizeStyleVariationSettings } from '../../shared/defaults.js';
import { buildIntimateVocalDirection } from './intimateVocalDirection.js';
import type { PromptBudgetEntry, PromptBudgetReport } from '../../shared/types/generation.js';
import type {
  Character,
  GenerationStyleProfile,
  Memory,
  Project,
  ProjectState,
  StoryEventRecord,
  StoryState,
} from '../types/index.js';

export interface BuildPromptInput {
  project: Project;
  state: ProjectState;
  wish: string;
  memories: Memory[];
  characters: Character[];
  worldText: string;
  baseSystemPrompt?: string | null;
  customSystemPrompt?: string | null;
  // NOTE: プロンプトには載せない。頻出フレーズの soft caution にNG語が紛れ込むと
  // 結局プロンプトへ語を注入することになるので、その除外のためだけに受け取る。
  bannedExpressions?: string[];
  knowledgeTexts?: Array<{ knowledgeId?: string; title: string; content: string }>;
  // NOTE: continue=続き, regenerate=書き直し（同じ場面）, variate=別案（同じ場面）。
  // 未指定なら continue 扱い。regenerate/variate では現在シーンの採用済み本文を
  // 文脈から除外して「同じ場面の別案」を書かせる。
  mode?: 'continue' | 'regenerate' | 'variate';
  styleProfile?: GenerationStyleProfile;
  // NOTE: null / 未指定は「自動」。wish の文字列解析で視点を決める旧挙動は廃止した
  // （「アキ視点は避ける」をアキ指定へ昇格させる事故があったため。設計書 4.8）。
  viewpointCharacterId?: string | null;
}

export interface BuildPromptResult {
  systemInstructions: string;
  userPrompt: string;
  budgetReport: PromptBudgetReport;
  /** 必須節の最低予約合計。user 予算をこれ未満へ下げても縮まない。 */
  requiredUserChars: number;
  /**
   * user prompt の予算だけを変えて組み立て直す。
   * 収集済みのセクションを使い回すので、ストレージ I/O もチャンク選択もやり直さない。
   */
  rebuildWithUserBudget: (userPromptMaxChars: number) => BuildPromptResult;
}

// NOTE: user prompt のセクションID。report とテストが参照するので文字列を変えないこと。
const SECTION = {
  core: 'user.coreConcept',
  world: 'user.worldSettings',
  characters: 'user.characters',
  relationships: 'user.relationships',
  knowledge: 'user.knowledge',
  currentState: 'user.currentState',
  knowledgeState: 'user.characterKnowledgeState',
  importantPast: 'user.importantPast',
  preferences: 'user.preferenceNotes',
  summary: 'user.contextSummary',
  recent: 'user.recentContext',
  rewriteTarget: 'user.rewriteTarget',
  frequentPhrases: 'user.frequentPhrases',
  styleLens: 'user.styleLens',
  styleSample: 'user.styleSample',
  sceneDirection: 'user.sceneDirection',
  outputConditions: 'user.outputConditions',
  wish: 'user.wish',
} as const;

const SECTION_SEPARATOR = '\n\n---\n\n';

// NOTE: 縮小順（先に縮めるものから）。設計書 4.2 の順をそのまま写す。
// 逆順が「拡張順＝守りたい順」になるので、allocateSectionBudget へは reverse して渡す。
const SHRINK_ORDER: readonly string[] = [
  SECTION.frequentPhrases,
  SECTION.knowledgeState,
  SECTION.preferences,
  SECTION.knowledge,
  SECTION.relationships,
  SECTION.importantPast,
  SECTION.summary,
  SECTION.world,
  SECTION.recent,
];

export async function buildPrompt(input: BuildPromptInput): Promise<BuildPromptResult> {
  const {
    project,
    state,
    wish,
    memories,
    characters,
    worldText,
    baseSystemPrompt,
    customSystemPrompt,
    bannedExpressions,
    knowledgeTexts,
    mode = 'continue',
    styleProfile,
  } = input;
  const isRewriteMode = mode === 'regenerate' || mode === 'variate';

  const resolved = await resolveSystemPrompt(
    project.activePresetIds,
    customSystemPrompt,
    baseSystemPrompt
  );
  const systemInstructions = resolved.systemPrompt;

  const viewpointCharacter = resolveViewpointCharacter(input.viewpointCharacterId, characters);
  const storyState = await getStoryState(project.projectId);

  const summarizedGenerationIds = state.contextSummary?.summarizedGenerationIds ?? [];
  const eligibleGenerationIds = new Set(
    await getContextGenerationIdsThroughCurrentScene(
      project.projectId,
      state.currentEpisodeId,
      state.currentSceneId,
      { includeCurrentScene: !isRewriteMode }
    )
  );
  // NOTE: context_summary.md は作品につき1本なので、過去場面へ戻ると要約に未来場面が
  // 含まれ得る。収録済みIDが現在位置prefixに収まる場合だけ要約を使い、収まらない回は
  // summarized扱いも外して、可能な範囲を原文のrecent contextへ戻す。
  const summaryFitsCurrentPosition =
    summarizedGenerationIds.length > 0 &&
    summarizedGenerationIds.every((generationId) => eligibleGenerationIds.has(generationId));
  const activeSummarizedGenerationIds = summaryFitsCurrentPosition
    ? new Set(summarizedGenerationIds)
    : new Set<string>();

  const recentContext = await getRecentContext(
    project.projectId,
    state.currentEpisodeId,
    state.currentSceneId,
    {
      includeCurrentScene: !isRewriteMode,
      // NOTE: 未要約の場面を通常枠の外でも残すために渡す。これが無いと、窓から落ちてから
      // 要約へ畳まれるまでの数場面がプロンプトから消える。
      summarizedGenerationIds: activeSummarizedGenerationIds,
    }
  );
  const contextSummary = summaryFitsCurrentPosition
    ? await getContextSummary(project.projectId)
    : '';
  const currentSceneText = isRewriteMode
    ? await getCurrentSceneReferenceText(
        project.projectId,
        state.currentEpisodeId,
        state.currentSceneId,
        state.selectedDraftGenerationId
      )
    : '';

  // 参考資料と世界設定は「使用中の全文」ではなく、今回の文脈に関連する断片を選ぶ。
  const chunkQuery = buildChunkQuery({
    wish,
    project,
    storyState,
    characters,
    viewpointCharacter,
    recentContext,
  });
  const worldSelection = selectWorldChunksForPrompt(worldText, chunkQuery, {
    maxChars: NOVEL_WORLD_MAX_CHARS,
  });
  const knowledgeSelection = selectKnowledgeChunksForPrompt(knowledgeTexts ?? [], chunkQuery, {
    maxChars: NOVEL_KNOWLEDGE_MAX_CHARS,
  });

  const characterMatches = matchStoryCharacterStates(characters, storyState.characterStates);
  if (characterMatches.diagnostics.length > 0) {
    console.warn('StoryState 人物照合に曖昧または重複があります', {
      diagnostics: characterMatches.diagnostics,
    });
  }

  const styleVariation = normalizeStyleVariationSettings(project.styleVariation);
  const variationEnabled = styleVariation?.enabled === true;
  const surfaceDecayEnabled = variationEnabled ? styleVariation.surfaceDecayEnabled : true;
  const frequentPhrases = surfaceDecayEnabled
    ? selectFrequentPhrases(
        recentContext,
        characters,
        bannedExpressions,
        variationEnabled ? styleVariation.motifExclusions : undefined
      )
    : [];

  const storyFactMemories = memories.filter(
    (m) => m.status === 'active' && m.importance === 'high' && m.type === 'storyFact'
  );
  const preferenceMemories = selectPreferenceMemories(memories);

  // NOTE: 大量データの後ろに【出力形式】と【今回の指示】を置き、具体的な希望を
  // プロンプトの最終行にする（設計書 4.4）。末尾追従の強いモデルほど効く。
  const sections: BudgetSectionInput[] = [];
  // NOTE: 整形済みの完成ブロックではなく「生本文 + 整形関数」を渡す。整形後の文字列を
  // そのまま切ると </data> の閉じタグごと落ちて区画が開きっぱなしになり、後続セクションが
  // データとして読まれてしまう（レビュー指摘 P1-1）。
  const push = (
    sectionId: string,
    body: string,
    options: Partial<Omit<BudgetSectionInput, 'sectionId' | 'body'>> = {}
  ) => {
    if (!body.trim()) return;
    sections.push({
      sectionId,
      body,
      hardMax: options.hardMax ?? NOVEL_USER_PROMPT_MAX_CHARS,
      minReserve: options.minReserve ?? 0,
      ...(options.render ? { render: options.render } : {}),
      ...(options.required === undefined ? {} : { required: options.required }),
      ...(options.keepTail === undefined ? {} : { keepTail: options.keepTail }),
    });
  };
  // 複数のデータブロックを持つセクションは、文字単位ではなくブロック単位で落とす。
  const pushUnits = (
    sectionId: string,
    units: string[],
    options: Partial<Omit<BudgetSectionInput, 'sectionId' | 'body' | 'units'>> = {}
  ) => {
    const present = units.filter((unit) => unit.trim());
    if (present.length === 0) return;
    sections.push({
      sectionId,
      body: present.join('\n\n'),
      units: present,
      hardMax: options.hardMax ?? NOVEL_USER_PROMPT_MAX_CHARS,
      minReserve: options.minReserve ?? 0,
      ...(options.required === undefined ? {} : { required: options.required }),
    });
  };

  push(SECTION.core, coreConceptBody(project), {
    required: true,
    minReserve: 1_200,
    render: renderCoreConcept,
  });
  pushUnits(SECTION.world, worldUnits(worldSelection.selected), {
    hardMax: NOVEL_WORLD_MAX_CHARS + 512,
  });
  push(SECTION.characters, charactersBody(characters), {
    required: true,
    minReserve: 2_000,
    render: renderCharacters,
  });
  push(SECTION.relationships, relationshipsBody(characters), { render: renderRelationships });
  pushUnits(SECTION.knowledge, knowledgeUnits(knowledgeSelection.selected), {
    hardMax: NOVEL_KNOWLEDGE_MAX_CHARS + 512,
  });
  push(SECTION.currentState, currentStateBody(storyState, characters, characterMatches), {
    required: true,
    minReserve: 2_000,
    render: renderCurrentState,
  });
  push(
    SECTION.knowledgeState,
    characterKnowledgeStateBody(storyState, characters, viewpointCharacter, characterMatches),
    { render: renderCharacterKnowledgeState }
  );
  push(SECTION.importantPast, importantPastBody(storyState, storyFactMemories, characters), {
    render: renderImportantPast,
  });
  push(SECTION.preferences, preferenceNotesBody(preferenceMemories), {
    render: renderPreferenceNotes,
  });
  push(SECTION.summary, contextSummary.trim(), { render: renderContextSummary });
  push(SECTION.recent, recentContext.trim(), {
    required: true,
    minReserve: NOVEL_RECENT_CONTEXT_MIN_CHARS,
    keepTail: true,
    render: (body) => renderRecentContext(body, isRewriteMode),
  });
  if (isRewriteMode) {
    push(SECTION.rewriteTarget, currentSceneText.trim(), {
      required: true,
      minReserve: 2_000,
      keepTail: true,
      render: (body) => renderRewriteTarget(body, mode),
    });
  }
  push(SECTION.frequentPhrases, renderFrequentPhraseNotice(frequentPhrases));
  if (variationEnabled) push(SECTION.styleLens, renderStyleLensPrompt(styleProfile));
  push(SECTION.styleSample, styleSampleBody(project), { render: renderStyleSample });
  const intimateVocalDirection = buildIntimateVocalDirection({
    intimacyPresetId: project.activePresetIds.intimacy,
    primaryText: wish,
    contextTexts: [
      recentContext.slice(-2_000),
      currentSceneText,
      storyState.currentSituation.join('\n'),
    ],
  });
  push(SECTION.sceneDirection, intimateVocalDirection, {
    required: true,
    minReserve: NOVEL_USER_PROMPT_MAX_CHARS,
  });
  push(SECTION.outputConditions, renderOutputConditions(project, viewpointCharacter), {
    required: true,
    minReserve: NOVEL_USER_PROMPT_MAX_CHARS,
  });
  push(SECTION.wish, renderWishSection(wish, mode), {
    required: true,
    minReserve: NOVEL_USER_PROMPT_MAX_CHARS,
  });

  // NOTE: トークン超過時は、収集済みのセクションを使い回して user 予算だけを下げ、
  // 再組み立てする（設計書 3.1 step 5）。ここで I/O をやり直さないために、
  // 組み立てだけをクロージャへ切り出す。
  const assemble = (userPromptMaxChars: number): BuildPromptResult => {
    // NOTE: セクションを繋ぐ区切りぶんを先に確保する。配分はセクション本文の合計しか
    // 見ないので、これを引かないと結合後に区切りの文字数だけ上限を超える。
    const separatorReserve = Math.max(0, sections.length - 1) * SECTION_SEPARATOR.length;
    const allocated = allocateSectionBudget({
      sections,
      totalMax: Math.max(0, userPromptMaxChars - separatorReserve),
      // 縮小順の逆＝守りたい順。拡張も同じ順で行う。
      reserveOrder: [...SHRINK_ORDER].reverse(),
    });

    const userPrompt = allocated.sections.map((section) => section.text).join(SECTION_SEPARATOR);
    const entries: PromptBudgetEntry[] = [
      ...resolved.budgetEntries,
      ...allocated.entries,
      buildChunkEntry('user.knowledgeChunks', knowledgeSelection),
      buildChunkEntry('user.worldChunks', worldSelection),
    ];

    return {
      systemInstructions,
      userPrompt,
      budgetReport: {
        maxChars: userPromptMaxChars,
        assembledChars: systemInstructions.length + userPrompt.length,
        entries,
      },
      // 必須節だけの合計。これ以上は縮められない下限として呼び出し側が使う。
      requiredUserChars: allocated.requiredChars,
      rebuildWithUserBudget: assemble,
    };
  };

  return assemble(NOVEL_USER_PROMPT_MAX_CHARS);
}

function buildChunkEntry(
  sectionId: string,
  selection: { selected: PromptChunk[]; totalCount: number; selectedChars: number }
): PromptBudgetEntry {
  return {
    sectionId,
    // NOTE: チャンク選択は文字数ではなく件数で見た方が利用者に伝わる。
    // originalChars/includedChars には件数ではなく実文字数を入れ、件数は UI 側で
    // entries から数える（report に原文を載せないため、ここでは数値だけ）。
    originalChars: selection.totalCount,
    includedChars: selection.selected.length,
    action: selection.selected.length === selection.totalCount ? 'full' : 'selected',
  };
}

function buildChunkQuery(input: {
  wish: string;
  project: Project;
  storyState: StoryState;
  characters: Character[];
  viewpointCharacter: Character | null;
  recentContext: string;
}): PromptChunkQuery {
  const terms: string[] = [];
  if (input.viewpointCharacter) {
    terms.push(input.viewpointCharacter.name, ...(input.viewpointCharacter.aliases ?? []));
  }
  for (const character of input.characters) {
    terms.push(character.name, ...(character.aliases ?? []));
  }

  const text = [
    input.wish,
    input.project.coreConcept ?? '',
    input.storyState.currentSituation.join('\n'),
    // 直近本文は末尾3,000字だけをクエリに使う。全文を使うと古い話題が上位に来る。
    input.recentContext.slice(-3_000),
  ]
    .filter(Boolean)
    .join('\n');

  return { terms: terms.filter((term) => term.trim().length > 0), text };
}

function resolveViewpointCharacter(
  viewpointCharacterId: string | null | undefined,
  characters: Character[]
): Character | null {
  if (!viewpointCharacterId) return null;
  return characters.find((c) => c.characterId === viewpointCharacterId) ?? null;
}

function coreConceptBody(project: Project): string {
  return project.coreConcept?.trim() ?? '';
}

function renderCoreConcept(core: string): string {
  return renderAnnotatedDataBlock(
    '【この作品の核】',
    [
      'この核が全編の羅針盤である。ユーザーが明示的に求めない限り、文言自体を本文で説明・言い換えず、展開・作風・場面の余韻で体現する。',
    ],
    core
  );
}

// NOTE: 世界設定と参考資料は複数のデータブロックを持つ。整形後の文字列を文字単位で
// 切ると途中の </data> が落ちて区画が開きっぱなしになるので、ブロック（ユニット）単位で
// 落とせる配列として返す（レビュー指摘 P1-1）。
function worldUnits(chunks: PromptChunk[]): string[] {
  if (chunks.length === 0) return [];
  const groups = new Map<string, string[]>();
  let previous: PromptChunk | null = null;
  for (const chunk of chunks) {
    const body = renderChunkBody(chunk, previous);
    const bucket = groups.get(chunk.sourceTitle) ?? [];
    bucket.push(body);
    groups.set(chunk.sourceTitle, bucket);
    previous = chunk;
  }

  const parts: string[] = [];
  for (const [title, bodies] of groups) {
    const heading =
      title === '開始時点の状況' ? '【世界設定（開始時点の状況）】' : '【世界設定】';
    const annotations =
      title === '開始時点の状況'
        ? [
            '以下は物語開始時点の状況である。進行によって変わった事柄は、採用済み本文と【現在状態スナップショット】を優先する。',
          ]
        : [];
    parts.push(renderAnnotatedDataBlock(heading, annotations, bodies.join('\n\n')));
  }
  return parts.filter(Boolean);
}

function knowledgeUnits(chunks: PromptChunk[]): string[] {
  if (chunks.length === 0) return [];
  const parts: string[] = [];
  let previous: PromptChunk | null = null;
  for (const chunk of chunks) {
    const body = renderChunkBody(chunk, previous);
    const label = sanitizePromptLabel(
      chunk.heading ? `${chunk.sourceTitle} / ${chunk.heading}` : chunk.sourceTitle
    );
    parts.push(renderDataBlock(`■ ${label}`, body));
    previous = chunk;
  }

  // units[0] が見出しと但し書き。これが入らなければセクションごと省略される。
  return [
    [
      '【参考資料】',
      '資料は必要になったときに引く辞書であり、順に読み上げる原稿ではない。今の場面に必要な設定・用語・事実関係の確認にだけ使う。',
      '説明文や箇条書きをそのまま要約・言い換えして本文へ転載しない。',
      '資料と直近本文・現在状態が矛盾する場合は、直近本文と現在状態を優先する。',
      '今回の場面に関連する断片だけを抜粋している。ここに無い記述も設定として存在しうる。',
    ].join('\n'),
    ...parts,
  ];
}

function charactersBody(characters: Character[]): string {
  if (characters.length === 0) return '';
  const lines = characters.map((c) => {
    const parts = [`- ${sanitizePromptLabel(c.name)}（${roleLabel(c.role)}）`];
    const aliases = (c.aliases ?? []).filter((alias) => alias.trim());
    if (aliases.length > 0) parts.push(`  呼び名: ${aliases.join(' / ')}`);
    if (c.description) parts.push(`  概要: ${indentContinuation(c.description.trim(), 4)}`);
    if (c.speechStyle) parts.push(`  口調: ${indentContinuation(c.speechStyle.trim(), 4)}`);
    if (c.secrets) {
      parts.push(
        `  見せない面（普段の言動には出さず、ふとした瞬間や限られた相手にだけ滲ませる）: ${indentContinuation(c.secrets.trim(), 4)}`
      );
    }
    for (const trait of c.traits ?? []) {
      parts.push(`  ${sanitizePromptLabel(trait.label)}: ${indentContinuation(trait.text, 4)}`);
    }
    return parts.join('\n');
  });
  return lines.join('\n');
}

function renderCharacters(body: string): string {
  return renderAnnotatedDataBlock(
    '【人物設定】',
    [
      '本文で順に紹介する項目一覧ではなく、整合性と舞台の質感を保つための背景情報である。',
      '時間とともに変化しうる記述は物語開始時点の情報として扱う。',
    ],
    body
  );
}

function relationshipsBody(characters: Character[]): string {
  return characters
    .filter((c) => c.relationshipNotes?.trim())
    .map((c) => `- ${sanitizePromptLabel(c.name)}: ${indentContinuation(c.relationshipNotes!.trim(), 2)}`)
    .join('\n');
}

function renderRelationships(body: string): string {
  return renderDataBlock('【関係性設定】', body);
}

export type { WorldSegment } from '../utils/worldMd.js';

export function splitWorldByConvention(worldText: string): WorldSegment[] {
  return splitWorldMdByConvention(worldText);
}

function currentStateBody(
  storyState: StoryState,
  characters: Character[],
  characterMatches: CharacterStateMatchResult
): string {
  const sections: string[] = [];

  const situationLines = [
    storyState.clock ? `- 物語内時間: ${formatClock(storyState.clock)}` : '',
    ...storyState.currentSituation.map((item) => `- ${item}`),
  ].filter(Boolean);
  if (situationLines.length > 0) {
    sections.push(`【現在の状況】\n${situationLines.join('\n')}`);
  }

  const characterLines = characters
    .map((character) => {
      const state = characterMatches.byCharacterId.get(character.characterId);
      const details: string[] = [];
      if (state?.currentState.trim()) {
        details.push(state.currentState.trim());
      } else if (character.currentState?.trim()) {
        details.push(`初期状態（現在状態未取得）: ${character.currentState.trim()}`);
      }
      if (state?.relationships.length) {
        details.push(`関係変化: ${state.relationships.join(' / ')}`);
      }
      return details.length > 0
        ? `- ${sanitizePromptLabel(character.name) || '（名前未設定）'}: ${details.join('。')}`
        : '';
    })
    .filter(Boolean);

  for (const state of characterMatches.unmatchedStates) {
    const details: string[] = [];
    if (state.currentState.trim()) details.push(state.currentState.trim());
    if (state.relationships.length) details.push(`関係変化: ${state.relationships.join(' / ')}`);
    if (details.length > 0) {
      characterLines.push(
        `- ${sanitizePromptLabel(state.name) || '（名前未設定）'}（未照合）: ${details.join('。')}`
      );
    }
  }

  if (characterLines.length > 0) {
    sections.push(`【人物の現在状態】\n${characterLines.join('\n')}`);
  }

  const openThreads = storyState.openThreads.filter((thread) => thread.status === 'active');
  if (openThreads.length > 0) {
    sections.push(
      `【未解決事項】\n${openThreads.map((thread) => `- ${thread.summary}`).join('\n')}`
    );
  }

  const authorUndecided = (storyState.authorUndecided ?? []).filter(
    (item) => item.status === 'active'
  );
  if (authorUndecided.length > 0) {
    sections.push(
      `【まだ確定させないこと】\n作者がまだ決めていない事項である。作中で真相・答え・正体を確定させず、曖昧さを保ったまま書く。\n${authorUndecided
        .map((item) => `- ${item.text}${item.reason ? `（${item.reason}）` : ''}`)
        .join('\n')}`
    );
  }

  return sections.join('\n\n');
}

function renderCurrentState(body: string): string {
  return renderAnnotatedDataBlock(
    '【現在状態スナップショット】',
    ['物語の現在地を示す事実メモである。本文はこれらの事実、物語内時間、これまでの本文と矛盾しないように書く。'],
    body
  );
}

function importantPastBody(
  storyState: StoryState,
  memories: Memory[],
  characters: Character[]
): string {
  const storyFacts = memories.filter((m) => m.type === 'storyFact');
  const events = storyState.importantEvents.filter((event) => event.status !== 'archived');
  const parts: string[] = [];

  if (events.length > 0) {
    parts.push(
      `【採用済み本文から抽出した重要イベント】\n${events
        .map((event) => {
          const knownNames = (event.knownBy ?? [])
            .map((id) => characterNameForId(id, characters))
            .filter(Boolean);
          const actorLabel = renderActorLine(event, characters);
          const meta = [
            event.importance !== 'medium' ? `重要度: ${event.importance}` : '',
            actorLabel ? `主体: ${actorLabel}` : '',
            event.characters.length > 0 ? `関係人物: ${event.characters.join(' / ')}` : '',
            knownNames.length > 0
              ? `知っている人物: ${knownNames.join(' / ')}`
              : event.visibility
                ? `認識範囲: ${event.visibility}`
                : '',
          ].filter(Boolean);
          return `- ${event.summary}${meta.length > 0 ? `（${meta.join('、')}）` : ''}`;
        })
        .join('\n')}`
    );
  }

  if (storyFacts.length > 0) {
    parts.push(`【手動メモの物語事実】\n${storyFacts.map((m) => `- ${m.content}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

function renderImportantPast(body: string): string {
  return renderDataBlock('【重要な過去イベント】', body);
}

function preferenceNotesBody(memories: Memory[]): string {
  const preferences = memories.filter((m) => m.type === 'preference');
  const negatives = memories.filter((m) => m.type === 'negative');

  const parts: string[] = [];
  if (preferences.length > 0) {
    parts.push(`【好み】\n${preferences.map((m) => `- ${m.content}`).join('\n')}`);
  }
  if (negatives.length > 0) {
    // NOTE: ここの【NG】はプリファレンス寄り（「性描写を露骨に書かない」等の方向指示）。
    // 言い回し単位の登録NGはプロンプトに載せず、出力後の検出と局所リライトで扱う。
    parts.push(`【NG】\n${negatives.map((m) => `- ${m.content}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

function renderPreferenceNotes(body: string): string {
  return renderDataBlock('【好み・NG】', body);
}

function renderContextSummary(body: string): string {
  return renderAnnotatedDataBlock(
    '【これまでの要約】',
    ['長く続いた作品本文を圧縮した作品データである。'],
    body
  );
}

function renderRecentContext(body: string, isRewriteMode: boolean): string {
  const heading = isRewriteMode
    ? '【これまでの作品本文（直近／今回書き直す場面より前まで）】'
    : '【これまでの作品本文（直近）】';
  return renderDataBlock(heading, body);
}

function renderRewriteTarget(
  body: string,
  mode: 'continue' | 'regenerate' | 'variate'
): string {
  const label = mode === 'variate' ? '別案を作る対象' : '書き直しの対象';
  // NOTE: 「話を進めない」はここと最終行の2箇所だけに置く（設計書 4.6）。
  // 以前は出力形式・希望・優先順位にも重複していて、どれが効いているか切り分けられなかった。
  return renderAnnotatedDataBlock(
    `【今回${label}となる場面】`,
    [
      `これがまさに${label}。話を先に進めず、この場面と同じ時系列位置に留まる。以下は事実と時系列位置の参照であり、表現・構成・言い回しを維持する義務はない。`,
    ],
    body
  );
}

function styleSampleBody(project: Project): string {
  const sample = project.styleSample?.trim();
  if (!sample) return '';
  return trimTrailingTextToSentenceBoundary(sample.slice(0, 1000));
}

function renderStyleSample(styleSample: string): string {
  return renderAnnotatedDataBlock(
    '【文体見本】',
    [
      '文体・リズム・描写の密度の見本である。内容・人物・出来事は本編と無関係であり、参照しない。書き方だけを参考にする。',
      '文体・リズム・描写密度が文体設定と食い違う場合は見本を優先する。ただし人称・視点人物・【出力形式】の指定は上書きしない。',
    ],
    styleSample
  );
}

function characterKnowledgeStateBody(
  storyState: StoryState,
  characters: Character[],
  viewpointCharacter: Character | null,
  characterMatches: CharacterStateMatchResult
): string {
  const events = storyState.importantEvents.filter((event) => event.status !== 'archived');
  const orderedCharacters = viewpointCharacter
    ? [
        viewpointCharacter,
        ...characters.filter(
          (character) => character.characterId !== viewpointCharacter.characterId
        ),
      ]
    : characters;
  const rows: string[] = [];

  for (const character of orderedCharacters) {
    const known: string[] = [];
    const state = characterMatches.byCharacterId.get(character.characterId);
    // NOTE: knowledge は末尾追加型（mergeKnowledgeList）で、末尾ほど新しい。
    // 描画は先頭6件を取るため、そのまま push すると新規追加が押し出される。
    // ここで末尾6件だけ取ったうえで、reverse して新しい方を先頭に置く。
    if (state?.knowledge.length) {
      known.push(...state.knowledge.slice(-6).reverse());
    }
    const knownEvents = events
      .filter((event) => (event.knownBy ?? []).includes(character.characterId))
      .sort((a, b) => {
        const importance = importanceRank(b.importance) - importanceRank(a.importance);
        if (importance !== 0) return importance;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, 6)
      .map((event) => event.summary);
    known.push(...knownEvents);
    // NOTE: 反転運用で unknown 側が大量に膨らむため、known 側と同じ並び順と上限を適用する。
    // 視点人物は 12 件、それ以外は 6 件まで。
    const isViewpoint =
      viewpointCharacter != null && character.characterId === viewpointCharacter.characterId;
    const unknownCap = isViewpoint ? 12 : 6;
    const unknownEvents = events
      .filter(
        (event) =>
          !(event.knownBy ?? []).includes(character.characterId) &&
          (event.explicitlyUnknownBy ?? []).includes(character.characterId)
      )
      .sort((a, b) => {
        const importance = importanceRank(b.importance) - importanceRank(a.importance);
        if (importance !== 0) return importance;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, unknownCap)
      .map((event) => event.summary);
    const knownLines = dedupeText(known).slice(0, 6);
    const unknownLines = dedupeText(unknownEvents).slice(0, unknownCap);
    if (knownLines.length === 0 && unknownLines.length === 0) continue;
    const details = [`- ${sanitizePromptLabel(character.name)}`];
    if (knownLines.length > 0) details.push(`  知っている: ${knownLines.join(' / ')}`);
    if (unknownLines.length > 0) details.push(`  まだ知らない: ${unknownLines.join(' / ')}`);
    rows.push(details.join('\n'));
  }

  for (const state of characterMatches.unmatchedStates) {
    const knownLines = dedupeText(state.knowledge.slice(-6).reverse()).slice(0, 6);
    if (knownLines.length === 0) continue;
    rows.push(
      `- ${sanitizePromptLabel(state.name) || '（名前未設定）'}（未照合）\n  知っている: ${knownLines.join(' / ')}`
    );
  }

  return rows.join('\n');
}

function renderCharacterKnowledgeState(body: string): string {
  return renderAnnotatedDataBlock(
    '【人物の情報状態】',
    [
      '「まだ知らない」とされた事実は、その人物の台詞・内心・行動の根拠・その人物視点の地の文に出さない。',
      'その人物が同席しない場面での噂話・比喩・伏線としても、既知であるかのように扱わない。',
    ],
    body
  );
}

function dedupeText(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const key = text.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function formatClock(clock: NonNullable<StoryState['clock']>): string {
  const parts = [`${clock.day}日目`];
  if (clock.timeOfDay) parts.push(clock.timeOfDay);
  const text = parts.join('・');
  return clock.note ? `${text}（${clock.note}）` : text;
}

function characterNameForId(characterId: string, characters: Character[]): string | null {
  return characters.find((character) => character.characterId === characterId)?.name ?? null;
}

// NOTE: actor / recipient を「主体: 太郎 → 花子」の形にレンダリング。
// - actor 未指定なら空文字（呼び元でメタ行から落とす）。
// - 人物一覧に無い ID（削除済みなど）は ID をそのまま出す（フォールバック）。
function renderActorLine(event: StoryEventRecord, characters: Character[]): string {
  const actorId = event.actor ?? null;
  if (!actorId) return '';
  const actorName = characterNameForId(actorId, characters) ?? actorId;
  const recipientId = event.recipient ?? null;
  if (!recipientId) return actorName;
  const recipientName = characterNameForId(recipientId, characters) ?? recipientId;
  return `${actorName} → ${recipientName}`;
}

function roleLabel(role: Character['role']): string {
  const map: Record<Character['role'], string> = {
    protagonist: '主人公',
    deuteragonist: '相手役',
    supporting: '脇役',
    other: 'その他',
  };
  return map[role];
}

function selectPreferenceMemories(memories: Memory[]): Memory[] {
  return memories
    .filter(
      (m) =>
        m.status === 'active' &&
        (m.type === 'preference' || m.type === 'negative') &&
        (m.importance === 'high' || m.importance === 'medium')
    )
    .sort((a, b) => {
      const importance = importanceRank(b.importance) - importanceRank(a.importance);
      if (importance !== 0) return importance;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 16);
}

function importanceRank(value: Memory['importance']): number {
  if (value === 'high') return 2;
  if (value === 'medium') return 1;
  return 0;
}

function selectFrequentPhrases(
  recentContext: string,
  characters: Character[],
  bannedExpressions: string[] | undefined,
  motifExclusions: string[] | undefined
): string[] {
  if (!recentContext.trim()) return [];

  const characterTokens = characters
    .flatMap((character) => [character.name, ...(character.aliases ?? [])])
    .map(normalizeExpressionText)
    .filter(Boolean);
  const banned = new Set(
    (bannedExpressions ?? []).map(normalizeExpressionText).filter(Boolean)
  );
  const excludedMotifs = (motifExclusions ?? [])
    .map(normalizeExpressionText)
    .filter(Boolean);

  return extractFrequentPhrases(recentContext)
    .map((item) => item.text)
    .filter((text) => {
      const normalized = normalizeExpressionText(text);
      if (!normalized || banned.has(normalized)) return false;
      if (excludedMotifs.some((motif) => normalized.includes(motif))) return false;
      return !characterTokens.some((token) => normalized.includes(token));
    })
    .slice(0, 8);
}

function normalizeExpressionText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase();
}

// NOTE: 直近本文の頻出フレーズ。soft caution。登録NGとは意味論が違うため（あくまで
// 「多用回避」の弱い指示）、セクションも分ける。
function renderFrequentPhraseNotice(frequentPhrases: string[]): string {
  if (frequentPhrases.length === 0) return '';
  const lines = frequentPhrases.map((text) => `- 「${text}」`).join('\n');
  return `【表現の重複を避ける】\n以下の表現は直近の本文で繰り返し使われている。多用を避け、同じ意味は別の言い方で書く。\n${lines}`;
}

// NOTE: 文字数上限は「守るべき優先順位の4位」ではなく必須の出力条件として書く。
// 優先順位の一項目にすると、上位項目との天秤で無視されやすかった（設計書 4.5）。
function renderOutputConditions(project: Project, viewpointCharacter: Character | null): string {
  const outputRange = getApproximateOutputRange(project.outputLength);
  // NOTE: 自動（viewpointCharacterId = null）では人物名の hard rule を作らない。
  // 代わりに「直近の視点を維持し、場面内で切り替えない」という規則だけを置く（設計書 4.8）。
  const viewpointLine = viewpointCharacter
    ? `視点人物: ${sanitizePromptLabel(viewpointCharacter.name)}。地の文は${sanitizePromptLabel(viewpointCharacter.name)}が知覚・推測できる範囲で書く。`
    : '視点人物: 直近本文の視点を維持する。直近本文から一意に判断できない場合は、場面に最も自然な人物を選び、場面内で視点を切り替えない。';

  return [
    '【出力形式】',
    '- 日本語の小説本文のみ。前置き・後書き・設定の説明は書かない。',
    `- 上限は約${outputRange.upper}字。${outputRange.target}字前後を標準としつつ、場面が求める密度に応じてそれより短くてよい。すでに書いたことを別の言い方で繰り返して字数を稼がない。場面が自然に閉じる位置で終える。`,
    '- 物語内時間と矛盾する時間経過・時間帯を書かない。時間を進める場合は本文中で自然に示す。',
    `- ${viewpointLine}`,
  ].join('\n');
}

// NOTE: 実際の希望をプロンプトの最終行にする。以前は希望の後ろに優先順位と一般論が
// 4段落続き、末尾追従の強いモデルほど具体的な希望より一般論を強く受け取っていた。
function renderWishSection(wish: string, mode: 'continue' | 'regenerate' | 'variate'): string {
  return [
    '【今回の指示】',
    '今回の希望が既存事実の変更を明示する場合は、その変更を適用する。',
    'それ以外の食い違いは、採用済み本文 ＞ 現在状態・重要イベント ＞ 作品設定・参考資料 の順に扱う。',
    resolveWishLine(wish, mode),
  ].join('\n');
}

function resolveWishLine(wish: string, mode: 'continue' | 'regenerate' | 'variate'): string {
  const trimmed = wish.trim();
  if (mode === 'variate') {
    return trimmed ? `${trimmed}\n同じ場面の別案を書く。` : '同じ場面の別案を書く。';
  }
  if (mode === 'regenerate') {
    return trimmed
      ? `${trimmed}\nこの場面を同じ時系列位置のまま書き直す。`
      : 'この場面を同じ時系列位置のまま書き直す。';
  }
  return trimmed || '今の場面と雰囲気を引き継いで続きを書く。';
}
