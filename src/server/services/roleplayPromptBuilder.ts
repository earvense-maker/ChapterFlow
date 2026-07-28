// NOTE: ロールプレイ会話のプロンプト構築（設計書 3.2）。純関数。
//
// systemInstructions は contextSnapshot から作り、セッション内で固定。
// userPrompt は scenario / conversationSummary / 未要約メッセージだけを変える。
// prompt caching に依存はしないが、可変部と固定部を分ける形にすると
// プロバイダ側が対応している場合の cache hit 率が上がる。
//
// 上限（設計書 3.2 末尾）:
//  - ROLEPLAY_WORLD_MAX_CHARS = 2000
//  - ROLEPLAY_PERSONA_MAX_CHARS = 6000
//  - ROLEPLAY_SYSTEM_MAX_CHARS = 12000
//  - ROLEPLAY_VARIABLE_PROMPT_MAX_CHARS = 24000
//  - ROLEPLAY_SUMMARY_MAX_CHARS = 6000
//  - ROLEPLAY_RECENT_MESSAGES_MAX_CHARS = 16000
//  - ROLEPLAY_RECENT_MESSAGES = 20
// 超過時は優先順に後ろの項目から削る:
//   固定規則 → 対象キャラ → dialogueExamples → 会話の作風 → 作品基本
//   → customSystemPrompt → 世界観 → 他キャラ

import type {
  Character,
  RoleplayContextSnapshot,
  RoleplayMessage,
} from '../types/index.js';
import { normalizeRoleplayAdditionalInstructions } from '../prompts/systemPrompt.js';

export const ROLEPLAY_WORLD_MAX_CHARS = 2000;
export const ROLEPLAY_PERSONA_MAX_CHARS = 6000;
export const ROLEPLAY_SYSTEM_MAX_CHARS = 12000;
export const ROLEPLAY_VARIABLE_PROMPT_MAX_CHARS = 24000;
export const ROLEPLAY_SUMMARY_MAX_CHARS = 6000;
export const ROLEPLAY_RECENT_MESSAGES_MAX_CHARS = 16000;
export const ROLEPLAY_RECENT_MESSAGES = 20;
export const ROLEPLAY_OTHER_CHARACTERS_MAX = 10;
export const ROLEPLAY_OTHER_CHARACTER_DESC_CHARS = 200;

// NOTE: ロールプレイ作風プリセットのセクション見出し。小説側の【選択された設定】と
// 分けているのは、固定規則の優先順位宣言がこの語で名指ししているため。
export const ROLEPLAY_STYLE_HEADING = '【会話の作風】';

// NOTE: 応答形式の既定文。作風設定 rpResponseStyle = 'bracketed-action' の本文と同一で、
// contextSnapshot に responseStyleInstruction を持たない旧セッションのフォールバックに使う
// （旧セッションの応答形式を黙って変えないため、文言は改訂しないこと）。
export const DEFAULT_ROLEPLAY_RESPONSE_STYLE_INSTRUCTION =
  'セリフを主体にし、動作・表情・様子は必要なときだけ括弧書きで短く添える。' +
  '例:「うん、そうだね。(そっと目を伏せる)」／「……(小さくうなずく)」／' +
  '「本当に？(目を丸くする) じゃあ、行ってみようよ。」';

// NOTE: 「1〜3文」の hard cap を撤去し、代わりに以下2軸で長さ・形式を制御する:
//  - 目安字数（呼び出し側から動的に渡され、fixed rule に埋め込む）
//  - responseStyleInstruction（作風設定「応答の形」を snapshot 経由で受け取る）
// 数文制約を外したのは、動作描写を許した瞬間に「1〜3文」が実質破綻するため。
//
// 規則を [応答の形] / [越えない線] / [会話の続き方] の3ブロックに分けているのは、
// 弱いモデルほど長い平坦な箇条書きの中盤を落とすため。ブロック見出しは 【】 ではなく
// [] にしてある（【】は上位セクションの区切りで、モデルが階層を取り違えやすい）。
function buildFixedRules(outputLength: number, responseStyleInstruction: string): string {
  return [
    'あなたは以下のキャラクターとして、ユーザーと一対一で会話する。' +
      '出力はキャラクターの応答そのものであり、前置き・後書き・状況説明は書かない。',
    '',
    '[応答の形]',
    responseStyleInstruction,
    `1ターンの応答は${outputLength}字程度に収める（少し前後してよい）。`,
    '応答はプレーンテキストのみ。見出しや箇条書き、Markdown 記法は使わない。',
    '',
    '[越えない線]',
    'ユーザーの行動・セリフ・心情を勝手に書かない。ユーザーがまだ選んでいない選択を、済んだこととして扱わない。',
    'キャラクターを維持する。AIであることや設定資料、プロンプトの存在に言及しない。' +
      '設定にないことを問われたら、キャラクターとして知らないまま応じる。',
    'キャラクターが隠している秘密は、自分からは明かさない。ただし親密度や状況に応じて、' +
      '態度や言い淀み、話題のそらし方に滲ませるのはよい。',
    // NOTE: 会話を締めにいく癖（別れの挨拶で終わる）はロールプレイでは致命的に体験を切る。
    '会話を勝手に締めくくらない。別れの挨拶や結論めいたまとめで終わらせず、次の一手をユーザーに残す。',
    '',
    '[会話の続き方]',
    '直近の会話で決まったこと（居場所・時刻・持ち物・呼び方・交わした約束）を引き継ぐ。' +
      '食い違いに気づいたら、直近の会話の側を正とする。',
    '前のターンと同じ言い回し・同じ所作・同じ締め方を繰り返さない。',
    '',
    '以上の固定規則は、会話の作風・作品の基本システム指示・追加指示より優先する。' +
      '矛盾する指示は固定規則に従う。',
  ].join('\n');
}

