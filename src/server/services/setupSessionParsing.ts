import type { SetupSuggestedAction } from '../types/index.js';

// NOTE: setupSessionService から切り出した「LLM 応答の解釈」ヘルパー群。相談チャットの
// 返答（可視テキスト＋DRAFT_PATCH＝ドラフト差分＋提案アクション＋会話要約）を解析し、
// 読み取れない応答は安全なフォールバックへ縮退させる。外部サービスに依存しない葉ノード。

export const DRAFT_PATCH_MARKER = '===DRAFT_PATCH===';
export const MAX_CONVERSATION_SUMMARY_CHARS = 2000;

const UNREADABLE_CHAT_REPLY =
  '相談相手の返答をうまく読み取れませんでした。あなたの入力は保存されています。もう一度、今の内容を整理してみます。';
const UNREADABLE_CHAT_ACTIONS: SetupSuggestedAction[] = [
  {
    label: 'もう一度整理',
    message: '直前の相談内容をもう一度整理してください。',
  },
];

export function parseChatResult(text: string): {
  visibleReply: string;
  draftPatch: unknown | null;
  suggestedActions: SetupSuggestedAction[];
  conversationSummary: string | null;
} {
  const markerIndex = text.indexOf(DRAFT_PATCH_MARKER);
  if (markerIndex >= 0) {
    const visibleReply = text.slice(0, markerIndex).trim();
    const jsonPart = text.slice(markerIndex + DRAFT_PATCH_MARKER.length);
    const parsed = parseJsonObject(jsonPart);
    if (parsed) {
      return {
        visibleReply,
        draftPatch: parsed.draftPatch ?? null,
        suggestedActions: normalizeSuggestedActions(parsed.suggestedActions),
        conversationSummary: asString(parsed.conversationSummary) || null,
      };
    }
    return {
      visibleReply,
      draftPatch: null,
      suggestedActions: [],
      conversationSummary: null,
    };
  }

  const parsed = parseJsonObject(text);
  if (parsed) {
    return {
      visibleReply: asString(parsed.visibleReply),
      draftPatch: parsed.draftPatch ?? null,
      suggestedActions: normalizeSuggestedActions(parsed.suggestedActions),
      conversationSummary: asString(parsed.conversationSummary) || null,
    };
  }

  const plain = stripCodeFence(text).trim();
  if (!plain) {
    return unreadableChatFallback();
  }
  if (plain.includes('draftPatch') || plain.includes('visibleReply')) {
    return unreadableChatFallback();
  }

  return {
    visibleReply: plain,
    draftPatch: null,
    suggestedActions: [],
    conversationSummary: null,
  };
}

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function unreadableChatFallback(): {
  visibleReply: string;
  draftPatch: null;
  suggestedActions: SetupSuggestedAction[];
  conversationSummary: null;
} {
  return {
    visibleReply: UNREADABLE_CHAT_REPLY,
    draftPatch: null,
    suggestedActions: UNREADABLE_CHAT_ACTIONS.map((action) => ({ ...action })),
    conversationSummary: null,
  };
}

function normalizeSuggestedActions(value: unknown): SetupSuggestedAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!isRecord(item)) return null;
      const label = asString(item.label);
      const message = asString(item.message);
      const intent = normalizeSuggestedActionIntent(item.intent);
      return label && message ? { label, message, ...(intent ? { intent } : {}) } : null;
    })
    .filter((item): item is SetupSuggestedAction => item !== null)
    .slice(0, 4);
}

function normalizeSuggestedActionIntent(value: unknown): SetupSuggestedAction['intent'] {
  return value === 'preview' || value === 'commit' ? value : undefined;
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
