// NOTE: ロールプレイのsession canon抽出（設計書 8.2・7.1）。
// メッセージ単位の追加LLM呼び出しは作らず、既存のconversationSummary foldと同じ
// LLM出力へ sessionCanonPatch を同梱する。sessionCanonThroughMessageId は要約カーソルと
// 同じfold境界まで進み、同じmessageを二重抽出しない。
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import type {
  CanonEpistemicStatus,
  CanonLifecycle,
  CanonScope,
  CharacterId,
  LatentCanonItem,
} from '../types/index.js';

export interface SessionCanonEntry {
  canonId?: string;
  scope: CanonScope;
  statement: string;
  epistemicStatus: CanonEpistemicStatus;
  disclosure: 'foreshadowed' | 'revealed';
  subjectCharacterIds?: CharacterId[];
  evidenceExcerpt: string;
}

export interface SessionCanonFoldResult {
  entries: SessionCanonEntry[];
}

export function buildSessionCanonPromptSection(
  sessionCanon: LatentCanonItem[] | undefined,
  options: { initialCanonCandidates?: LatentCanonItem[] } = {}
): string {
  const lines: string[] = [];
  const sessionItems = sessionCanon ?? [];
  if (sessionItems.length > 0) {
    lines.push('【既存のセッション設定（session canon）】');
    for (const item of sessionItems) {
      lines.push(`- [${item.canonId}] ${item.statement}（${item.epistemicStatus}）`);
    }
  }
  // NOTE: 初期 canon は「照合候補」であり、会話内に根拠があるときだけ session-local へ
  // 昇格する。候補一覧を見ただけで公開・示唆済みにしてはならない（設計書 6.3）。
  // 既に session canon へ上書き済みの ID は候補一覧へ重複表示しない。
  const coveredIds = new Set((sessionCanon ?? []).map((item) => item.canonId));
  const initialItems = (options.initialCanonCandidates ?? []).filter(
    (item) => item.status !== 'retired' && !coveredIds.has(item.canonId)
  );
  if (initialItems.length > 0) {
    lines.push('【作品設定の照合候補（初期canon）】');
    for (const item of initialItems) {
      lines.push(`- [${item.canonId}] ${item.statement}（${item.epistemicStatus}）`);
    }
  }
  return lines.join('\n');
}

export function buildSessionCanonInstruction(): string {
  return [
    'sessionCanon には、今回の会話で「明かされた・示唆された・確定した」設定的事実（人物の過去、関係性の変化、秘密、世界観）を入れてください。',
    '既存のsessionCanonに対応する項目は targetCanonId に既存IDを指定してください。',
    '【作品設定の照合候補（初期canon）】の項目は公開の根拠にならない。候補一覧を見ただけで status を公開・示唆済みへ変えず、今回の会話内に evidenceExcerpt を取れる根拠がある項目だけを target してください。',
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
  subjectCharacterIds: ['関連する人物ID（任意）'],
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
    // NOTE: 欠落・未知の disclosure を最強の revealed として補正しない（レビューP2）。
    // 構造不正な項目は契約どおり捨てる。
    const disclosure =
      record.disclosure === 'revealed'
        ? 'revealed'
        : record.disclosure === 'foreshadowed'
          ? 'foreshadowed'
          : undefined;
    if (!statement || !scope || !epistemicStatus || !disclosure) continue;
    result.push({
      ...(asString(record.targetCanonId)
        ? { canonId: asString(record.targetCanonId) }
        : {}),
      scope,
      statement: statement.slice(0, 2000),
      epistemicStatus,
      disclosure,
      ...(asStringArray(record.subjectCharacterIds, 24).length > 0
        ? { subjectCharacterIds: asStringArray(record.subjectCharacterIds, 24) }
        : {}),
      evidenceExcerpt: asString(record.evidenceExcerpt).slice(0, 160),
    });
    if (result.length >= 20) break;
  }
  return result;
}

