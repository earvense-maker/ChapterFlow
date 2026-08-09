import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { normalizeComparableText } from '../utils/characterStateMatching.js';
import * as storage from './storageService.js';
import type {
  CanonConflict,
  CanonConflictKind,
  CanonConflictStatus,
  CanonEpistemicStatus,
  CanonEvidence,
  CanonEvidenceKind,
  CanonLifecycle,
  CanonPatchEntry,
  CanonRetiredReason,
  CanonScope,
  CanonSource,
  CharacterId,
  GenerationId,
  LatentCanonItem,
  LatentCanonStore,
  ProjectId,
  RoleplaySessionView,
  SceneId,
} from '../types/index.js';

export const LATENT_CANON_LIMITS = {
  maxStatementChars: 2_000,
  maxNewPerCall: 8,
  maxActiveItems: 40,
  selectedMaxItems: 12,
  maxExcerptChars: 160,
} as const;

export function createEmptyLatentCanonStore(projectId: ProjectId): LatentCanonStore {
  const now = nowIso();
  return {
    schemaVersion: 1,
    projectId,
    revision: 0,
    items: [],
    processedGenerationIds: [],
    pendingConflicts: [],
    latentSeedStatus: 'ok',
    updatedAt: now,
  };
}

// NOTE: ロールプレイ側では本文を返さない。summary/revealの双方で同じ非ネタバレlabelを
// 使うため、ルートとセッションサービスから共有する。
export function buildSessionCanonSummary(
  items: LatentCanonItem[]
): NonNullable<RoleplaySessionView['sessionCanonSummary']> {
  const categories = new Map<CanonScope, number>();
  for (const item of items) {
    categories.set(item.scope, (categories.get(item.scope) ?? 0) + 1);
  }
  return {
    total: items.length,
    pendingPromotion: items.filter(
      (item) =>
        !item.promotedToProjectAt &&
        (item.status === 'foreshadowed' || item.status === 'provisional')
    ).length,
    categories: [...categories.entries()].map(([scope, count]) => ({ scope, count })),
    items: items.map((item) => ({
      canonId: item.canonId,
      scope: item.scope,
      label: sessionCanonScopeLabel(item.scope),
      ...(item.promotedToProjectAt ? { promotedToProjectAt: item.promotedToProjectAt } : {}),
    })),
  };
}

export function sessionCanonScopeLabel(scope: CanonScope): string {
  switch (scope) {
    case 'character':
      return '人物に関する未公開設定';
    case 'world':
      return '世界観に関する未公開設定';
    case 'relationship':
      return '関係性に関する未公開設定';
    case 'history':
      return '歴史に関する未公開設定';
    case 'plot':
      return '筋書きに関する未公開設定';
    default:
      return '作品設定';
  }
}

export function normalizeLatentCanonStore(value: unknown, projectId: ProjectId): LatentCanonStore {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createEmptyLatentCanonStore(projectId);
  }
  const record = value as Record<string, unknown>;
  const now = nowIso();
  const items = Array.isArray(record.items)
    ? record.items
        .map((item) => normalizeLatentCanonItem(item))
        .filter((item): item is LatentCanonItem => item !== null)
    : [];
  return {
    schemaVersion: 1,
    projectId,
    revision: asRevision(record.revision),
    items,
    processedGenerationIds: asStringArray(record.processedGenerationIds, Number.MAX_SAFE_INTEGER),
    pendingConflicts: Array.isArray(record.pendingConflicts)
      ? record.pendingConflicts
          .map((item) => normalizeCanonConflict(item))
          .filter((item): item is CanonConflict => item !== null)
      : [],
    latentSeedStatus: record.latentSeedStatus === 'failed' ? 'failed' : 'ok',
    updatedAt: asString(record.updatedAt) || now,
  };
}

