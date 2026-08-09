// NOTE: ロールプレイのsession canon抽出（設計書 8.2・7.1）。
// メッセージ単位の追加LLM呼び出しは作らず、既存のconversationSummary foldと同じ
// LLM出力へ sessionCanonPatch を同梱する。sessionCanonThroughMessageId は要約カーソルと
// 同じfold境界まで進み、同じmessageを二重抽出しない。
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import type {
  CanonEpistemicStatus,
  CanonScope,
  LatentCanonItem,
} from '../types/index.js';

export interface SessionCanonEntry {
  canonId?: string;
  scope: CanonScope;
  statement: string;
  epistemicStatus: CanonEpistemicStatus;
  disclosure: 'foreshadowed' | 'revealed';
  evidenceExcerpt: string;
}

export interface SessionCanonFoldResult {
  entries: SessionCanonEntry[];
}

export function buildSessionCanonPromptSection(sessionCanon: LatentCanonItem[] | undefined): string {
  if (!sessionCanon || sessionCanon.length === 0) return '';
  return [
    '【既存のセッション設定（session canon）】',
    sessionCanon.map((item) => `- [${item.canonId}] ${item.statement}（${item.epistemicStatus}）`).join('\n'),
  ].join('\n');
}

export function buildSessionCanonInstruction(): string {
  return [
    'sessionCanon には、今回の会話で「明かされた・示唆された・確定した」設定的事実（人物の過去、関係性の変化、秘密、世界観）を入れてください。',
    '既存のsessionCanonに対応する項目は targetCanonId に既存IDを指定してください。',
    '台詞・主張・噂は epistemicStatus を claim / belief / rumor にし、fact にしないでください。',
    '曖昧な示唆は disclosure を foreshadowed にしてください。',
    'evidenceExcerpt は根拠となる発言の短い抜粋（100字以内）にしてください。',
    '既存項目と重複する内容は新規に作らず、既存IDへtargetしてください。',
    'sessionCanon が無い場合は空配列にしてください。',
  ].join('\n');
}

export const SESSION_CANON_JSON_FORMAT = JSON.stringify({
  targetCanonId: '既存IDまたは省略',
  scope: 'world|character|relationship|history|plot|other',
  statement: '設定の内容',
  epistemicStatus: 'fact|claim|belief|rumor|unknown',
  disclosure: 'revealed|foreshadowed',
  evidenceExcerpt: '根拠の短い抜粋',
});

export function parseSessionCanonEntries(value: unknown): SessionCanonEntry[] {
  if (!Array.isArray(value)) return [];
  const result: SessionCanonEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const statement = asString(record.statement);
    const scope = normalizeScope(record.scope);
    const epistemicStatus = normalizeEpistemicStatus(record.epistemicStatus);
    const disclosure = record.disclosure === 'foreshadowed' ? 'foreshadowed' : 'revealed';
    if (!statement || !scope || !epistemicStatus) continue;
    result.push({
      ...(asString(record.targetCanonId)
        ? { canonId: asString(record.targetCanonId) }
        : {}),
      scope,
      statement: statement.slice(0, 2000),
      epistemicStatus,
      disclosure,
      evidenceExcerpt: asString(record.evidenceExcerpt).slice(0, 160),
    });
    if (result.length >= 20) break;
  }
  return result;
}

// NOTE: 抽出したentriesを既存session canonへ適用する。targetCanonId一致→更新、
// それ以外は scope+statementの包含関係で既存項目へmerge、無ければ新規追加する。
export function applySessionCanonPatch(
  sessionCanon: LatentCanonItem[],
  entries: SessionCanonEntry[],
  messageId: string,
  fallbackNow = nowIso()
): LatentCanonItem[] {
  const next = sessionCanon.map((item) => ({ ...item }));
  for (const entry of entries) {
    const byId = entry.canonId
      ? next.find((item) => item.canonId === entry.canonId)
      : undefined;
    const matched = byId ?? findSessionMergeCandidate(next, entry);
    const evidence = {
      kind: 'roleplay-message' as const,
      disclosure: entry.disclosure,
      ...(messageId ? { messageId } : {}),
      excerpt: entry.evidenceExcerpt,
      createdAt: fallbackNow,
    };
    if (matched) {
      const index = next.findIndex((item) => item.canonId === matched.canonId);
      next[index] = {
        ...matched,
        statement: entry.statement,
        status: entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed',
        epistemicStatus: entry.epistemicStatus,
        evidence: [...matched.evidence, evidence].slice(-20),
        updatedAt: fallbackNow,
      };
    } else {
      next.push({
        canonId: generateTimestampId('can'),
        scope: entry.scope,
        statement: entry.statement,
        status: entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed',
        // NOTE: session由来の新規項目は evidence 喪失時 retired へ戻る（設計書 5.3）。
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: entry.epistemicStatus,
        source: 'roleplay',
        manualLock: false,
        evidence: [evidence],
        createdAt: fallbackNow,
        updatedAt: fallbackNow,
      });
    }
  }
  return next.slice(-60);
}

function findSessionMergeCandidate(
  items: LatentCanonItem[],
  entry: SessionCanonEntry
): LatentCanonItem | undefined {
  return items.find((item) => {
    if (item.status === 'retired') return false;
    if (item.scope !== entry.scope) return false;
    const statementA = normalizeComparable(entry.statement);
    const statementB = normalizeComparable(item.statement);
    if (!statementA || !statementB) return false;
    return statementA === statementB || statementA.includes(statementB) || statementB.includes(statementA);
  });
}

function normalizeComparable(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeScope(value: unknown): CanonScope | undefined {
  return value === 'world' ||
    value === 'character' ||
    value === 'relationship' ||
    value === 'history' ||
    value === 'plot' ||
    value === 'other'
    ? value
    : undefined;
}

function normalizeEpistemicStatus(value: unknown): CanonEpistemicStatus | undefined {
  return value === 'fact' ||
    value === 'claim' ||
    value === 'belief' ||
    value === 'rumor' ||
    value === 'unknown'
    ? value
    : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
