import { describe, expect, it } from 'vitest';
import {
  applySetupDraftPatch,
  createEmptySetupDraft,
  normalizeSetupDraft,
} from '../../src/server/services/setupDraftPatchService';
import type { SetupDraft, SetupLock } from '../../src/server/types/index';

const now = '2026-07-04T12:00:00.000Z';

describe('setupDraftPatchService', () => {
  it('adds normalized patch items and avoids duplicates', () => {
    const draft = createEmptySetupDraft();

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: {
        confirmedAdd: [{ text: '強気なヒロイン', source: 'user' }, { text: '強気なヒロイン', source: 'user' }],
        candidatesAdd: [
          {
            title: '女岡っ引き × 気弱な絵師',
            summary: '町の揉め事に首を突っ込むヒロインと、事件現場を描く絵師。',
          },
        ],
        worldAdd: ['江戸時代風の町', '江戸時代風の町'],
      },
    });

    expect(updated.confirmed).toHaveLength(1);
    expect(updated.confirmed[0]).toMatchObject({
      text: '強気なヒロイン',
      source: 'user',
      status: 'active',
    });
    expect(updated.candidates).toHaveLength(1);
    expect(updated.world).toEqual(['江戸時代風の町']);
  });

  it('does not archive locked items', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'fact-locked',
          text: '弱気な主人公',
          source: 'user',
          status: 'active',
          locked: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const locks: SetupLock[] = [
      {
        lockId: 'lock-1',
        path: 'fact-locked',
        reason: 'user_locked',
        createdAt: now,
      },
    ];

    const updated = applySetupDraftPatch({
      draft,
      locks,
      now,
      patch: {
        archiveIds: ['fact-locked'],
      },
    });

    expect(updated.confirmed[0].status).toBe('active');
  });

  it('does not update characters protected by a setup lock', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      characters: [
        {
          id: 'char-locked',
          role: 'protagonist',
          name: '',
          label: '手動の人物',
          description: 'ユーザーが直した説明',
          source: 'manual',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [
        {
          lockId: 'lock-char',
          path: 'char-locked',
          reason: 'manual_edit',
          createdAt: now,
        },
      ],
      now,
      patch: {
        charactersUpdate: [{ id: 'char-locked', description: 'LLMが変えた説明' }],
      },
    });

    expect(updated.characters[0].description).toBe('ユーザーが直した説明');
  });

  it('does not add strings to a locked draft section', () => {
    const updated = applySetupDraftPatch({
      draft: {
        ...createEmptySetupDraft(),
        world: ['手動の世界観'],
      },
      locks: [
        {
          lockId: 'lock-world',
          path: 'draft.world',
          reason: 'manual_edit',
          createdAt: now,
        },
      ],
      now,
      patch: {
        worldAdd: ['LLMが追加した世界観'],
      },
    });

    expect(updated.world).toEqual(['手動の世界観']);
  });

  it('does not treat a section lock as a substring match for item ids', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'world',
          text: 'worldというIDの項目',
          source: 'manual',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [
        {
          lockId: 'lock-world-section',
          path: 'draft.world',
          reason: 'manual_edit',
          createdAt: now,
        },
      ],
      now,
      patch: {
        archiveIds: ['world'],
      },
    });

    expect(updated.confirmed[0].status).toBe('archived');
  });

  it('limits active candidates and archives extras', () => {
    const updated = applySetupDraftPatch({
      draft: createEmptySetupDraft(),
      locks: [],
      now,
      patch: {
        candidatesAdd: Array.from({ length: 8 }, (_, index) => ({
          title: `候補${index + 1}`,
          summary: `説明${index + 1}`,
        })),
      },
    });

    expect(updated.candidates.filter((candidate) => candidate.status === 'active')).toHaveLength(6);
    expect(updated.candidates.filter((candidate) => candidate.status === 'archived')).toHaveLength(2);
  });

  it('does not treat empty candidate summaries as duplicates', () => {
    const updated = applySetupDraftPatch({
      draft: createEmptySetupDraft(),
      locks: [],
      now,
      patch: {
        candidatesAdd: [
          { title: '候補A', summary: '' },
          { title: '候補B', summary: '' },
        ],
      },
    });

    expect(updated.candidates.map((candidate) => candidate.title)).toEqual(['候補A', '候補B']);
  });

  it('ignores ids provided by LLM patch additions and assigns new ones', () => {
    const draft = createEmptySetupDraft();
    draft.confirmed = [
      {
        id: 'existing-fact',
        text: '既存項目',
        source: 'manual',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    ];

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: {
        confirmedAdd: [{ id: 'existing-fact', text: '新しい項目', source: 'user' }],
      },
    });

    expect(updated.confirmed).toHaveLength(2);
    expect(updated.confirmed[1].id).not.toBe('existing-fact');
    expect(updated.confirmed[1].text).toBe('新しい項目');
  });

  it('renormalizes duplicate and invalid ids when normalizing a draft', () => {
    const draft = normalizeSetupDraft({
      confirmed: [
        { id: 'dup', text: 'A' },
        { id: 'dup', text: 'B' },
        { id: 'draft.world', text: 'C' },
        { id: '', text: 'D' },
      ],
    });

    const ids = draft.confirmed.map((item) => item.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain('draft.world');
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('downgrades LLM confirmedAdd without source user to undecided', () => {
    const draft = createEmptySetupDraft();

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: {
        confirmedAdd: [
          { text: 'ユーザーが言った', source: 'user' },
          { text: 'LLMが勝手に決めた', source: 'llm' },
          { text: 'ソースなし' },
        ],
      },
    });

    expect(updated.confirmed).toHaveLength(1);
    expect(updated.confirmed[0].text).toBe('ユーザーが言った');
    expect(updated.undecided).toHaveLength(2);
    expect(updated.undecided[0].reason).toBe('LLM提案のため未確定として保留');
  });

  it('normalizes malformed draft values to an empty safe shape', () => {
    const draft = normalizeSetupDraft({
      confirmed: [{ text: '' }, { text: '確定事項' }],
      candidates: 'not-array',
      relationshipSeeds: ['関係', '関係'],
    });

    expect(draft.confirmed.map((item) => item.text)).toEqual(['確定事項']);
    expect(draft.candidates).toEqual([]);
    expect(draft.relationshipSeeds).toEqual(['関係']);
  });

  it('migrates legacy character fields and locked field names', () => {
    const draft = normalizeSetupDraft({
      characters: [
        {
          id: 'char-old',
          role: 'protagonist',
          name: 'アリス',
          label: '主人公',
          description: '旧形式',
          want: '自由になりたい',
          fear: '忘れられること',
          secret: '実は王女',
          lockedFields: ['want', 'secret'],
          source: 'manual',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    expect(draft.characters[0]).toMatchObject({
      traits: [
        { label: '望み', text: '自由になりたい' },
        { label: '恐れ', text: '忘れられること' },
      ],
      secrets: '実は王女',
      lockedFields: ['traits', 'secrets'],
    });
    expect(draft.characters[0]).not.toHaveProperty('want');
    expect(draft.characters[0]).not.toHaveProperty('secret');
  });

  it('replaces and clears traits/secrets through character updates', () => {
    const draft = normalizeSetupDraft({
      characters: [
        {
          id: 'char-a',
          role: 'protagonist',
          name: 'アリス',
          label: '主人公',
          description: '人物',
          traits: [{ label: '癖', text: '緊張すると笑う' }],
          secrets: '実は王女',
          source: 'manual',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const replaced = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: {
        charactersUpdate: [
          {
            id: 'char-a',
            traits: [{ label: 'こだわり', text: '紅茶は熱いうちに飲む' }],
            secrets: '',
          },
        ],
      },
    });
    expect(replaced.characters[0].traits).toEqual([
      { label: 'こだわり', text: '紅茶は熱いうちに飲む' },
    ]);
    expect(replaced.characters[0].secrets).toBeUndefined();

    const cleared = applySetupDraftPatch({
      draft: replaced,
      locks: [],
      now,
      patch: { charactersUpdate: [{ id: 'char-a', traits: [] }] },
    });
    expect(cleared.characters[0].traits).toBeUndefined();
  });

  it('merges userPersonaUpdate field by field and clears fields sent empty', () => {
    const added = applySetupDraftPatch({
      draft: createEmptySetupDraft(),
      locks: [],
      now,
      patch: {
        userPersonaUpdate: { name: '結衣', relationship: '幼馴染' },
      },
    });
    expect(added.userPersona).toEqual({ name: '結衣', relationship: '幼馴染' });

    // NOTE: 触れなかった項目は維持し、指定した項目だけ更新する。
    const merged = applySetupDraftPatch({
      draft: added,
      locks: [],
      now,
      patch: { userPersonaUpdate: { preferredAddress: '結衣' } },
    });
    expect(merged.userPersona).toEqual({
      name: '結衣',
      relationship: '幼馴染',
      preferredAddress: '結衣',
    });

    // NOTE: 空文字はその項目の削除。全部消えたらペルソナ自体を落とす。
    const cleared = applySetupDraftPatch({
      draft: merged,
      locks: [],
      now,
      patch: {
        userPersonaUpdate: { name: '', relationship: '', preferredAddress: '' },
      },
    });
    expect(cleared.userPersona).toBeUndefined();
  });

  it('ignores userPersonaUpdate while the persona is locked', () => {
    const base = applySetupDraftPatch({
      draft: createEmptySetupDraft(),
      locks: [],
      now,
      patch: { userPersonaUpdate: { name: '結衣' } },
    });
    const locks: SetupLock[] = [
      {
        lockId: 'lock-persona',
        path: 'draft.userPersona',
        reason: 'manual_edit',
        createdAt: now,
      },
    ];

    const updated = applySetupDraftPatch({
      draft: base,
      locks,
      now,
      patch: { userPersonaUpdate: { name: 'モデルが上書きした名前' } },
    });
    expect(updated.userPersona).toEqual({ name: '結衣' });
  });

  it('overwrites a confirmed item by id with the full replacement text', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'fact-age',
          text: '主人公は28歳',
          source: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: { confirmedUpdate: [{ id: 'fact-age', text: '主人公は25歳' }] },
    });

    expect(updated.confirmed).toHaveLength(1);
    expect(updated.confirmed[0]).toMatchObject({
      id: 'fact-age',
      text: '主人公は25歳',
      source: 'user',
      status: 'active',
    });
    expect(updated.confirmed[0].updatedAt).toBe(now);
  });

  it('does not overwrite confirmed items that are locked or unknown', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'fact-locked',
          text: '変更禁止の項目',
          source: 'user',
          status: 'active',
          locked: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const locks: SetupLock[] = [
      {
        lockId: 'lock-fact',
        path: 'fact-other',
        reason: 'manual_edit',
        createdAt: now,
      },
    ];

    const updated = applySetupDraftPatch({
      draft,
      locks,
      now,
      patch: {
        confirmedUpdate: [
          { id: 'fact-locked', text: 'lockedは変更されない' },
          { id: 'fact-missing', text: '存在しないIDは無視' },
          { id: 'fact-other', text: 'セッションロック中のIDも無視' },
        ],
      },
    });

    expect(updated.confirmed[0].text).toBe('変更禁止の項目');
  });

  it('updates candidate and undecided items by id using only provided fields', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      candidates: [
        {
          id: 'cand-1',
          title: '古い候補名',
          summary: '古い説明',
          source: 'llm',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
      undecided: [
        {
          id: 'und-1',
          text: 'まだ決めていない',
          reason: '理由A',
          source: 'llm',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: {
        candidatesUpdate: [{ id: 'cand-1', summary: '新しい説明' }],
        undecidedUpdate: [{ id: 'und-1', text: '決め直した内容', reason: '理由B' }],
      },
    });

    // NOTE: title は送らなかったので維持される。
    expect(updated.candidates[0]).toMatchObject({ title: '古い候補名', summary: '新しい説明' });
    expect(updated.undecided[0]).toMatchObject({ text: '決め直した内容', reason: '理由B' });
  });

  it('replaces a world list item when the draft text matches exactly', () => {
    const updated = applySetupDraftPatch({
      draft: {
        ...createEmptySetupDraft(),
        world: ['江戸時代風の町', '長崎の港町'],
        tone: ['静かな語り'],
      },
      locks: [],
      now,
      patch: {
        worldReplace: [{ from: '江戸時代風の町', to: '近未来の東京' }],
        toneReplace: [{ from: '静かな語り', to: 'テンポの速い語り' }],
      },
    });

    expect(updated.world).toEqual(['近未来の東京', '長崎の港町']);
    expect(updated.tone).toEqual(['テンポの速い語り']);
  });

  it('ignores replaces whose from does not match and dedups the replacement', () => {
    const updated = applySetupDraftPatch({
      draft: {
        ...createEmptySetupDraft(),
        world: ['江戸', '長崎'],
      },
      locks: [],
      now,
      patch: {
        worldReplace: [
          { from: '存在しない文言', to: '無視される' },
          { from: '長崎', to: '江戸' },
        ],
      },
    });

    expect(updated.world).toEqual(['江戸']);
  });

  it('does not replace strings in a locked draft section', () => {
    const updated = applySetupDraftPatch({
      draft: {
        ...createEmptySetupDraft(),
        world: ['手動の世界観'],
      },
      locks: [
        {
          lockId: 'lock-world',
          path: 'draft.world',
          reason: 'manual_edit',
          createdAt: now,
        },
      ],
      now,
      patch: {
        worldReplace: [{ from: '手動の世界観', to: 'LLMが差し替えようとした世界観' }],
      },
    });

    expect(updated.world).toEqual(['手動の世界観']);
  });

  it('removes a string list item when the replacement to is empty', () => {
    const updated = applySetupDraftPatch({
      draft: {
        ...createEmptySetupDraft(),
        world: ['江戸時代風の町', '長崎の港町'],
        ng: ['残酷な描写'],
      },
      locks: [],
      now,
      patch: {
        worldReplace: [{ from: '江戸時代風の町', to: '' }],
        ngReplace: [{ from: '残酷な描写', to: '' }],
      },
    });

    expect(updated.world).toEqual(['長崎の港町']);
    expect(updated.ng).toEqual([]);
  });

  it('merges an updated confirmed item into an existing active sibling', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'fact-younger',
          text: '主人公は25歳',
          source: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'fact-older',
          text: '主人公は28歳',
          source: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: { confirmedUpdate: [{ id: 'fact-older', text: '主人公は25歳' }] },
    });

    // NOTE: 更新対象（fact-older）を残し、同文言の兄弟（fact-younger）を畳む。
    expect(updated.confirmed).toHaveLength(1);
    expect(updated.confirmed[0]).toMatchObject({ id: 'fact-older', text: '主人公は25歳' });
  });

  it('refuses to update a confirmed item whose target text collides with a locked sibling', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      confirmed: [
        {
          id: 'fact-locked-sibling',
          text: '主人公は25歳',
          source: 'user',
          status: 'active',
          locked: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'fact-older',
          text: '主人公は28歳',
          source: 'user',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: { confirmedUpdate: [{ id: 'fact-older', text: '主人公は25歳' }] },
    });

    // NOTE: locked の兄弟を消せないため、重複を作らずに更新を諦める。
    expect(updated.confirmed).toHaveLength(2);
    expect(updated.confirmed.find((item) => item.id === 'fact-older')?.text).toBe('主人公は28歳');
  });

  it('merges an updated candidate into an existing active sibling on title match', () => {
    const draft: SetupDraft = {
      ...createEmptySetupDraft(),
      candidates: [
        {
          id: 'cand-a',
          title: 'A案',
          summary: '説明A',
          source: 'llm',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'cand-b',
          title: 'B案',
          summary: '説明B',
          source: 'llm',
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const updated = applySetupDraftPatch({
      draft,
      locks: [],
      now,
      patch: { candidatesUpdate: [{ id: 'cand-b', title: 'A案' }] },
    });

    expect(updated.candidates).toHaveLength(1);
    expect(updated.candidates[0]).toMatchObject({ id: 'cand-b', title: 'A案', summary: '説明B' });
  });
});