// NOTE: 抽出したentriesを既存session canonへ適用する。targetCanonId一致→更新、
// それ以外は scope+statement の包含関係で既存項目へmerge、無ければ新規追加する。
// 増分foldでは公開状態を後退させない（既存 revealed を後続の foreshadowed で上書きしない）。
// 初期 canon に該当する場合は session-local にコピーし、同じ canonId（ID省略時は
// scope/statement/subject のフォールバック照合）のまま新しい status と
// roleplay-message evidence を付ける。プロジェクト側の canon store は変更しない。
// ただし初期 canon の状態変更は、fold対象会話本文内に根拠の抜粋が部分文字列として
// 存在する場合だけ採用する（候補一覧だけでは公開・示唆済みにしない）。
export function applySessionCanonPatch(
  sessionCanon: LatentCanonItem[],
  entries: SessionCanonEntry[],
  messageId: string,
  options: {
    initialCanonCandidates?: LatentCanonItem[];
    foldTargetText?: string;
    fallbackNow?: string;
  } = {}
): LatentCanonItem[] {
  const fallbackNow = options.fallbackNow ?? nowIso();
  const next = sessionCanon.map((item) => ({ ...item }));
  const initialCandidates = (options.initialCanonCandidates ?? []).filter(
    (item) => item.status !== 'retired'
  );
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
        status: moreAdvancedStatus(
          matched.status,
          entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed'
        ),
        epistemicStatus: entry.epistemicStatus,
        evidence: [...matched.evidence, evidence].slice(-20),
        updatedAt: fallbackNow,
      };
      continue;
    }
    // NOTE: ID明示だけでなく、ID省略で同じ statement を返してきた場合も初期 canon の
    // 照合対象にする。そうしないと evidence 検証を迂回して「未公開→公開済み」へ
    // 無条件昇格できる（設計書 6.3・レビューP1）。
    const initialCandidate =
      (entry.canonId
        ? initialCandidates.find((item) => item.canonId === entry.canonId)
        : undefined) ?? findInitialCanonFallbackMatch(initialCandidates, entry);
    if (initialCandidate) {
      if (
        !options.foldTargetText ||
        !evidenceFoundInFoldTarget(entry.evidenceExcerpt, options.foldTargetText)
      ) {
        // NOTE: 根拠が fold 対象会話内に見つからない初期 canon の状態変更は採用しない
        // （設計書 6.3・テスト22）。
        continue;
      }
      next.push(copyInitialCandidateToSession(initialCandidate, entry, evidence, fallbackNow));
      continue;
    }
    next.push({
      canonId: generateTimestampId('can'),
      scope: entry.scope,
      ...(entry.subjectCharacterIds ? { subjectCharacterIds: entry.subjectCharacterIds } : {}),
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
  return next.slice(-60);
}

// NOTE: 初期 canon の session-local コピー。同じ canonId のまま新しい status と
// evidence を付ける。初期状態より後退させない（初期 revealed を後続の foreshadowed で
// 上書きしない・レビューP1）。promotedToProjectAt は作品側のフラグなのでコピーしない。
function copyInitialCandidateToSession(
  initialCandidate: LatentCanonItem,
  entry: SessionCanonEntry,
  evidence: LatentCanonItem['evidence'][number],
  fallbackNow: string
): LatentCanonItem {
  const { promotedToProjectAt: _promoted, ...copied } = initialCandidate;
  return {
    ...copied,
    statement: entry.statement,
    status: moreAdvancedStatus(
      initialCandidate.status,
      entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed'
    ),
    epistemicStatus: entry.epistemicStatus,
    evidence: [evidence],
    updatedAt: fallbackNow,
  };
}

// NOTE: ID不一致でも初期 canon の照合候補とみなすフォールバック。scope と正規化
// statement の一致・包含に加え、両方に subjectCharacterIds がある場合は対象人物の
// 一致も要求する（設計書 6.2-3 と同規則）。
function findInitialCanonFallbackMatch(
  items: LatentCanonItem[],
  entry: SessionCanonEntry
): LatentCanonItem | undefined {
  return items.find((item) => {
    if (item.scope !== entry.scope) return false;
    const statementA = normalizeComparableCanonStatement(entry.statement);
    const statementB = normalizeComparableCanonStatement(item.statement);
    if (!statementA || !statementB) return false;
    const statementsMatch =
      statementA === statementB ||
      statementA.includes(statementB) ||
      statementB.includes(statementA);
    if (!statementsMatch) return false;
    if (item.subjectCharacterIds && entry.subjectCharacterIds) {
      const left = [...item.subjectCharacterIds].sort();
      const right = [...entry.subjectCharacterIds].sort();
      if (
        left.length !== right.length ||
        left.some((id, index) => id !== right[index])
      ) {
        return false;
      }
    }
    return true;
  });
}

// NOTE: 公開状態の前進だけを許す。revealed > foreshadowed > provisional。
function moreAdvancedStatus(
  current: CanonLifecycle,
  candidate: CanonLifecycle
): CanonLifecycle {
  const rank: Record<CanonLifecycle, number> = {
    revealed: 3,
    foreshadowed: 2,
    provisional: 1,
    retired: 0,
  };
  return rank[candidate] > rank[current] ? candidate : current;
}

export function normalizeComparableCanonStatement(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// NOTE: 初期 canon の状態変更を認める根拠チェック（設計書 6.3）。空白と改行を正規化した
// evidenceExcerpt が、同じく正規化した fold 対象本文の部分文字列にならない場合は採用しない。
export function evidenceFoundInFoldTarget(excerpt: string, foldTargetText: string): boolean {
  const normalizedExcerpt = normalizeComparableCanonStatement(excerpt);
  const normalizedText = normalizeComparableCanonStatement(foldTargetText);
  return Boolean(normalizedExcerpt && normalizedText.includes(normalizedExcerpt));
}

function findSessionMergeCandidate(
  items: LatentCanonItem[],
  entry: SessionCanonEntry
): LatentCanonItem | undefined {
  return items.find((item) => {
    if (item.status === 'retired') return false;
    if (item.scope !== entry.scope) return false;
    const statementA = normalizeComparableCanonStatement(entry.statement);
    const statementB = normalizeComparableCanonStatement(item.statement);
    if (!statementA || !statementB) return false;
    return statementA === statementB || statementA.includes(statementB) || statementB.includes(statementA);
  });
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

function asStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}
