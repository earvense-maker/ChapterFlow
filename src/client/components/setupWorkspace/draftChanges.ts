import type { CharacterRole, SetupDraft } from '@shared/types';

export type StringDraftSection =
  | 'relationshipSeeds'
  | 'world'
  | 'tone'
  | 'ng'
  | 'openingSeeds'
  | 'scenarioSeeds';
type DraftItemSection = 'confirmed' | 'candidates' | 'undecided' | 'characters';
export type DraftChangeKind = 'added' | 'updated' | 'archived';
export type DraftChanges = Record<string, DraftChangeKind>;

export interface DraftChangeSummary {
  key: string;
  kind: DraftChangeKind;
  text: string;
}

export const ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主人公',
  deuteragonist: '相手役',
  supporting: '脇役',
  other: 'その他',
};

export const DRAFT_STRING_SECTION_LABELS = {
  relationshipSeeds: '関係性',
  world: '世界観',
  tone: '好み・文体',
  ng: 'NG',
  openingSeeds: '冒頭候補',
  scenarioSeeds: 'シナリオ（会話の舞台）',
} satisfies Record<StringDraftSection, string>;

export function collectDraftChanges(previous: SetupDraft, next: SetupDraft): DraftChangeSummary[] {
  const summary: DraftChangeSummary[] = [];

  if (previous.coreConcept.trim() !== next.coreConcept.trim()) {
    recordDraftChange(summary, 'coreConcept', previous.coreConcept.trim() ? 'updated' : 'added', '作品の核');
  }

  collectItemChanges(
    summary,
    'confirmed',
    previous.confirmed,
    next.confirmed,
    (item) => JSON.stringify([item.text, item.reason ?? '', item.status]),
    (item) => `決まってきたこと「${shortenDraftChangeText(item.text)}」`
  );
  collectItemChanges(
    summary,
    'candidates',
    previous.candidates,
    next.candidates,
    (item) => JSON.stringify([item.title, item.summary, item.status]),
    (item) => `候補「${shortenDraftChangeText(item.title || item.summary)}」`
  );
  collectItemChanges(
    summary,
    'undecided',
    previous.undecided,
    next.undecided,
    (item) => JSON.stringify([item.text, item.reason ?? '', item.status]),
    (item) => `未確定「${shortenDraftChangeText(item.text)}」`
  );
  collectItemChanges(
    summary,
    'characters',
    previous.characters,
    next.characters,
    (item) =>
      JSON.stringify([
        item.role,
        item.name,
        item.label,
        item.description,
        item.speechStyle ?? '',
        item.relationshipNotes ?? '',
        item.traits ?? [],
        item.secrets ?? '',
        item.status,
      ]),
    (item) => `人物「${shortenDraftChangeText(item.label || item.name || ROLE_LABELS[item.role])}」`
  );

  for (const section of Object.keys(DRAFT_STRING_SECTION_LABELS) as StringDraftSection[]) {
    // NOTE: 古いテスト・保存データが scenarioSeeds を持たない場合の後方互換。
    // previous/next のいずれかが undefined でも空配列として扱う。
    collectStringChanges(summary, section, previous[section] ?? [], next[section] ?? []);
  }

  return summary;
}

function collectItemChanges<T extends { id: string; status: string }>(
  summary: DraftChangeSummary[],
  section: DraftItemSection,
  previous: T[],
  next: T[],
  signature: (item: T) => string,
  label: (item: T) => string
) {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));

  for (const item of previous) {
    const nextItem = nextById.get(item.id);
    if (item.status === 'active' && (!nextItem || nextItem.status !== 'active')) {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'archived', label(item));
    }
  }

  for (const item of next) {
    const previousItem = previousById.get(item.id);
    if (!previousItem && item.status === 'active') {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'added', label(item));
    } else if (previousItem?.status === 'active' && item.status !== 'active') {
      continue;
    } else if (previousItem && item.status === 'active' && signature(previousItem) !== signature(item)) {
      recordDraftChange(summary, draftItemChangeKey(section, item.id), 'updated', label(item));
    }
  }
}

