import { Fragment, useMemo } from 'react';
import type { NgMatch } from '@shared/ngDetection';

interface Props {
  text: string;
  matches: NgMatch[];
  onSelectMatch: (match: NgMatch) => void;
  /** 書き換え実行中のヒット。位置で識別する（同じ語が複数回出るため） */
  busyMatchStart: number | null;
  disabled: boolean;
}

// NOTE: 本文は article 直下に生の文字列として置かれていた（white-space で改行を出す）。
// ハイライトのために span へ分割しても、選択→共通NG登録の導線が壊れないよう
// 余計なブロック要素は挟まない。
export default function NgHighlightedText({
  text,
  matches,
  onSelectMatch,
  busyMatchStart,
  disabled,
}: Props) {
  const segments = useMemo(() => buildSegments(text, matches), [text, matches]);

  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${segment.match.expressionId}-${segment.match.start}`}
            className={`ng-hit${busyMatchStart === segment.match.start ? ' busy' : ''}`}
            role="button"
            tabIndex={disabled ? -1 : 0}
            aria-disabled={disabled}
            title={`NG表現「${segment.match.expressionText}」— クリックでこの一文を書き換える`}
            onClick={() => {
              if (!disabled) onSelectMatch(segment.match!);
            }}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelectMatch(segment.match!);
            }}
          >
            {segment.text}
          </mark>
        ) : (
          <Fragment key={`plain-${index}`}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}

interface Segment {
  text: string;
  match: NgMatch | null;
}

function buildSegments(text: string, matches: NgMatch[]): Segment[] {
  if (matches.length === 0) return [{ text, match: null }];

  const segments: Segment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ text: text.slice(cursor, match.start), match: null });
    }
    segments.push({ text: text.slice(match.start, match.end), match });
    cursor = match.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), match: null });
  }
  return segments;
}
