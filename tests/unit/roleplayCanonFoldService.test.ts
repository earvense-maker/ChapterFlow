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

  // NOTE: レビューP2。disclosure の欠落・未知値は最強の revealed として補正せず、
  // 構造不正な項目ごと捨てる。
  it('欠落・未知のdisclosureを持つ項目は捨てる', () => {
    const entries = parseSessionCanonEntries([
      {
        scope: 'character',
        statement: 'disclosure が無い項目',
        epistemicStatus: 'fact',
        evidenceExcerpt: '根拠',
      },
      {
        scope: 'character',
        statement: 'disclosure が未知の項目',
        epistemicStatus: 'fact',
        disclosure: 'half-revealed',
        evidenceExcerpt: '根拠',
      },
      {
        scope: 'character',
        statement: '有効な項目',
        epistemicStatus: 'fact',
        disclosure: 'foreshadowed',
        evidenceExcerpt: '根拠',
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].statement).toBe('有効な項目');
    expect(entries[0].disclosure).toBe('foreshadowed');
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

  // NOTE: 設計書 6.3・12.3-21。初期 canon の ID を target した抽出は、同じ canonId の
  // session-local 項目を作る。プロジェクト側の canon store は触らない。
  it('初期canon IDへのtargetは同じIDのsession-local項目を作る', () => {
    const initial = [
      {
        canonId: 'can-initial-1',
        scope: 'character',
        subjectCharacterIds: ['char-a'],
        statement: 'ユイは王家の血を引く',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        knownBy: ['char-b'],
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          canonId: 'can-initial-1',
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '「ユイは王家の血を引く」と明かした。',
        },
      ],
      'rm-50',
      { initialCanonCandidates: initial, foldTargetText: 'ユイは「ユイは王家の血を引く」と明かした。' }
    );
    expect(next).toHaveLength(1);
    expect(next[0].canonId).toBe('can-initial-1');
    expect(next[0].status).toBe('revealed');
    expect(next[0].scope).toBe('character');
    expect(next[0].subjectCharacterIds).toEqual(['char-a']);
    expect(next[0].knownBy).toEqual(['char-b']);
    expect(next[0].source).toBe('setup');
    expect(next[0].evidence).toHaveLength(1);
    expect(next[0].evidence[0].kind).toBe('roleplay-message');
    expect(next[0].evidence[0].messageId).toBe('rm-50');
  });

  // NOTE: 設計書 6.3・12.3-22。候補一覧を見ただけで公開・示唆済みにしない。
  // fold対象会話本文に evidenceExcerpt の根拠が無い初期canonの状態変更は採用しない。
  it('初期canon候補だけでは公開状態を更新せず、fold対象会話内のevidenceが必要になる', () => {
    const initial = [
      {
        canonId: 'can-initial-2',
        scope: 'character',
        statement: 'ユイは王家の血を引く',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          canonId: 'can-initial-2',
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: 'この抜粋は会話本文に存在しない',
        },
      ],
      'rm-51',
      { initialCanonCandidates: initial, foldTargetText: '会話はただの雑談だった。' }
    );
    // 根拠が無いため session-local 化しない
    expect(next).toHaveLength(0);
  });

  // NOTE: レビューP1。targetCanonId を省略して同じ statement を返す経路でも、
  // 初期 canon とのフォールバック照合が走り、evidence 検証を迂回できない。
  it('ID省略で初期canonと同じstatementでも、evidence無しは採用しない', () => {
    const initial = [
      {
        canonId: 'can-initial-3',
        scope: 'character',
        subjectCharacterIds: ['char-a'],
        statement: 'ユイは王家の血を引く',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const withoutEvidence = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '会話に無い抜粋',
        },
      ],
      'rm-52',
      { initialCanonCandidates: initial, foldTargetText: '普通の会話だけだった。' }
    );
    expect(withoutEvidence).toHaveLength(0);

    const withEvidence = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '王家の血を引くと話した',
        },
      ],
      'rm-53',
      { initialCanonCandidates: initial, foldTargetText: 'ユイは王家の血を引くと話した。' }
    );
    expect(withEvidence).toHaveLength(1);
    expect(withEvidence[0].canonId).toBe('can-initial-3');
    expect(withEvidence[0].status).toBe('revealed');
    expect(withEvidence[0].subjectCharacterIds).toEqual(['char-a']);
  });

  // NOTE: レビューP1。subjectCharacterIds が食い違う statement は初期 canon の
  // 照合対象にせず、会話由来の新規項目として扱う（誤統合しない）。
  it('subjectCharacterIds が不一致なら初期canon照合にならず新規項目になる', () => {
    const initial = [
      {
        canonId: 'can-initial-4',
        scope: 'character',
        subjectCharacterIds: ['char-a'],
        statement: '王家の血を引く',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: '王家の血を引く',
          subjectCharacterIds: ['char-b'],
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '王家の血を引く',
        },
      ],
      'rm-54',
      { initialCanonCandidates: initial, foldTargetText: '王家の血を引くと言った。' }
    );
    expect(next).toHaveLength(1);
    expect(next[0].canonId).not.toBe('can-initial-4');
    expect(next[0].subjectCharacterIds).toEqual(['char-b']);
  });

  // NOTE: レビューP1。初期状態が revealed の項目を後続 fold の foreshadowed で
  // 降格させない（既存 session item と同じ no-downgrade 規則）。
  it('初期revealedの項目は後続のforeshadowedで降格しない', () => {
    const initial = [
      {
        canonId: 'can-initial-5',
        scope: 'character',
        statement: 'アリスは父と和解済み',
        status: 'revealed',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          canonId: 'can-initial-5',
          scope: 'character',
          statement: 'アリスは父と和解済み',
          epistemicStatus: 'fact',
          disclosure: 'foreshadowed',
          evidenceExcerpt: '和解の話',
        },
      ],
      'rm-55',
      { initialCanonCandidates: initial, foldTargetText: '和解の話をした。' }
    );
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe('revealed');
  });

  // NOTE: 設計書 6.3・12.3-23。増分foldで revealed を後続の foreshadowed で上書きしない。
  it('増分foldで revealed が foreshadowed へ降格しない', () => {
    const existing = [
      {
        canonId: 'can-1',
        scope: 'character',
        statement: '護衛の過去は傭兵だった',
        status: 'revealed',
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: 'fact',
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
          statement: '護衛の過去は傭兵だった',
          epistemicStatus: 'unknown',
          disclosure: 'foreshadowed',
          evidenceExcerpt: '仄めかす発言',
        },
      ],
      'rm-52'
    );
    expect(next[0].status).toBe('revealed');
    expect(next[0].evidence).toHaveLength(1);
    expect(next[0].evidence[0].disclosure).toBe('foreshadowed');
  });

  // NOTE: 改修問題2。モデルが誤った targetCanonId を返しても、ID一致だけで元の文を
  // 上書きしない。無関係な statement は既存項目を壊さず新規項目として追加する。
  it('誤ったtargetCanonId＋無関係なstatementは既存session項目を上書きせず新規項目にする', () => {
    const existing = [
      {
        canonId: 'can-1',
        scope: 'world',
        statement: '笑うと花びらが舞う',
        status: 'foreshadowed',
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: 'fact',
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
          scope: 'world',
          statement: '花が風で音を立てる',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '花が風で音を立てた。',
        },
      ],
      'rm-100'
    );
    // 既存項目は上書きされず、無関係な文は新規項目になる
    expect(next).toHaveLength(2);
    expect(next.find((item) => item.canonId === 'can-1')!.statement).toBe('笑うと花びらが舞う');
    const added = next.find((item) => item.canonId !== 'can-1')!;
    expect(added.statement).toBe('花が風で音を立てる');
    expect(added.status).toBe('revealed');
  });

  // NOTE: 改修問題2。初期 canon を target する場合も ID 一致だけでは採用せず、
  // 文の意味的一致を要求する。無関係な文は初期 canon へ上書きせず新規項目になる。
  it('誤ったtargetCanonId＋無関係なstatementは初期canonへ上書きせず新規項目にする', () => {
    const initial = [
      {
        canonId: 'can-initial-1',
        scope: 'world',
        statement: '雲の上に国を守る精霊がいる',
        status: 'provisional',
        baseStatusWithoutEvidence: 'provisional',
        epistemicStatus: 'fact',
        source: 'setup',
        manualLock: false,
        evidence: [],
        createdAt: '2026-07-02T00:00:00Z',
        updatedAt: '2026-07-02T00:00:00Z',
      },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          canonId: 'can-initial-1',
          scope: 'world',
          statement: '綿あめの島に乗ると酔う',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '綿あめの島に乗ると酔うと言った。',
        },
      ],
      'rm-101',
      { initialCanonCandidates: initial, foldTargetText: '綿あめの島に乗ると酔うと言った。' }
    );
    expect(next).toHaveLength(1);
    expect(next[0].canonId).not.toBe('can-initial-1');
    expect(next[0].statement).toBe('綿あめの島に乗ると酔う');
  });

  // NOTE: 改修問題2。意味が一致する場合のID指定更新は従来どおり働く。
  it('意味が一致するtargetCanonIdの更新は従来どおり上書きする', () => {
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
      ],
      'rm-102'
    );
    expect(next).toHaveLength(1);
    expect(next[0].canonId).toBe('can-1');
    expect(next[0].statement).toBe('護衛の過去は傭兵だった（決定的な告白）');
    expect(next[0].status).toBe('revealed');
  });

  // NOTE: 改修問題2。evidence の messageId は fold 境界ではなく、抜粋を含む実際の
  // 引用元メッセージへ解決される。どこにも含まれない場合は境界へ落ちる。
  it('evidenceのmessageIdを実際の引用元メッセージへ解決する', () => {
    const foldTargetMessages = [
      { messageId: 'rm-fold-1', content: 'ユイは王家の血を引くと言った。' },
      { messageId: 'rm-fold-2', content: 'ユイはこれから城へ帰る。' },
    ];
    const next = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '王家の血を引くと言った',
        },
      ],
      'rm-boundary',
      { foldTargetMessages }
    );
    expect(next).toHaveLength(1);
    expect(next[0].evidence[0].messageId).toBe('rm-fold-1');

    const unresolvable = applySessionCanonPatch(
      [],
      [
        {
          scope: 'character',
          statement: 'ユイは王家の血を引く',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '会話に無い抜粋',
        },
      ],
      'rm-boundary',
      { foldTargetMessages }
    );
    expect(unresolvable[0].evidence[0].messageId).toBe('rm-boundary');
  });

  // NOTE: 設計書 6.3・12.3-24。knownBy / explicitlyUnknownBy は fold で新規推定・更新しない。
  // 既存値は維持され、新規追加項目には付かない。
  it('knownBy / explicitlyUnknownBy はfoldで新規推定・更新されない', () => {
    const existing = [
      {
        canonId: 'can-1',
        scope: 'character',
        statement: '護衛の過去は傭兵だった',
        status: 'foreshadowed',
        baseStatusWithoutEvidence: 'retired',
        epistemicStatus: 'fact',
        knownBy: ['char-b'],
        explicitlyUnknownBy: ['char-c'],
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
          statement: '護衛の過去は傭兵だった',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '告白',
        },
        {
          scope: 'character',
          statement: '新しい設定',
          epistemicStatus: 'fact',
          disclosure: 'revealed',
          evidenceExcerpt: '新事実',
        },
      ],
      'rm-53'
    );
    expect(next[0].knownBy).toEqual(['char-b']);
    expect(next[0].explicitlyUnknownBy).toEqual(['char-c']);
    const added = next.find((item) => item.canonId !== 'can-1')!;
    expect(added).not.toHaveProperty('knownBy');
    expect(added).not.toHaveProperty('explicitlyUnknownBy');
  });
});
