import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import type {
  CharacterRole,
  SetupDraft,
  SetupDraftCandidate,
  SetupDraftCharacter,
  SetupDraftItemSource,
  SetupDraftItemStatus,
  SetupDraftPatch,
  SetupDraftTextItem,
  SetupDraftUndecided,
  SetupLock,
} from '../types/index.js';

const LIMITS = {
  confirmed: 30,
  candidatesActive: 6,
  candidatesTotal: 20,
  undecided: 20,
  characters: 12,
  relationshipSeeds: 30,
  world: 20,
  tone: 12,
  ng: 20,
  openingSeeds: 10,
};

export function createEmptySetupDraft(): SetupDraft {
  return {
    coreConcept: '',
    confirmed: [],
    candidates: [],
    undecided: [],
    characters: [],
    relationshipSeeds: [],
    world: [],
    tone: [],
    ng: [],
    openingSeeds: [],
  };
}

export function normalizeSetupDraft(value: unknown, fallbackNow = nowIso()): SetupDraft {
  if (!isRecord(value)) return createEmptySetupDraft();

  return {
    coreConcept: asString(value.coreConcept),
    confirmed: deduplicateAndFixItemIds(
      asArray(value.confirmed)
        .map((item) => normalizeTextItem(item, 'fact', fallbackNow))
        .filter((item): item is SetupDraftTextItem => item !== null)
        .slice(0, LIMITS.confirmed),
      'fact'
    ),
    candidates: trimCandidates(
      deduplicateAndFixItemIds(
        asArray(value.candidates)
          .map((item) => normalizeCandidate(item, fallbackNow))
          .filter((item): item is SetupDraftCandidate => item !== null),
        'cand'
      )
    ),
    undecided: deduplicateAndFixItemIds(
      asArray(value.undecided)
        .map((item) => normalizeUndecided(item, fallbackNow))
        .filter((item): item is SetupDraftUndecided => item !== null)
        .slice(0, LIMITS.undecided),
      'und'
    ),
    characters: deduplicateAndFixItemIds(
      asArray(value.characters)
        .map((item) => normalizeCharacter(item, fallbackNow))
        .filter((item): item is SetupDraftCharacter => item !== null)
        .slice(0, LIMITS.characters),
      'char-draft'
    ),
    relationshipSeeds: normalizeStringList(value.relationshipSeeds, LIMITS.relationshipSeeds),
    world: normalizeStringList(value.world, LIMITS.world),
    tone: normalizeStringList(value.tone, LIMITS.tone),
    ng: normalizeStringList(value.ng, LIMITS.ng),
    openingSeeds: normalizeStringList(value.openingSeeds, LIMITS.openingSeeds),
  };
}

export function applySetupDraftPatch(input: {
  draft: SetupDraft;
  patch: unknown;
  locks: SetupLock[];
  source?: SetupDraftItemSource;
  now?: string;
}): SetupDraft {
  const now = input.now ?? nowIso();
  const source = input.source ?? 'llm';
  const patch = isRecord(input.patch) ? (input.patch as SetupDraftPatch) : {};
  const next = normalizeSetupDraft(input.draft, now);

  const coreConcept = asString(patch.coreConcept);
  if (coreConcept && !isPathLocked(input.locks, 'draft.coreConcept')) {
    next.coreConcept = coreConcept;
  }

  if (source === 'llm') {
    const confirmedAdditions = asArray(patch.confirmedAdd);
    const userConfirmed = confirmedAdditions.filter((item) => extractSource(item) === 'user');
    const pendingConfirmed = confirmedAdditions.filter((item) => extractSource(item) !== 'user');
    addTextItems(next.confirmed, userConfirmed, 'fact', LIMITS.confirmed, source, now);
    addUndecided(
      next.undecided,
      pendingConfirmed.map((item) =>
        isRecord(item)
          ? { ...item, reason: 'LLM提案のため未確定として保留' }
          : { text: String(item), reason: 'LLM提案のため未確定として保留' }
      ),
      source,
      now
    );
  } else {
    addTextItems(next.confirmed, patch.confirmedAdd, 'fact', LIMITS.confirmed, source, now);
  }
  addCandidates(next.candidates, patch.candidatesAdd, source, now);
  addUndecided(next.undecided, patch.undecidedAdd, source, now);
  addCharacters(next.characters, patch.charactersAdd, source, now);
  updateCharacters(next.characters, patch.charactersUpdate, input.locks, now);
  addStringItems(next.relationshipSeeds, patch.relationshipSeedsAdd, LIMITS.relationshipSeeds, input.locks, 'draft.relationshipSeeds');
  addStringItems(next.world, patch.worldAdd, LIMITS.world, input.locks, 'draft.world');
  addStringItems(next.tone, patch.toneAdd, LIMITS.tone, input.locks, 'draft.tone');
  addStringItems(next.ng, patch.ngAdd, LIMITS.ng, input.locks, 'draft.ng');
  addStringItems(next.openingSeeds, patch.openingSeedsAdd, LIMITS.openingSeeds, input.locks, 'draft.openingSeeds');
  archiveIds(next, patch.archiveIds, input.locks, now);

  next.candidates = trimCandidates(next.candidates);
  return next;
}

