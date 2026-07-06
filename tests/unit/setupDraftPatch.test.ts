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
});