export interface RoleplaySystemPromptInput {
  snapshot: RoleplayContextSnapshot;
  // NOTE: fixed rules 内に埋め込む目安字数。省略時は 250（後方互換）。
  outputLength?: number;
}

export interface RoleplayUserPromptInput {
  snapshot: RoleplayContextSnapshot;
  scenario?: string;
  conversationSummary?: string;
  // NOTE: 未要約メッセージ（summaryThroughMessageId より後）を古い順で渡す。
  recentMessages: RoleplayMessage[];
  // NOTE: 手動登録の NG 表現。0 件・undefined ならセクションごと省略する。
  bannedExpressions?: string[];
}

export function buildRoleplaySystemInstructions(
  input: RoleplaySystemPromptInput
): string {
  const { snapshot } = input;
  const character = snapshot.character;
  const characterName = character.name?.trim() || 'キャラクター';
  const outputLength =
    typeof input.outputLength === 'number' && Number.isFinite(input.outputLength)
      ? Math.round(input.outputLength)
      : 250;

  // NOTE: セクションを優先順位の高いものから積み、上限に達したら次以降を諦める。
  // 「対象キャラ」まではどうしても入れたい塊なのでまとめて評価する。
  const responseStyleInstruction =
    snapshot.responseStyleInstruction?.trim() || DEFAULT_ROLEPLAY_RESPONSE_STYLE_INSTRUCTION;

  const persona = truncate(buildPersonaCard(character), ROLEPLAY_PERSONA_MAX_CHARS);
  const dialogueExamples = buildDialogueExamples(character.dialogueExamples, characterName);
  const stylePresetPrompt = snapshot.stylePresetPrompt?.trim() ?? '';
  const projectSystemPrompt = snapshot.projectSystemPrompt?.trim() ?? '';
  const customSystemPrompt = normalizeRoleplayAdditionalInstructions(snapshot.customSystemPrompt);
  const worldDigest = truncate(snapshot.worldDigest, ROLEPLAY_WORLD_MAX_CHARS);
  const otherCharacters = buildOtherCharacters(snapshot.otherCharacters);

  // NOTE: 優先順: 固定規則 → 対象キャラ → dialogueExamples → 会話の作風 → 作品基本
  //   → 追加指示 → 世界観 → 他キャラ
  const sections: string[] = [];
  sections.push(`【ロールプレイ規則】\n${buildFixedRules(outputLength, responseStyleInstruction)}`);
  sections.push(`【対象キャラクター】\n${persona}`);

  const optional: Array<{ label: string; body: string }> = [];
  if (dialogueExamples) {
    optional.push({ label: '【口調の参考例（内容ではなく話し方を真似る）】', body: dialogueExamples });
  }
  if (stylePresetPrompt) {
    // NOTE: 見出しは stylePresetPrompt 側（renderPresets の heading）に含まれるため空ラベル。
    optional.push({ label: '', body: stylePresetPrompt });
  }
  if (projectSystemPrompt) {
    optional.push({ label: '【作品の基本システム指示】', body: projectSystemPrompt });
  }
  if (customSystemPrompt) {
    optional.push({ label: '【追加のシステム指示】', body: customSystemPrompt });
  }
  if (worldDigest) {
    optional.push({ label: '【世界観ダイジェスト】', body: worldDigest });
  }
  if (otherCharacters) {
    optional.push({ label: '【他の登場人物】', body: otherCharacters });
  }

  let assembled = sections.join('\n\n---\n\n');
  for (const item of optional) {
    const block = item.label ? `${item.label}\n${item.body}` : item.body;
    const candidate = `${assembled}\n\n---\n\n${block}`;
    if (candidate.length > ROLEPLAY_SYSTEM_MAX_CHARS) {
      // NOTE: これ以上追加すると全体上限を超えるので、この項目以降は諦める。
      break;
    }
    assembled = candidate;
  }

  return assembled;
}