function addTextItems(
  items: SetupDraftTextItem[],
  additions: unknown,
  prefix: string,
  limit: number,
  source: SetupDraftItemSource,
  now: string
): void {
  for (const addition of asArray(additions)) {
    const normalized = normalizeTextItem(addition, prefix, now, source, true);
    if (!normalized) continue;
    if (items.some((item) => item.status === 'active' && sameText(item.text, normalized.text))) continue;
    if (items.length >= limit) break;
    items.push(normalized);
  }
}

function addCandidates(
  candidates: SetupDraftCandidate[],
  additions: unknown,
  source: SetupDraftItemSource,
  now: string
): void {
  for (const addition of asArray(additions)) {
    const normalized = normalizeCandidate(addition, now, source, true);
    if (!normalized) continue;
    if (
      candidates.some(
        (candidate) =>
          candidate.status === 'active' &&
          (sameText(candidate.title, normalized.title) || sameNonEmptyText(candidate.summary, normalized.summary))
      )
    ) {
      continue;
    }
    candidates.push(normalized);
  }
}

function addUndecided(
  items: SetupDraftUndecided[],
  additions: unknown,
  source: SetupDraftItemSource,
  now: string
): void {
  for (const addition of asArray(additions)) {
    const normalized = normalizeUndecided(addition, now, source, true);
    if (!normalized) continue;
    if (items.some((item) => item.status === 'active' && sameText(item.text, normalized.text))) continue;
    if (items.length >= LIMITS.undecided) break;
    items.push(normalized);
  }
}

function addCharacters(
  characters: SetupDraftCharacter[],
  additions: unknown,
  source: SetupDraftItemSource,
  now: string
): void {
  for (const addition of asArray(additions)) {
    const normalized = normalizeCharacter(addition, now, source, true);
    if (!normalized) continue;
    if (
      characters.some(
        (character) =>
          character.status === 'active' &&
          sameText(character.role, normalized.role) &&
          sameText(character.label || character.name, normalized.label || normalized.name)
      )
    ) {
      continue;
    }
    if (characters.length >= LIMITS.characters) break;
    characters.push(normalized);
  }
}