function collectStringChanges(
  summary: DraftChangeSummary[],
  section: StringDraftSection,
  previousValues: string[],
  nextValues: string[]
) {
  const matchingPairs = findLongestCommonStringPairs(previousValues, nextValues);
  const movedPairs = collectMovedStringPairs(previousValues, nextValues, matchingPairs);
  const movedPreviousIndexes = new Set(movedPairs.map(([previousIndex]) => previousIndex));
  const movedNextIndexes = new Set(movedPairs.map(([, nextIndex]) => nextIndex));
  const sectionLabel = DRAFT_STRING_SECTION_LABELS[section];

  for (const [, nextIndex] of movedPairs.sort((a, b) => a[1] - b[1])) {
    const nextValue = nextValues[nextIndex];
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'updated',
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」`,
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」の順番を変更`
    );
  }

  let previousStart = 0;
  let nextStart = 0;

  for (let pairIndex = 0; pairIndex <= matchingPairs.length; pairIndex += 1) {
    const [previousEnd, nextEnd] =
      matchingPairs[pairIndex] ?? [previousValues.length, nextValues.length];
    collectStringChangeSegment(
      summary,
      section,
      previousValues,
      nextValues,
      previousStart,
      previousEnd,
      nextStart,
      nextEnd,
      movedPreviousIndexes,
      movedNextIndexes
    );
    previousStart = previousEnd + 1;
    nextStart = nextEnd + 1;
  }
}

function collectStringChangeSegment(
  summary: DraftChangeSummary[],
  section: StringDraftSection,
  previousValues: string[],
  nextValues: string[],
  previousStart: number,
  previousEnd: number,
  nextStart: number,
  nextEnd: number,
  movedPreviousIndexes: ReadonlySet<number>,
  movedNextIndexes: ReadonlySet<number>
) {
  const sectionLabel = DRAFT_STRING_SECTION_LABELS[section];
  const previousSegmentIndexes = rangeIndexes(previousStart, previousEnd).filter(
    (index) => !movedPreviousIndexes.has(index)
  );
  const nextSegmentIndexes = rangeIndexes(nextStart, nextEnd).filter((index) => !movedNextIndexes.has(index));
  const replacementCount = Math.min(previousSegmentIndexes.length, nextSegmentIndexes.length);

  for (let offset = 0; offset < replacementCount; offset += 1) {
    const previousIndex = previousSegmentIndexes[offset];
    const nextIndex = nextSegmentIndexes[offset];
    const previousValue = previousValues[previousIndex];
    const nextValue = nextValues[nextIndex];
    if (normalizeDraftString(previousValue) === normalizeDraftString(nextValue)) continue;
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'updated',
      `${sectionLabel}「${shortenDraftChangeText(nextValue)}」`,
      `${sectionLabel}「${shortenDraftChangeText(previousValue)}」を「${shortenDraftChangeText(nextValue)}」に更新`
    );
  }

  for (let offset = replacementCount; offset < nextSegmentIndexes.length; offset += 1) {
    const nextIndex = nextSegmentIndexes[offset];
    recordDraftChange(
      summary,
      draftStringChangeKey(section, nextIndex),
      'added',
      `${sectionLabel}「${shortenDraftChangeText(nextValues[nextIndex])}」`
    );
  }

  for (let offset = replacementCount; offset < previousSegmentIndexes.length; offset += 1) {
    const previousIndex = previousSegmentIndexes[offset];
    recordDraftChange(
      summary,
      draftStringRemovedChangeKey(section, previousIndex),
      'archived',
      `${sectionLabel}「${shortenDraftChangeText(previousValues[previousIndex])}」`
    );
  }
}