function normalizeLatentCanonItem(value: unknown): LatentCanonItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const statement = asString(record.statement);
  if (!statement) return null;
  const source = normalizeSource(record.source);
  // NOTE: baseStatusWithoutEvidence 欠損の旧項目は source から補正（設計書 5.3）。
  // setup/on-demand由来は provisional、generation/roleplay由来は retired。
  const rawBase = record.baseStatusWithoutEvidence;
  const baseStatusWithoutEvidence: Exclude<CanonLifecycle, 'foreshadowed' | 'revealed'> =
    rawBase === 'provisional' || rawBase === 'retired'
      ? rawBase
      : source === 'setup' || source === 'on-demand' || source === 'manual'
        ? 'provisional'
        : 'retired';
  const status = normalizeStatus(record.status);
  const evidence = Array.isArray(record.evidence)
    ? record.evidence
        .map((item) => normalizeCanonEvidence(item))
        .filter((item): item is CanonEvidence => item !== null)
    : [];
  const item: LatentCanonItem = {
    canonId: normalizeCanonId(record.canonId),
    scope: normalizeScope(record.scope),
    ...(Array.isArray(record.subjectCharacterIds)
      ? { subjectCharacterIds: asStringArray(record.subjectCharacterIds, 24) }
      : {}),
    statement: statement.slice(0, LATENT_CANON_LIMITS.maxStatementChars),
    status,
    baseStatusWithoutEvidence,
    ...(normalizeStatusBeforeRetired(record.statusBeforeRetired) !== undefined
      ? { statusBeforeRetired: normalizeStatusBeforeRetired(record.statusBeforeRetired) }
      : {}),
    epistemicStatus: normalizeEpistemicStatus(record.epistemicStatus),
    ...(Array.isArray(record.knownBy)
      ? { knownBy: asStringArray(record.knownBy, 24) }
      : {}),
    ...(Array.isArray(record.explicitlyUnknownBy)
      ? { explicitlyUnknownBy: asStringArray(record.explicitlyUnknownBy, 24) }
      : {}),
    source,
    manualLock: record.manualLock === true,
    evidence,
    ...(asString(record.supersedesCanonId) ? { supersedesCanonId: asString(record.supersedesCanonId) } : {}),
    ...(normalizeRetiredReason(record.retiredReason) !== undefined
      ? { retiredReason: normalizeRetiredReason(record.retiredReason) }
      : {}),
    ...(asString(record.retiredByGenerationId)
      ? { retiredByGenerationId: asString(record.retiredByGenerationId) }
      : {}),
    ...(asString(record.promotedToProjectAt)
      ? { promotedToProjectAt: asString(record.promotedToProjectAt) }
      : {}),
    createdAt: asString(record.createdAt) || nowIso(),
    updatedAt: asString(record.updatedAt) || nowIso(),
  };
  // NOTE: revealed は必ず1件以上のevidenceまたは source=manual（設計書 5.3）。
  if (status === 'revealed' && evidence.length === 0 && source !== 'manual') {
    return null;
  }
  return item;
}

function normalizeCanonEvidence(value: unknown): CanonEvidence | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const disclosure = record.disclosure === 'foreshadowed' ? 'foreshadowed' : 'revealed';
  const kind = normalizeEvidenceKind(record.kind);
  if (!kind) return null;
  return {
    kind,
    disclosure,
    ...(asString(record.generationId) ? { generationId: asString(record.generationId) } : {}),
    ...(asString(record.sceneId) ? { sceneId: asString(record.sceneId) } : {}),
    ...(asString(record.sessionId) ? { sessionId: asString(record.sessionId) } : {}),
    ...(asString(record.messageId) ? { messageId: asString(record.messageId) } : {}),
    ...(asString(record.excerpt)
      ? { excerpt: asString(record.excerpt).slice(0, LATENT_CANON_LIMITS.maxExcerptChars) }
      : {}),
    createdAt: asString(record.createdAt) || nowIso(),
  };
}

