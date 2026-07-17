import type { WorldContent } from '../types/index.js';

export type WorldSegment = { kind: 'normal' | 'initial'; content: string };

type FenceMarker = '`' | '~';
type ScannedLine = {
  line: string;
  outsideFence: boolean;
};

const FOUNDATION_HEADING = /^\s*(#{2,4})\s*世界の土台\s*$/;
const INITIAL_HEADING = /^\s*(#{2,4})\s*開始時点の状況\s*$/;
const ANY_HEADING = /^\s*(#{1,6})\s*(?=\S)/;
const LITERAL_CANONICAL_HEADING =
  /^(\s*)(\\*)(#{2,4}\s*(?:世界の土台|開始時点の状況)\s*)$/;
const LITERAL_FENCE_LINE = /^(\s*)(\\*)((?:`{3,}|~{3,}).*)$/;

function normalizeText(text: string): string {
  return text.trim().replace(/\r\n?/g, '\n');
}

function scanWorldLines(text: string): {
  source: string;
  original: string;
  lines: ScannedLine[];
  closed: boolean;
} {
  const source = text.trim();
  const original = normalizeText(source);
  let fenceMarker: FenceMarker | null = null;
  const lines = original.split('\n').map((line): ScannedLine => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as FenceMarker;
      if (!fenceMarker) fenceMarker = marker;
      else if (fenceMarker === marker) fenceMarker = null;
      return { line, outsideFence: false };
    }
    return { line, outsideFence: fenceMarker === null };
  });
  return { source, original, lines, closed: fenceMarker === null };
}

function isFoundationHeading(line: ScannedLine): boolean {
  return line.outsideFence && FOUNDATION_HEADING.test(line.line);
}

function isInitialHeading(line: ScannedLine): boolean {
  return line.outsideFence && INITIAL_HEADING.test(line.line);
}

function escapeStructuralLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const heading = line.match(LITERAL_CANONICAL_HEADING);
      if (heading) return `${heading[1]}\\${heading[2]}${heading[3]}`;
      const fence = line.match(LITERAL_FENCE_LINE);
      if (fence) return `${fence[1]}\\${fence[2]}${fence[3]}`;
      return line;
    })
    .join('\n');
}

function unescapeStructuralLine(line: string): string {
  const heading = line.match(LITERAL_CANONICAL_HEADING);
  if (heading && heading[2].length > 0) {
    return `${heading[1]}${heading[2].slice(1)}${heading[3]}`;
  }
  const fence = line.match(LITERAL_FENCE_LINE);
  if (fence && fence[2].length > 0) {
    return `${fence[1]}${fence[2].slice(1)}${fence[3]}`;
  }
  return line;
}

export function isCanonicalWorldMd(text: string): boolean {
  const scan = scanWorldLines(text);
  return scan.closed && scan.lines.some(isFoundationHeading);
}

export function hasCompleteCanonicalWorldStructure(text: string): boolean {
  const scan = scanWorldLines(text);
  const foundationCount = scan.lines.filter(isFoundationHeading).length;
  const initialCount = scan.lines.filter(isInitialHeading).length;
  return scan.closed && foundationCount === 1 && initialCount === 1;
}

export function parseWorldMd(text: string): WorldContent {
  const scan = scanWorldLines(text);
  if (!scan.original) return { foundation: '', initialSituation: '' };

  const hasFoundation = scan.lines.some(isFoundationHeading);
  if (!scan.closed) {
    // NOTE: 旧 splitWorldByConvention は未閉じフェンスを全文 normal としていた。
    // canonical マーカーすらない壊れた旧形式は foundation に戻して互換性を守る。
    return hasFoundation
      ? { foundation: '', initialSituation: scan.original }
      : { foundation: scan.original, initialSituation: '' };
  }

  if (hasFoundation) return parseCanonical(scan.lines);
  return parseLegacy(scan);
}

function parseCanonical(lines: ScannedLine[]): WorldContent {
  const foundation: string[] = [];
  const initial: string[] = [];
  let target: 'foundation' | 'initial' = 'foundation';
  let sawFoundation = false;
  let sawInitial = false;

  for (const scanned of lines) {
    if (isFoundationHeading(scanned) && !sawFoundation) {
      target = 'foundation';
      sawFoundation = true;
      continue;
    }
    if (isInitialHeading(scanned) && !sawInitial) {
      target = 'initial';
      sawInitial = true;
      continue;
    }
    (target === 'foundation' ? foundation : initial).push(
      unescapeStructuralLine(scanned.line)
    );
  }

  return {
    foundation: foundation.join('\n').trim(),
    initialSituation: initial.join('\n').trim(),
  };
}

function splitLegacySegments(scan: ReturnType<typeof scanWorldLines>): WorldSegment[] {
  if (!scan.original) return [];
  if (!scan.closed) return [{ kind: 'normal', content: scan.source }];

  const segments: WorldSegment[] = [];
  let currentKind: WorldSegment['kind'] = 'normal';
  let currentInitialLevel: number | null = null;
  let sawInitialHeading = false;
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    buffer = [];
    if (!content) return;
    const previous = segments[segments.length - 1];
    if (previous?.kind === currentKind) {
      previous.content = `${previous.content}\n${content}`;
    } else {
      segments.push({ kind: currentKind, content });
    }
  };

  for (const scanned of scan.lines) {
    if (scanned.outsideFence) {
      const initialHeading = scanned.line.match(INITIAL_HEADING);
      const headingLevel = scanned.line.match(ANY_HEADING)?.[1].length;

      if (
        currentInitialLevel !== null &&
        headingLevel !== undefined &&
        headingLevel <= currentInitialLevel
      ) {
        flush();
        currentKind = 'normal';
        currentInitialLevel = null;
      }

      if (currentInitialLevel === null && initialHeading) {
        flush();
        currentKind = 'initial';
        currentInitialLevel = initialHeading[1].length;
        sawInitialHeading = true;
        continue;
      }
    }
    buffer.push(scanned.line);
  }

  if (!sawInitialHeading) return [{ kind: 'normal', content: scan.source }];
  flush();
  return segments;
}

function parseLegacy(scan: ReturnType<typeof scanWorldLines>): WorldContent {
  const segments = splitLegacySegments(scan);
  if (!segments.some((segment) => segment.kind === 'initial')) {
    return { foundation: '', initialSituation: scan.original };
  }
  return {
    foundation: segments
      .filter((segment) => segment.kind === 'normal')
      .map((segment) => segment.content)
      .join('\n')
      .trim(),
    initialSituation: segments
      .filter((segment) => segment.kind === 'initial')
      .map((segment) => segment.content)
      .join('\n')
      .trim(),
  };
}

export function splitWorldByConvention(worldText: string): WorldSegment[] {
  const scan = scanWorldLines(worldText);
  if (!scan.original) return [];
  if (!scan.closed) return [{ kind: 'normal', content: scan.source }];
  if (!scan.lines.some(isFoundationHeading)) return splitLegacySegments(scan);

  const content = parseCanonical(scan.lines);
  const segments: WorldSegment[] = [];
  if (content.foundation) segments.push({ kind: 'normal', content: content.foundation });
  if (content.initialSituation) {
    segments.push({ kind: 'initial', content: content.initialSituation });
  }
  return segments;
}

export function serializeWorldMd(content: WorldContent): string {
  const foundation = escapeStructuralLines(content.foundation.trim());
  const initialSituation = escapeStructuralLines(content.initialSituation.trim());
  return [
    '## 世界の土台',
    foundation,
    '',
    '## 開始時点の状況',
    initialSituation,
    '',
  ].join('\n');
}
