import { describe, expect, it } from 'vitest';
import {
  hasCompleteCanonicalWorldStructure,
  isCanonicalWorldMd,
  parseWorldMd,
  serializeWorldMd,
} from '../../src/server/utils/worldMd';

describe('worldMd', () => {
  it('round-trips canonical content while preserving non-canonical subheadings', () => {
    const content = {
      foundation: '魔法は記憶を消費する。\n\n## 地理\n北に山脈がある。',
      initialSituation: '王国は停戦中。\n\n## 現在の勢力図\n東西が拮抗している。',
    };
    const text = serializeWorldMd(content);

    expect(isCanonicalWorldMd(text)).toBe(true);
    expect(hasCompleteCanonicalWorldStructure(text)).toBe(true);
    expect(parseWorldMd(text)).toEqual(content);
  });

  it('keeps both headings when either side is empty', () => {
    const text = serializeWorldMd({ foundation: '', initialSituation: '春の夜。' });

    expect(text).toBe('## 世界の土台\n\n\n## 開始時点の状況\n春の夜。\n');
    expect(parseWorldMd(text)).toEqual({ foundation: '', initialSituation: '春の夜。' });
  });

  it('folds legacy normal segments into foundation and initial segments into initialSituation', () => {
    expect(
      parseWorldMd('法則A\n## 開始時点の状況\n王国は平和\n## 地理\n北に山脈')
    ).toEqual({
      foundation: '法則A\n## 地理\n北に山脈',
      initialSituation: '王国は平和',
    });
  });

  it('maps pre-L4 text to initial but preserves legacy fail-open for an unclosed fence', () => {
    expect(parseWorldMd('古い世界設定')).toEqual({
      foundation: '',
      initialSituation: '古い世界設定',
    });
    expect(parseWorldMd('```md\n## 世界の土台\n未閉じ')).toEqual({
      foundation: '```md\n## 世界の土台\n未閉じ',
      initialSituation: '',
    });
  });

  it('ignores canonical-looking headings inside closed code fences', () => {
    const text = '```md\n## 世界の土台\n```\n## 開始時点の状況\n現在';
    expect(isCanonicalWorldMd(text)).toBe(false);
    expect(parseWorldMd(text)).toEqual({
      foundation: '```md\n## 世界の土台\n```',
      initialSituation: '現在',
    });
  });

  it('requires both canonical headings exactly once for refine post-checks', () => {
    expect(hasCompleteCanonicalWorldStructure('## 世界の土台\n土台')).toBe(false);
    expect(
      hasCompleteCanonicalWorldStructure(
        '## 世界の土台\n土台\n## 開始時点の状況\n現在\n## 開始時点の状況\n重複'
      )
    ).toBe(false);
  });

  it('round-trips reserved canonical heading lines used as literal body text', () => {
    const content = {
      foundation: '法則\n## 開始時点の状況\nこれは見出し名の説明。',
      initialSituation: '\\## 世界の土台\n先頭のバックスラッシュも本文。',
    };
    const text = serializeWorldMd(content);

    expect(text).toContain('\\## 開始時点の状況');
    expect(text).toContain('\\\\## 世界の土台');
    expect(hasCompleteCanonicalWorldStructure(text)).toBe(true);
    expect(parseWorldMd(text)).toEqual(content);
  });

  it('round-trips closed and unclosed fence lines without hiding the canonical boundary', () => {
    const content = {
      foundation: '```ts\nconst value = 1;',
      initialSituation: '~~~md\n状況メモ\n~~~',
    };
    const text = serializeWorldMd(content);

    expect(text).toContain('\\```ts');
    expect(text).toContain('\\~~~md');
    expect(hasCompleteCanonicalWorldStructure(text)).toBe(true);
    expect(parseWorldMd(text)).toEqual(content);
  });
});