function normalizeCanonConflict(value: unknown): CanonConflict | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const generationId = asString(record.generationId);
  if (!generationId) return null;
  const kind = normalizeConflictKind(record.kind);
  if (!kind) return null;
  return {
    conflictId: normalizeCanonId(record.conflictId),
    generationId,
    ...(asString(record.canonId) ? { canonId: asString(record.canonId) } : {}),
    ...(asString(record.contractId) ? { contractId: asString(record.contractId) } : {}),
    kind,
    summary: asString(record.summary).slice(0, 300),
    evidenceExcerpt: asString(record.evidenceExcerpt).slice(
      0,
      LATENT_CANON_LIMITS.maxExcerptChars
    ),
    status: normalizeConflictStatus(record.status),
    createdAt: asString(record.createdAt) || nowIso(),
    ...(asString(record.resolvedAt) ? { resolvedAt: asString(record.resolvedAt) } : {}),
  };
}

export function normalizeCanonId(value: unknown): string {
  const text = asString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : generateTimestampId('can');
}

export async function readLatentCanonStore(projectId: string): Promise<LatentCanonStore> {
  const store = await storage.readLatentCanon(projectId);
  return normalizeLatentCanonStore(store, projectId);
}

export async function writeLatentCanonStore(store: LatentCanonStore): Promise<void> {
  await storage.writeLatentCanon(store);
}

export async function saveLatentCanonStoreWithNextRevision(
  store: LatentCanonStore
): Promise<LatentCanonStore> {
  const next: LatentCanonStore = {
    ...store,
    revision: store.revision + 1,
    updatedAt: nowIso(),
  };
  await storage.writeLatentCanon(next);
  return next;
}

// ============================================================
// canon patch の適用（採用後抽出のserver側派生・設計書 6.3）
// ============================================================

// NOTE: 新規canon patchの適用前には全active canonを対象に決定的重複検査を行う
// （設計書 6.1）。scope と subjectCharacterIds が一致し、normalizedStatement が同一、
// または一方が他方を明確に包含する場合は新規作成せず既存 canonId へのmergeにする。
export function applyCanonPatchUnlocked(
  store: LatentCanonStore,
  patch: CanonPatchEntry[],
  generation: { generationId: GenerationId; sceneId: SceneId }
): { store: LatentCanonStore; createdCount: number } {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const byId = new Map(next.items.map((item) => [item.canonId, item]));
  const now = nowIso();
  let createdCount = 0;

  for (const entry of patch) {
    if (entry.operation === 'retire') {
      if (!entry.canonId) continue;
      const target = byId.get(entry.canonId);
      if (!target || target.status === 'retired') continue;
      // NOTE: revealedとmanual lock項目は自動退役しない（設計書 5.3）。
      if (target.manualLock || target.status === 'revealed') continue;
      const retired: LatentCanonItem = {
        ...target,
        status: 'retired',
        statusBeforeRetired: target.status,
        ...(entry.retiredReason ? { retiredReason: entry.retiredReason } : {}),
        // NOTE: どの採用本文との矛盾で退役したかを記録し、採用取消で元状態へ戻せるようにする
        // （設計書 6.4）。
        retiredByGenerationId: generation.generationId,
        updatedAt: now,
      };
      byId.set(retired.canonId, retired);
      continue;
    }

    if (entry.operation === 'resolve') {
      // NOTE: canon観測のresolveは対象をrevealedへ確定させる（threadのresolvedとは別）。
      if (!entry.canonId) continue;
      const target = byId.get(entry.canonId);
      if (!target) continue;
      const resolved: LatentCanonItem = {
        ...target,
        status: 'revealed',
        statusBeforeRetired: undefined,
        evidence: appendEvidence(target.evidence, {
          kind: 'generation',
          disclosure: 'revealed',
          generationId: generation.generationId,
          sceneId: generation.sceneId,
          excerpt: entry.evidenceExcerpt,
          createdAt: now,
        }),
        updatedAt: now,
      };
      byId.set(resolved.canonId, resolved);
      continue;
    }

    // upsert
    const existing = entry.canonId ? byId.get(entry.canonId) : undefined;
    const matched = existing && existing.status !== 'retired'
      ? existing
      : findMergeCandidate(next.items, entry);
    const evidence: CanonEvidence = {
      kind: 'generation',
      disclosure: entry.disclosure,
      generationId: generation.generationId,
      sceneId: generation.sceneId,
      excerpt: entry.evidenceExcerpt.slice(0, LATENT_CANON_LIMITS.maxExcerptChars),
      createdAt: now,
    };

    if (matched) {
      const updated: LatentCanonItem = {
        ...matched,
        scope: entry.scope,
        ...(entry.subjectCharacterIds ? { subjectCharacterIds: entry.subjectCharacterIds } : {}),
        statement: entry.statement,
        status: entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed',
        statusBeforeRetired: undefined,
        epistemicStatus: entry.epistemicStatus,
        ...(entry.knownBy ? { knownBy: entry.knownBy } : {}),
        ...(entry.explicitlyUnknownBy ? { explicitlyUnknownBy: entry.explicitlyUnknownBy } : {}),
        evidence: appendEvidence(matched.evidence, evidence),
        updatedAt: now,
      };
      byId.set(updated.canonId, updated);
    } else {
      createdCount += 1;
      const created: LatentCanonItem = {
        canonId: generateTimestampId('can'),
        scope: entry.scope,
        ...(entry.subjectCharacterIds ? { subjectCharacterIds: entry.subjectCharacterIds } : {}),
        statement: entry.statement,
        status: entry.disclosure === 'revealed' ? 'revealed' : 'foreshadowed',
        // NOTE: 採用本文から新規抽出された項目は evidence 喪失時 retired へ戻る（設計書 5.3）。
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: entry.epistemicStatus,
        ...(entry.knownBy ? { knownBy: entry.knownBy } : {}),
        ...(entry.explicitlyUnknownBy ? { explicitlyUnknownBy: entry.explicitlyUnknownBy } : {}),
        source: 'generation',
        manualLock: false,
        evidence: [evidence],
        createdAt: now,
        updatedAt: now,
      };
      byId.set(created.canonId, created);
    }
  }

  const items = [...byId.values()];
  const trimmed = enforceActiveLimit(items);
  return {
    store: {
      ...next,
      items: trimmed,
      processedGenerationIds: appendUnique(next.processedGenerationIds, generation.generationId),
      updatedAt: now,
    },
    createdCount,
  };
}

