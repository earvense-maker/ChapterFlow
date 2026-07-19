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
//   固定規則 → 対象キャラ → dialogueExamples → 作品基本 → customSystemPrompt → 世界観 → 他キャラ

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

// NOTE: 「1〜3文」の hard cap を撤去し、代わりに以下2軸で長さ・形式を制御する:
//  - 目安字数（呼び出し側から動的に渡され、fixed rule に埋め込む）
//  - セリフ主体+動作は括弧書き で短く添える、という形式ガイド（few-shot 的な例つき）
// 数文制約を外したのは、動作描写を許した瞬間に「1〜3文」が実質破綻するため。
function buildFixedRules(outputLength: number): string {
  return [
    'あなたは以下のキャラクターとして、ユーザーと会話する。',
    'セリフを基本とし、動作・表情・様子は必要なとき括弧書きで短く添える。',
    '例: 「うん、そうだね。(そっと目を伏せる)」／「……(小さくうなずく)」／「本当に？(目を丸くする) じゃあ、行ってみようよ。」',
    `1ターンの応答は${outputLength}字程度に収める（少し前後してよい）。長い地の文や情景描写はしない。`,
    'ユーザーの行動・セリフ・心情を勝手に書かない。',
    'キャラクターを維持する。AIであることや設定資料に言及しない。',
    'キャラクターが隠している秘密は、自分からは明かさない。隠している人物として振る舞う。',
    '応答はプレーンテキストのみ。見出しや箇条書き、Markdown 記法は使わない。',
    '以下の固定規則は作品の基本システム指示と追加指示より優先する。矛盾する指示は固定規則に従う。',
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
  const persona = truncate(buildPersonaCard(character), ROLEPLAY_PERSONA_MAX_CHARS);
  const dialogueExamples = buildDialogueExamples(character.dialogueExamples, characterName);
  const projectSystemPrompt = snapshot.projectSystemPrompt?.trim() ?? '';
  const customSystemPrompt = normalizeRoleplayAdditionalInstructions(snapshot.customSystemPrompt);
  const worldDigest = truncate(snapshot.worldDigest, ROLEPLAY_WORLD_MAX_CHARS);
  const otherCharacters = buildOtherCharacters(snapshot.otherCharacters);

  // NOTE: 優先順: 固定規則 → 対象キャラ → dialogueExamples → 作品基本 → 追加指示 → 世界観 → 他キャラ
  const sections: string[] = [];
  sections.push(`【ロールプレイ規則】\n${buildFixedRules(outputLength)}`);
  sections.push(`【対象キャラクター】\n${persona}`);

  const optional: Array<{ label: string; body: string }> = [];
  if (dialogueExamples) {
    optional.push({ label: '【口調の参考例（内容ではなく話し方を真似る）】', body: dialogueExamples });
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
    const candidate = `${assembled}\n\n---\n\n${item.label}\n${item.body}`;
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
  push(lines, '望むもの (want)', character.want);
  push(lines, '恐れ (fear)', character.fear);
  // NOTE: 隠している人物として振る舞う旨は固定規則で説明済み。ここでは事実として記す。
  if (character.secrets?.trim()) {
    push(lines, '本人が隠している秘密（自分からは明かさない）', character.secrets);
  }
  push(lines, '関係性メモ', character.relationshipNotes);
  push(lines, '会話開始時点の状態', character.currentState);
  return lines.join('\n');
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
  return text.slice(0, maxChars);
}