function updateCharacters(
  characters: SetupDraftCharacter[],
  updates: unknown,
  locks: SetupLock[],
  now: string
): void {
  for (const update of asArray(updates)) {
    if (!isRecord(update)) continue;
    const id = asString(update.id);
    if (!id) continue;
    const current = characters.find((character) => character.id === id);
    if (!current || current.locked || isPathLocked(locks, id)) continue;

    const lockedFields = new Set(current.lockedFields ?? []);
    let changed = false;
    const role = normalizeRole(update.role);
    if (role && !lockedFields.has('role') && current.role !== role) {
      current.role = role;
      changed = true;
    }
    const name = asString(update.name);
    if (name && !lockedFields.has('name') && current.name !== name) {
      current.name = name;
      changed = true;
    }
    const label = asString(update.label);
    if (label && !lockedFields.has('label') && current.label !== label) {
      current.label = label;
      changed = true;
    }
    const description = asString(update.description);
    if (description && !lockedFields.has('description') && current.description !== description) {
      current.description = description;
      changed = true;
    }
    const speechStyle = asString(update.speechStyle);
    if (speechStyle && !lockedFields.has('speechStyle') && current.speechStyle !== speechStyle) {
      current.speechStyle = speechStyle;
      changed = true;
    }
    const relationshipNotes = asString(update.relationshipNotes);
    if (
      relationshipNotes &&
      !lockedFields.has('relationshipNotes') &&
      current.relationshipNotes !== relationshipNotes
    ) {
      current.relationshipNotes = relationshipNotes;
      changed = true;
    }
    const want = asString(update.want);
    if (want && !lockedFields.has('want') && current.want !== want) {
      current.want = want;
      changed = true;
    }
    const fear = asString(update.fear);
    if (fear && !lockedFields.has('fear') && current.fear !== fear) {
      current.fear = fear;
      changed = true;
    }
    const secret = asString(update.secret);
    if (secret && !lockedFields.has('secret') && current.secret !== secret) {
      current.secret = secret;
      changed = true;
    }
    if (changed) {
      current.updatedAt = now;
    }
  }
}

function addStringItems(
  items: string[],
  additions: unknown,
  limit: number,
  locks: SetupLock[],
  path: string
): void {
  if (isPathLocked(locks, path)) return;
  for (const item of normalizeStringList(additions, limit)) {
    if (items.some((existing) => sameText(existing, item))) continue;
    if (items.length >= limit) break;
    items.push(item);
  }
}

function archiveIds(draft: SetupDraft, archiveIdsValue: unknown, locks: SetupLock[], now: string): void {
  const ids = normalizeStringList(archiveIdsValue, 100);
  if (ids.length === 0) return;

  for (const id of ids) {
    archiveItem(draft.confirmed, id, locks, now);
    archiveItem(draft.candidates, id, locks, now);
    archiveItem(draft.undecided, id, locks, now);
    archiveItem(draft.characters, id, locks, now);
  }
}

function archiveItem<T extends { id: string; status: SetupDraftItemStatus; locked?: boolean; updatedAt: string }>(
  items: T[],
  id: string,
  locks: SetupLock[],
  now: string
): void {
  const item = items.find((entry) => entry.id === id);
  if (!item || item.locked || isPathLocked(locks, id)) return;
  item.status = 'archived';
  item.updatedAt = now;
}

function normalizeTextItem(
  value: unknown,
  prefix: string,
  fallbackNow: string,
  fallbackSource: SetupDraftItemSource = 'manual',
  forceNewId = false
): SetupDraftTextItem | null {
  const text = typeof value === 'string' ? value.trim() : isRecord(value) ? asString(value.text) : '';
  if (!text) return null;
  const record = isRecord(value) ? value : {};
  const createdAt = asString(record.createdAt) || fallbackNow;
  return {
    id: forceNewId ? generateTimestampId(prefix) : normalizeItemId(record.id, prefix),
    text,
    source: normalizeSource(record.source, fallbackSource),
    status: normalizeStatus(record.status),
    locked: asBoolean(record.locked),
    reason: asString(record.reason) || undefined,
    createdAt,
    updatedAt: asString(record.updatedAt) || createdAt,
  };
}

function normalizeCandidate(
  value: unknown,
  fallbackNow: string,
  fallbackSource: SetupDraftItemSource = 'manual',
  forceNewId = false
): SetupDraftCandidate | null {
  if (!isRecord(value)) return null;
  const title = asString(value.title);
  const summary = asString(value.summary);
  if (!title && !summary) return null;
  const createdAt = asString(value.createdAt) || fallbackNow;
  return {
    id: forceNewId ? generateTimestampId('cand') : normalizeItemId(value.id, 'cand'),
    title: title || summary.slice(0, 40),
    summary,
    source: normalizeSource(value.source, fallbackSource),
    status: normalizeStatus(value.status),
    locked: asBoolean(value.locked),
    createdAt,
    updatedAt: asString(value.updatedAt) || createdAt,
  };
}