// NOTE: activeなprovisional/foreshadowedが上限を超えたら、未使用・未ロックの
// provisionalからretiredにする（削除はしない・設計書 5.3）。
function enforceActiveLimit(items: LatentCanonItem[]): LatentCanonItem[] {
  const activeCount = (current: LatentCanonItem[]) =>
    current.filter(
      (item) =>
        item.status === 'provisional' || item.status === 'foreshadowed'
      ).length;
  if (activeCount(items) <= LATENT_CANON_LIMITS.maxActiveItems) return items;
  const candidates = items
    .filter(
      (item) =>
        item.status === 'provisional' && !item.manualLock && item.evidence.length === 0
    )
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const now = nowIso();
  const result = [...items];
  for (const candidate of candidates) {
    if (activeCount(result) <= LATENT_CANON_LIMITS.maxActiveItems) break;
    const index = result.findIndex((item) => item.canonId === candidate.canonId);
    if (index < 0) continue;
    result[index] = {
      ...result[index],
      status: 'retired',
      retiredReason: 'unused',
      updatedAt: now,
    };
  }
  return result;
}

// NOTE: scope+subjectCharacterIds一致+statement包含関係の決定的重複検査（設計書 6.1）。
export function findMergeCandidate(
  items: LatentCanonItem[],
  entry: CanonPatchEntry
): LatentCanonItem | undefined {
  const subjectA = entry.subjectCharacterIds ? [...entry.subjectCharacterIds].sort() : [];
  const statementA = normalizeComparableText(entry.statement);
  return items.find((item) => {
    if (item.status === 'retired') return false;
    if (item.scope !== entry.scope) return false;
    const subjectB = item.subjectCharacterIds ? [...item.subjectCharacterIds].sort() : [];
    if (subjectA.length !== subjectB.length || !subjectA.every((id, index) => id === subjectB[index])) {
      return false;
    }
    const statementB = normalizeComparableText(item.statement);
    if (!statementA || !statementB) return false;
    return statementA === statementB || statementA.includes(statementB) || statementB.includes(statementA);
  });
}