function collectMovedStringPairs(
  previousValues: string[],
  nextValues: string[],
  matchingPairs: Array<[number, number]>
): Array<[number, number]> {
  const matchedPreviousIndexes = new Set(matchingPairs.map(([previousIndex]) => previousIndex));
  const matchedNextIndexes = new Set(matchingPairs.map(([, nextIndex]) => nextIndex));
  const unmatchedNextByText = new Map<string, number[]>();

  for (let nextIndex = 0; nextIndex < nextValues.length; nextIndex += 1) {
    if (matchedNextIndexes.has(nextIndex)) continue;
    const normalized = normalizeDraftString(nextValues[nextIndex]);
    if (!normalized) continue;
    const indexes = unmatchedNextByText.get(normalized) ?? [];
    indexes.push(nextIndex);
    unmatchedNextByText.set(normalized, indexes);
  }

  const movedPairs: Array<[number, number]> = [];
  for (let previousIndex = 0; previousIndex < previousValues.length; previousIndex += 1) {
    if (matchedPreviousIndexes.has(previousIndex)) continue;
    const normalized = normalizeDraftString(previousValues[previousIndex]);
    if (!normalized) continue;
    const nextIndexes = unmatchedNextByText.get(normalized);
    const nextIndex = nextIndexes?.shift();
    if (nextIndex === undefined || nextIndex === previousIndex) continue;
    movedPairs.push([previousIndex, nextIndex]);
  }
  return movedPairs;
}

function findLongestCommonStringPairs(
  previousValues: string[],
  nextValues: string[]
): Array<[number, number]> {
  const lengths = Array.from(
    { length: previousValues.length + 1 },
    () => Array<number>(nextValues.length + 1).fill(0)
  );

  for (let previousIndex = previousValues.length - 1; previousIndex >= 0; previousIndex -= 1) {
    for (let nextIndex = nextValues.length - 1; nextIndex >= 0; nextIndex -= 1) {
      lengths[previousIndex][nextIndex] =
        normalizeDraftString(previousValues[previousIndex]) === normalizeDraftString(nextValues[nextIndex])
          ? lengths[previousIndex + 1][nextIndex + 1] + 1
          : Math.max(lengths[previousIndex + 1][nextIndex], lengths[previousIndex][nextIndex + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let previousIndex = 0;
  let nextIndex = 0;
  while (previousIndex < previousValues.length && nextIndex < nextValues.length) {
    if (normalizeDraftString(previousValues[previousIndex]) === normalizeDraftString(nextValues[nextIndex])) {
      pairs.push([previousIndex, nextIndex]);
      previousIndex += 1;
      nextIndex += 1;
    } else if (lengths[previousIndex + 1][nextIndex] >= lengths[previousIndex][nextIndex + 1]) {
      previousIndex += 1;
    } else {
      nextIndex += 1;
    }
  }
  return pairs;
}

function rangeIndexes(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, offset) => start + offset);
}

function recordDraftChange(
  summary: DraftChangeSummary[],
  key: string,
  kind: DraftChangeKind,
  label: string,
  text = `${label}を${draftChangeKindLabel(kind)}`
) {
  summary.push({ key, kind, text });
}

export function draftChangeKindLabel(kind: DraftChangeKind): string {
  if (kind === 'added') return '追加';
  if (kind === 'archived') return '削除';
  return '更新';
}

export function draftItemChangeKey(section: DraftItemSection, id: string): string {
  return `${section}:${id}`;
}

export function draftStringChangeKey(section: StringDraftSection, index: number): string {
  return `${section}:${index}`;
}

function draftStringRemovedChangeKey(section: StringDraftSection, index: number): string {
  return `${section}:removed:${index}`;
}

function normalizeDraftString(value: string): string {
  return value.trim().toLowerCase();
}

function shortenDraftChangeText(value: string, maxLength = 36): string {
  const trimmed = value.trim() || '内容なし';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