function normalizeUndecided(
  value: unknown,
  fallbackNow: string,
  fallbackSource: SetupDraftItemSource = 'manual',
  forceNewId = false
): SetupDraftUndecided | null {
  const item = normalizeTextItem(value, 'und', fallbackNow, fallbackSource, forceNewId);
  if (!item) return null;
  const record = isRecord(value) ? value : {};
  return {
    ...item,
    reason: asString(record.reason) || undefined,
  };
}

function normalizeCharacter(
  value: unknown,
  fallbackNow: string,
  fallbackSource: SetupDraftItemSource = 'manual',
  forceNewId = false
): SetupDraftCharacter | null {
  if (!isRecord(value)) return null;
  const role = normalizeRole(value.role) ?? 'supporting';
  const name = asString(value.name);
  const label = asString(value.label) || name;
  const description = asString(value.description);
  if (!name && !label && !description) return null;
  const createdAt = asString(value.createdAt) || fallbackNow;
  return {
    id: forceNewId ? generateTimestampId('char-draft') : normalizeItemId(value.id, 'char-draft'),
    role,
    name,
    label,
    description,
    speechStyle: asString(value.speechStyle) || undefined,
    relationshipNotes: asString(value.relationshipNotes) || undefined,
    want: asString(value.want) || undefined,
    fear: asString(value.fear) || undefined,
    secret: asString(value.secret) || undefined,
    lockedFields: normalizeStringList(value.lockedFields, 12),
    source: normalizeSource(value.source, fallbackSource),
    status: normalizeStatus(value.status),
    locked: asBoolean(value.locked),
    createdAt,
    updatedAt: asString(value.updatedAt) || createdAt,
  };
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

function normalizeItemId(value: unknown, prefix: string): string {
  const text = asString(value);
  if (text && !text.startsWith('draft.') && SAFE_PATH_SEGMENT.test(text)) return text;
  return generateTimestampId(prefix);
}

function deduplicateAndFixItemIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map((item) => {
    if (!item.id || item.id.startsWith('draft.') || !SAFE_PATH_SEGMENT.test(item.id) || seen.has(item.id)) {
      return { ...item, id: generateTimestampId(prefix) };
    }
    seen.add(item.id);
    return item;
  });
}

function trimCandidates(candidates: SetupDraftCandidate[]): SetupDraftCandidate[] {
  const active: SetupDraftCandidate[] = [];
  const archived: SetupDraftCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.status === 'active' && active.length < LIMITS.candidatesActive) {
      active.push(candidate);
    } else {
      archived.push({ ...candidate, status: 'archived' });
    }
  }

  return [...active, ...archived].slice(0, LIMITS.candidatesTotal);
}

function normalizeStringList(value: unknown, limit: number): string[] {
  const result: string[] = [];
  for (const item of asArray(value)) {
    const text = asString(item);
    if (!text || result.some((existing) => sameText(existing, text))) continue;
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

function isPathLocked(locks: SetupLock[], needle: string): boolean {
  return locks.some((lock) => {
    if (lock.path === needle) return true;
    return lock.path.startsWith(`${needle}.`) || needle.startsWith(`${lock.path}.`);
  });
}

function extractSource(value: unknown): string {
  return isRecord(value) ? asString(value.source) : '';
}

function normalizeRole(value: unknown): CharacterRole | null {
  return value === 'protagonist' ||
    value === 'deuteragonist' ||
    value === 'supporting' ||
    value === 'other'
    ? value
    : null;
}

function normalizeSource(value: unknown, fallback: SetupDraftItemSource): SetupDraftItemSource {
  return value === 'user' || value === 'llm' || value === 'manual' ? value : fallback;
}

function normalizeStatus(value: unknown): SetupDraftItemStatus {
  return value === 'archived' ? 'archived' : 'active';
}

function sameText(a: string, b: string): boolean {
  return normalizeComparableText(a) === normalizeComparableText(b);
}

function sameNonEmptyText(a: string, b: string): boolean {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);
  return Boolean(left && right && left === right);
}

export function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