function appendEvidence(existing: CanonEvidence[], evidence: CanonEvidence): CanonEvidence[] {
  return [...existing, evidence].slice(-20);
}

// ============================================================
// evidence削除・退役・lock・編集
// ============================================================

// NOTE: 採用取消時の巻き戻し（設計書 6.4）。該当generationをevidenceから除き、
// 残ったevidenceのdisclosureからstatusを再計算する。根拠が無ければ
// baseStatusWithoutEvidenceへ戻す。generationをprocessed集合と未解決conflictからも外す。
// このgenerationとの矛盾で自動退役した項目（retiredByGenerationId一致）は元状態へ戻す。
export function removeEvidenceForGenerationUnlocked(
  store: LatentCanonStore,
  generationId: GenerationId
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) => {
    if (item.retiredByGenerationId === generationId && item.status === 'retired') {
      return {
        ...item,
        status: item.statusBeforeRetired ?? item.baseStatusWithoutEvidence,
        statusBeforeRetired: undefined,
        retiredReason: undefined,
        retiredByGenerationId: undefined,
        updatedAt: now,
      };
    }
    const remaining = item.evidence.filter(
      (evidence) => evidence.generationId !== generationId
    );
    if (remaining.length === item.evidence.length) return item;
    return recomputeStatusWithoutEvidence({ ...item, evidence: remaining }, now);
  });
  const pendingConflicts = next.pendingConflicts.filter(
    (conflict) => !(conflict.generationId === generationId && conflict.status === 'pending')
  );
  return {
    ...next,
    items,
    pendingConflicts,
    processedGenerationIds: next.processedGenerationIds.filter((id) => id !== generationId),
    updatedAt: now,
  };
}

// NOTE: evidence削除時のstatus再計算（設計書 5.3）。
// revealed優先、次にforeshadowed。根拠が無ければbaseStatusWithoutEvidenceへ戻す。
export function recomputeStatusWithoutEvidence(
  item: LatentCanonItem,
  fallbackUpdatedAt = nowIso()
): LatentCanonItem {
  if (item.status === 'retired') return item;
  const hasRevealed = item.evidence.some((evidence) => evidence.disclosure === 'revealed');
  const hasForeshadowed = item.evidence.some(
    (evidence) => evidence.disclosure === 'foreshadowed'
  );
  if (hasRevealed) return { ...item, status: 'revealed', updatedAt: fallbackUpdatedAt };
  if (hasForeshadowed) return { ...item, status: 'foreshadowed', updatedAt: fallbackUpdatedAt };
  if (item.baseStatusWithoutEvidence === 'retired') {
    return {
      ...item,
      status: 'retired',
      retiredReason: 'evidence-removed',
      updatedAt: fallbackUpdatedAt,
    };
  }
  return { ...item, status: 'provisional', updatedAt: fallbackUpdatedAt };
}

// NOTE: 作者操作による退役。statusBeforeRetired を残し、手動退役の取り消しに備える（設計書 5.3）。
export function retireCanonItemUnlocked(
  store: LatentCanonStore,
  canonId: string,
  reason: CanonRetiredReason
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) =>
    item.canonId === canonId && item.status !== 'retired'
      ? {
          ...item,
          status: 'retired' as const,
          statusBeforeRetired: item.status,
          retiredReason: reason,
          updatedAt: now,
        }
      : item
  );
  return { ...next, items, updatedAt: now };
}

// NOTE: 手動退役・競合退役の取り消し。statusBeforeRetired から復元する（設計書 5.3）。
export function restoreRetiredCanonItemUnlocked(
  store: LatentCanonStore,
  canonId: string
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) => {
    if (item.canonId !== canonId || item.status !== 'retired' || !item.statusBeforeRetired) {
      return item;
    }
    return {
      ...item,
      status: item.statusBeforeRetired,
      statusBeforeRetired: undefined,
      retiredReason: undefined,
      retiredByGenerationId: undefined,
      updatedAt: now,
    };
  });
  return { ...next, items, updatedAt: now };
}

