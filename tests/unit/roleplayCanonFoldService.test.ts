import { describe, expect, it } from 'vitest';
import {
  applySessionCanonPatch,
  parseSessionCanonEntries,
} from '../../src/server/services/roleplayCanonFoldService';

describe('roleplayCanonFoldService（設計書 8.2・12.3）', () => {
  it('sessionCanonエントリを正規化して読む', () => {
    const entries = parseSessionCanonEntries([
      {
        targetCanonId: 'can-1',
        scope: 'character',
        statement: '護衛は裏切らないと約束した',
        epistemicStatus: 'fact',
        disclosure: 'revealed',
        evidenceExcerpt: '「必ず守る」',
      },
      {
        scope: 'world',
        statement: '港町の噂',
        epistemicStatus: 'rumor',
        disclosure: 'foreshadowed',
        evidenceExcerpt: '噂の話',
      },
      { scope: 'bad', statement: '', epistemicStatus: 'fact', disclosure: 'revealed', evidenceExcerpt: '' },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].canonId).toBe('can-1');
    expect(entries[1].epistemicStatus).toBe('rumor');
    expect(entries[1].disclosure).toBe('foreshadowed');
  });

  it('既存IDへのtargetは更新、重複statementはmerge、新規は追加する', () => {
    const existing = [
      {
        canonId: 'can-1',
        scope: 'character',
        statement: '護衛の過去は傭兵だった',
        status: 'foreshadowed',
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: 'unknown',
        source: 'roleplay',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      existing,
      [
        {
          canonId: 'can-1',
          scope: 'character',
          statement: '護衛の過去は傭兵だった（決定的な告白）',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '護衛は自ら告白した。',
        },
        {
          scope: 'character',
          statement: '護衛の過去は傭兵だった',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '重複',
        },
        {
          scope: 'relationship',
          statement: '二人は信頼を深めた',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '信頼の描写',
        },
      ],
      'rm-100'
    );
    expect(next).toHaveLength(2);
    expect(next[0].status).toBe('revealed');
    // 1件目のtarget更新と2件目の重複statement mergeでevidenceが2件付く
    expect(next[0].evidence).toHaveLength(2);
    expect(next[0].evidence[0].kind).toBe('roleplay-message');
    expect(next[0].evidence[0].messageId).toBe('rm-100');
    // 重複statementは新規にならず既存へmergeされた
    expect(next[1].canonId).not.toBe('can-1');
    expect(next[1].scope).toBe('relationship');
  });

  it('台詞はclaimとして保存されfactにならない', () => {
    const next = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: '私は王の娘だ',
          epistemicStatus: 'claim',
          disclosure: 'revealed',
          evidenceExcerpt: '「私は王の娘だ」',
        },
      ],
      'rm-1'
    );
    expect(next[0].epistemicStatus).toBe('claim');
    expect(next[0].status).toBe('revealed');
  });
});
