// NOTE: setupSessionService から切り出した「LLM 応答の解釈」ヘルパー群。外部サービスに
// 依存しない葉ノード。
//
// 相談チャットの応答は平文だけになった。以前は「平文 + ===DRAFT_PATCH=== + JSON」の
// 2部構成を毎ターン要求しており、解釈の失敗（マーカー無し・JSON壊れ）がそのまま
// 「返答が読み取れませんでした」という会話の停止として利用者に届いていた。
// 設定草案への反映は parseDraftExtraction を使う別経路（利用者が明示的に実行）へ移した。

export const DRAFT_PATCH_MARKER = '===DRAFT_PATCH===';
export const MAX_CONVERSATION_SUMMARY_CHARS = 2000;

/**
 * 相談チャットの平文返答を画面表示用に整える。
 *
 * マーカー以降を切り落とすのは保険。指示文はもう2部構成を要求していないが、
 * 学習の癖でモデルが JSON を付けてくることがあり、それを利用者に見せたくない。
 */
export function normalizeChatReply(text: string): string {
  const markerIndex = text.indexOf(DRAFT_PATCH_MARKER);
  const visible = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  return stripCodeFence(visible).trim();
}

export interface DraftExtractionResult {
  draftPatch: unknown | null;
  conversationSummary: string | null;
}

/**
 * 「今の相談を草案にまとめる」で使う抽出結果の解釈。純 JSON 前提だが、モデルが
 * コードフェンスや前置きを付けてくる場合に備えて parseJsonObject の緩い探索を通す。
 */
export function parseDraftExtraction(text: string): DraftExtractionResult | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;

  // NOTE: draftPatch でラップせず patch 本体を直接返すモデルがあるため、
  // 既知のフィールドが直に来ていたらそれを patch とみなす。
  const patch = isRecord(parsed.draftPatch)
    ? parsed.draftPatch
    : looksLikeDraftPatch(parsed)
      ? parsed
      : null;
  const summary = asString(parsed.conversationSummary);

  if (!patch && !summary) return null;
  return { draftPatch: patch, conversationSummary: summary || null };
}

const DRAFT_PATCH_KEYS = [
  'coreConcept',
  'confirmedAdd',
  'candidatesAdd',
  'undecidedAdd',
  'charactersAdd',
  'charactersUpdate',
  'confirmedUpdate',
  'candidatesUpdate',
  'undecidedUpdate',
  'relationshipSeedsAdd',
  'worldAdd',
  'toneAdd',
  'ngAdd',
  'openingSeedsAdd',
  'scenarioSeedsAdd',
  'relationshipSeedsReplace',
  'worldReplace',
  'toneReplace',
  'ngReplace',
  'openingSeedsReplace',
  'scenarioSeedsReplace',
  'userPersonaUpdate',
  'archiveIds',
];

function looksLikeDraftPatch(value: Record<string, unknown>): boolean {
  return DRAFT_PATCH_KEYS.some((key) => key in value);
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