export function setCanonLockUnlocked(
  store: LatentCanonStore,
  canonId: string,
  locked: boolean
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) =>
    item.canonId === canonId ? { ...item, manualLock: locked, updatedAt: now } : item
  );
  return { ...next, items, updatedAt: now };
}

export function updateCanonItemUnlocked(
  store: LatentCanonStore,
  canonId: string,
  patch: {
    statement?: string;
    scope?: CanonScope;
    epistemicStatus?: CanonEpistemicStatus;
    knownBy?: CharacterId[];
    explicitlyUnknownBy?: CharacterId[];
  }
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) => {
    if (item.canonId !== canonId) return item;
    const statement =
      patch.statement !== undefined
        ? patch.statement.slice(0, LATENT_CANON_LIMITS.maxStatementChars)
        : item.statement;
    if (!statement) return item;
    return {
      ...item,
      statement,
      scope: patch.scope ?? item.scope,
      epistemicStatus: patch.epistemicStatus ?? item.epistemicStatus,
      ...(patch.knownBy !== undefined ? { knownBy: patch.knownBy } : {}),
      ...(patch.explicitlyUnknownBy !== undefined
        ? { explicitlyUnknownBy: patch.explicitlyUnknownBy }
        : {}),
      // NOTE: 手動編集した項目は manualLock にする（設計書 4.3）。
      manualLock: true,
      updatedAt: now,
    };
  });
  return { ...next, items, updatedAt: now };
}

export function addManualEvidenceUnlocked(
  store: LatentCanonStore,
  canonId: string,
  excerpt: string
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const items = next.items.map((item) =>
    item.canonId === canonId
      ? {
          ...item,
          evidence: appendEvidence(item.evidence, {
            kind: 'manual' as const,
            disclosure: 'revealed' as const,
            excerpt: excerpt.slice(0, LATENT_CANON_LIMITS.maxExcerptChars),
            createdAt: now,
          }),
          status: 'revealed' as const,
          updatedAt: now,
        }
      : item
  );
  return { ...next, items, updatedAt: now };
}

// ============================================================
// 競合 (pendingConflicts)
// ============================================================

export function registerConflictsUnlocked(
  store: LatentCanonStore,
  conflicts: Array<{
    generationId: GenerationId;
    canonId?: string;
    contractId?: string;
    kind: CanonConflictKind;
    summary: string;
    evidenceExcerpt: string;
  }>
): LatentCanonStore {
  if (conflicts.length === 0) return store;
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const entries: CanonConflict[] = conflicts.map((conflict) => ({
    conflictId: generateTimestampId('conf'),
    generationId: conflict.generationId,
    ...(conflict.canonId ? { canonId: conflict.canonId } : {}),
    ...(conflict.contractId ? { contractId: conflict.contractId } : {}),
    kind: conflict.kind,
    summary: conflict.summary.slice(0, 300),
    evidenceExcerpt: conflict.evidenceExcerpt.slice(0, LATENT_CANON_LIMITS.maxExcerptChars),
    status: 'pending',
    createdAt: now,
  }));
  return { ...next, pendingConflicts: [...next.pendingConflicts, ...entries], updatedAt: now };
}

export function resolveConflictUnlocked(
  store: LatentCanonStore,
  conflictId: string,
  status: Exclude<CanonConflictStatus, 'pending'>
): LatentCanonStore {
  const next = normalizeLatentCanonStore(store, store.projectId);
  const now = nowIso();
  const pendingConflicts = next.pendingConflicts.map((conflict) =>
    conflict.conflictId === conflictId && conflict.status === 'pending'
      ? { ...conflict, status, resolvedAt: now }
      : conflict
  );
  return { ...next, pendingConflicts, updatedAt: now };
}

// ============================================================
// 関連選択（生成プロンプト注入用・設計書 6.1）
// ============================================================

