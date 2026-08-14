// 妄想増幅器の選択肢正規化テスト（設計書 5.4 / 18.1）
import { describe, expect, it } from 'vitest';
import {
  isChoiceListComplete,
  normalizeChoiceCandidates,
} from '../../src/server/services/amplifierChoiceService';
import { computeAnchorTextHash } from '../../src/server/services/amplifierService';

const BOUNDARY = '血が出る描写はしない\n離別エンドは出さない';

describe('normalizeChoiceCandidates', () => {
  it('3〜5件に揃える（各戦略をまたいで収集）', () => {
    const parsed = {
      exploit: [{ label: 'もう少し近づく', description: '相手の本音が行動から少しだけ漏れる。' }],
      variation: [{ label: '別の表情を見る', description: '同じ距離感のまま、意外な弱さを覗かせる。' }],
      explore: [{ label: '空気を少し崩す', description: '小さな予想外で二人の反応を試す。' }],
    };
    const choices = normalizeChoiceCandidates(parsed, '');
    expect(choices.length).toBe(3);
    expect(choices[0].strategy).toBe('exploit');
    expect(choices[2].strategy).toBe('explore');
    // strategy は非表示メタデータ（設計書 5.2）だが、choiceId はサーバー採番される
    expect(choices[0].choiceId).toMatch(/^amp-choice-/);
  });

  it('label 1〜40文字・description 1〜160文字を超える候補を除外する', () => {
    const parsed = {
      exploit: [
        { label: 'x'.repeat(41), description: 'ok' },
        { label: 'ok', description: 'x'.repeat(161) },
        { label: '', description: 'ok' },
        { label: 'ok', description: '' },
        { label: '有効な見出し', description: '有効な説明' },
      ],
      variation: [],
      explore: [],
    };
    const choices = normalizeChoiceCandidates(parsed, '');
    expect(choices).toHaveLength(1);
    expect(choices[0].label).toBe('有効な見出し');
  });

  it('重複する見出しは1件にまとめる', () => {
    const parsed = {
      exploit: [
        { label: '同じ見出し', description: '説明1' },
        { label: '同じ見出し', description: '説明2' },
      ],
      variation: [],
      explore: [],
    };
    const choices = normalizeChoiceCandidates(parsed, '');
    expect(choices).toHaveLength(1);
  });

  it('境界違反候補を除外する（設計書 5.4）', () => {
    const parsed = {
      exploit: [
        { label: '血が出る描写はしないを破る', description: '境界の文言をそのまま含む候補' },
        { label: '穏やかな候補', description: 'これは守る' },
      ],
      variation: [],
      explore: [],
    };
    const choices = normalizeChoiceCandidates(parsed, BOUNDARY);
    expect(choices).toHaveLength(1);
    expect(choices[0].label).toBe('穏やかな候補');
  });

  it('不正な構造は無視する', () => {
    const choices = normalizeChoiceCandidates({ exploit: 'not-an-array' }, '');
    expect(choices).toEqual([]);
    expect(normalizeChoiceCandidates(null, '')).toEqual([]);
    expect(isChoiceListComplete([])).toBe(false);
  });

  it('3件未満は不完全（failed 扱いになる）', () => {
    const parsed = {
      exploit: [{ label: '1', description: 'a' }],
      variation: [],
      explore: [],
    };
    const choices = normalizeChoiceCandidates(parsed, '');
    expect(isChoiceListComplete(choices)).toBe(false);
  });
});

describe('computeAnchorTextHash', () => {
  it('改行をLFへ正規化してSHA-256で計算する', () => {
    const crlf = computeAnchorTextHash('a\r\nb\r\nc');
    const lf = computeAnchorTextHash('a\nb\nc');
    expect(crlf).toBe(lf);
    expect(crlf).toMatch(/^[0-9a-f]{64}$/);
  });
});