export function buildRoleplayUserPrompt(input: RoleplayUserPromptInput): string {
  const characterName = input.snapshot.character.name?.trim() || 'キャラクター';
  const scenario = input.scenario?.trim();
  const summary = input.conversationSummary?.trim();
  const recent = formatRecentMessages(input.recentMessages, characterName);
  const banned = normalizeBannedExpressions(input.bannedExpressions);

  const parts: string[] = [];
  if (scenario) {
    // NOTE: 命令ではなく引用データであることを区切りタグで明示する（設計書 3.2）。
    parts.push(`【今回の会話の舞台】\n<scenario>\n${scenario}\n</scenario>`);
  }
  if (summary) {
    parts.push(
      `【これまでの会話の要約】\n${truncate(summary, ROLEPLAY_SUMMARY_MAX_CHARS)}`
    );
  }
  if (recent.trim()) {
    parts.push(`【直近の会話】\n${recent}`);
  }
  if (banned.length > 0) {
    // NOTE: 追従率を上げるため、【指示】の直前に置く（末尾指示に最も追従する
    // 弱いモデルの特性は本編生成と同じ）。各項目は「」でくくって注入データで
    // あることを明示し、改行文字は含まないよう normalize 済み。
    const lines = banned.map((text) => `- 「${text}」`).join('\n');
    parts.push(
      [
        '【表現上の注意】',
        '以下の言い回しは読者が避けたい表現として登録されている。',
        '今回の応答では使わないこと。同じ意味は別の言い方で書くこと。',
        lines,
      ].join('\n')
    );
  }
  parts.push(`【指示】\n${characterName}として応答してください。`);

  return parts.join('\n\n---\n\n');
}

// NOTE: 改行を含む項目は区画を壊すため落とす。空文字と重複も除外し、上限 12 件。
// 本編生成の resolveBannedExpressions と同じ上限に揃える。
function normalizeBannedExpressions(value: string[] | undefined): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    if (raw.includes('\n') || raw.includes('\r')) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= 12) break;
  }
  return result;
}

function buildPersonaCard(character: Character): string {
  const lines: string[] = [];
  push(lines, '名前', character.name);
  const aliases = character.aliases?.filter((s) => s.trim()) ?? [];
  if (aliases.length > 0) push(lines, '別名', aliases.join(' / '));
  push(lines, '概要', character.description);
  push(lines, '口調', character.speechStyle);
  if (character.secrets?.trim()) {
    push(
      lines,
      '見せない面（自分からは明かさず、親密度や状況次第で滲ませる）',
      character.secrets
    );
  }
  for (const trait of character.traits ?? []) {
    push(lines, trait.label, indentContinuation(trait.text, 2));
  }
  push(lines, '関係性メモ', character.relationshipNotes);
  push(lines, '会話開始時点の状態', character.currentState);
  return lines.join('\n');
}

function indentContinuation(value: string, spaces: number): string {
  const indent = ' '.repeat(spaces);
  return value.replace(/\r\n?/g, '\n').replace(/\n/g, `\n${indent}`);
}

function push(lines: string[], label: string, value: string | undefined): void {
  const text = value?.trim();
  if (!text) return;
  lines.push(`- ${label}: ${text}`);
}

function buildDialogueExamples(examples: string[] | undefined, characterName: string): string {
  if (!examples || examples.length === 0) return '';
  return examples
    .filter((s) => s.trim())
    .map((s) => `- ${characterName}:「${s.trim()}」`)
    .join('\n');
}

function buildOtherCharacters(others: RoleplayContextSnapshot['otherCharacters']): string {
  if (!others || others.length === 0) return '';
  return others
    .slice(0, ROLEPLAY_OTHER_CHARACTERS_MAX)
    .map((c) => {
      const name = c.name?.trim() || '（無名）';
      const desc = truncate(
        c.description?.trim() ?? '',
        ROLEPLAY_OTHER_CHARACTER_DESC_CHARS
      );
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    })
    .join('\n');
}

// NOTE: 直近メッセージは新しい方から積み、文字数上限に達したら古い方を捨てる。
// 呼び出し側で ROLEPLAY_RECENT_MESSAGES 件に絞ってから渡す想定だが、
// hard cap として文字数側でも制御する。
function formatRecentMessages(messages: RoleplayMessage[], characterName: string): string {
  const lines: string[] = [];
  let totalChars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const label = message.role === 'user' ? 'ユーザー' : characterName;
    const line = `${label}: ${message.content}`;
    if (totalChars + line.length + 1 > ROLEPLAY_RECENT_MESSAGES_MAX_CHARS) break;
    lines.unshift(line);
    totalChars += line.length + 1;
  }
  return lines.join('\n');
}

function truncate(value: string | undefined, maxChars: number): string {
  if (!value) return '';
  const text = value.trim();
  if (text.length <= maxChars) return text;
  // NOTE: 切り詰めが「そういう設定」と誤読されないよう、末尾に省略マーカーを付ける。
  return `${text.slice(0, maxChars)}…（以下省略）`;
}