// NOTE: 全件注入はしない。今回の希望・視点人物・authorUndecidedを入力に、
// 決定的スコアで最大12件を選ぶ。選ばれなかった潜在設定は存在しないものとして
// 自由に生成してよい（revealed canonとの矛盾のみ不可）。
export function selectRelatedCanonItems(input: {
  items: LatentCanonItem[];
  wish: string;
  viewpointCharacterId?: CharacterId | null;
  characters: Array<{ characterId: string; name: string }>;
  maxItems?: number;
  excludeStatements?: string[];
}): LatentCanonItem[] {
  const maxItems = input.maxItems ?? LATENT_CANON_LIMITS.selectedMaxItems;
  const wishTokens = tokenize(input.wish);
  const wishCharacterIds = resolveWishCharacterIds(input.wish, input.characters);
  const exclude = new Set((input.excludeStatements ?? []).map(normalizeComparableText));

  const scored = input.items
    .filter((item) => item.status !== 'retired')
    .filter((item) => !exclude.has(normalizeComparableText(item.statement)))
    .map((item) => {
      let score = 0;
      // 優先順位（設計書 6.1）: revealed > manual lock > foreshadowed > provisional
      if (item.status === 'revealed') score += 60;
      else if (item.status === 'foreshadowed') score += 30;
      if (item.manualLock) score += 20;
      const subjects = item.subjectCharacterIds ?? [];
      if (input.viewpointCharacterId && subjects.includes(input.viewpointCharacterId)) {
        score += 40;
      }
      if (subjects.some((id) => wishCharacterIds.has(id))) score += 25;
      const statementTokens = tokenize(item.statement);
      const overlap = [...wishTokens].filter((token) => statementTokens.has(token)).length;
      score += Math.min(overlap, 5) * 3;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.updatedAt.localeCompare(b.item.updatedAt));

  return scored.slice(0, maxItems).map((entry) => entry.item);
}

// NOTE: authorUndecided と意味的に重なる潜在設定を注入しない（設計書 6.5）。
// 追加LLM呼び出しにせず、決定的な包含関係（正規化後4字以上）で除外する。
// 意味的重複の判定そのものは抽出・補完プロンプトへ authorUndecided を同梱して返さない。
export function excludeOverlappingWithAuthorUndecided(
  items: LatentCanonItem[],
  authorUndecided: Array<{ text: string }>
): LatentCanonItem[] {
  if (authorUndecided.length === 0) return items;
  const undecidedTexts = authorUndecided
    .map((item) => normalizeComparableText(item.text))
    .filter((text) => text.length >= 4);
  if (undecidedTexts.length === 0) return items;
  return items.filter((item) => {
    const statement = normalizeComparableText(item.statement);
    if (statement.length < 4) return true;
    return !undecidedTexts.some(
      (text) => statement.includes(text) || text.includes(statement)
    );
  });
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s、。．,，!！?？:：;；'"「」『』()（）[\]【】]/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
  );
}

function resolveWishCharacterIds(
  wish: string,
  characters: Array<{ characterId: string; name: string }>
): Set<string> {
  const result = new Set<string>();
  for (const character of characters) {
    if (
      wish.includes(character.name) ||
      wish.includes(character.name.slice(0, Math.max(1, character.name.length - 1)))
    ) {
      result.add(character.characterId);
    }
  }
  return result;
}

// ============================================================
// shielded summary（設計書 7.2）
// ============================================================

export function buildCanonSummary(store: LatentCanonStore, spoilerMode: 'shielded' | 'visible') {
  const hidden = store.items.filter(
    (item) => item.status === 'provisional' || item.status === 'foreshadowed'
  );
  const byScope: Record<CanonScope, number> = {
    world: 0,
    character: 0,
    relationship: 0,
    history: 0,
    plot: 0,
    other: 0,
  };
  for (const item of hidden) byScope[item.scope] += 1;
  const revealed = store.items
    .filter((item) => item.status === 'revealed')
    .map((item) => ({
      canonId: item.canonId,
      scope: item.scope,
      statement: item.statement,
      epistemicStatus: item.epistemicStatus,
      updatedAt: item.updatedAt,
    }));
  const pendingConflicts = store.pendingConflicts.map((conflict) => ({
    conflictId: conflict.conflictId,
    kind: conflict.kind,
    summary: conflict.summary,
    evidenceExcerpt: conflict.evidenceExcerpt,
    status: conflict.status,
    generationId: conflict.generationId,
    canonId: conflict.canonId,
    contractId: conflict.contractId,
    createdAt: conflict.createdAt,
    resolvedAt: conflict.resolvedAt,
  }));
  // NOTE: 退役項目は作者の管理対象（取り消し可能）なので、shieldedでもopaqueな項目一覧
  // と件数を出す。本文はreveal操作を経てから（レビュー指摘 P2）。
  const retired = store.items.filter((item) => item.status === 'retired');
  const retiredByScope: Record<CanonScope, number> = {
    world: 0,
    character: 0,
    relationship: 0,
    history: 0,
    plot: 0,
    other: 0,
  };
  for (const item of retired) retiredByScope[item.scope] += 1;
  return {
    revision: store.revision,
    spoilerMode,
    latentSeedStatus: store.latentSeedStatus ?? 'ok',
    revealed,
    pendingConflicts,
    hidden:
      spoilerMode === 'shielded'
        ? { total: hidden.length, byScope }
        : { total: hidden.length, byScope },
    retired: {
      total: retired.length,
      byScope: retiredByScope,
      items: retired.map((item) => ({
        canonId: item.canonId,
        scope: item.scope,
        retiredReason: item.retiredReason ?? 'manual',
        updatedAt: item.updatedAt,
      })),
    },
    ...(spoilerMode === 'visible'
      ? {
          items: store.items.filter(
            (item) => item.status === 'provisional' || item.status === 'foreshadowed'
          ),
        }
      : {}),
  };
}

// ============================================================
// ヘルパー
// ============================================================

function normalizeSource(value: unknown): CanonSource {
  return value === 'setup' ||
    value === 'on-demand' ||
    value === 'generation' ||
    value === 'roleplay' ||
    value === 'manual'
    ? value
    : 'generation';
}

function normalizeStatus(value: unknown): CanonLifecycle {
  return value === 'provisional' ||
    value === 'foreshadowed' ||
    value === 'revealed' ||
    value === 'retired'
    ? value
    : 'provisional';
}

function normalizeStatusBeforeRetired(value: unknown): Exclude<CanonLifecycle, 'retired'> | undefined {
  return value === 'provisional' || value === 'foreshadowed' || value === 'revealed'
    ? value
    : undefined;
}

function normalizeScope(value: unknown): CanonScope {
  return value === 'world' ||
    value === 'character' ||
    value === 'relationship' ||
    value === 'history' ||
    value === 'plot' ||
    value === 'other'
    ? value
    : 'other';
}

function normalizeEpistemicStatus(value: unknown): CanonEpistemicStatus {
  return value === 'fact' ||
    value === 'claim' ||
    value === 'belief' ||
    value === 'rumor' ||
    value === 'unknown'
    ? value
    : 'unknown';
}

function normalizeEvidenceKind(value: unknown): CanonEvidenceKind | undefined {
  return value === 'generation' ||
    value === 'roleplay-message' ||
    value === 'roleplay-promotion' ||
    value === 'manual'
    ? value
    : undefined;
}

function normalizeConflictKind(value: unknown): CanonConflictKind | undefined {
  return value === 'revealed-canon' || value === 'hard-contract' ? value : undefined;
}

function normalizeConflictStatus(value: unknown): CanonConflictStatus {
  return value === 'pending' ||
    value === 'resolved' ||
    value === 'exception-accepted' ||
    value === 'dismissed'
    ? value
    : 'pending';
}

function normalizeRetiredReason(value: unknown): CanonRetiredReason | undefined {
  return value === 'unused' ||
    value === 'contradicted' ||
    value === 'replaced' ||
    value === 'evidence-removed' ||
    value === 'manual'
    ? value
    : undefined;
}

function asRevision(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (!text || result.includes(text)) continue;
    result.push(text);
    if (result.length >= maxItems) break;
  }
  return result;
}
