import { afterEach, describe, expect, it } from 'vitest';
import * as latentCanonService from '../../src/server/services/latentCanonService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import type {
  CanonPatchEntry,
  LatentCanonItem,
  LatentCanonStore,
} from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Canon Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

function latentItem(overrides: Partial<LatentCanonItem> = {}): LatentCanonItem {
  return {
    canonId: 'can-1',
    scope: 'character',
    statement: '護衛の過去は傭兵だった',
    status: 'provisional',
    baseStatusWithoutEvidence: 'provisional',
    epistemicStatus: 'unknown',
    source: 'setup',
    manualLock: false,
    evidence: [],
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

function upsertEntry(overrides: Partial<CanonPatchEntry> = {}): CanonPatchEntry {
  return {
    operation: 'upsert',
    scope: 'character',
    statement: '護衛の過去は傭兵だった',
    epistemicStatus: 'fact',
    disclosure: 'revealed',
    evidenceExcerpt: '護衛は傭兵だったと告白した。',
    ...overrides,
  };
}

const generation = { generationId: 'gen-1', sceneId: 'scene-1' };

describe('latentCanonService 正規化（設計書 12.1）', () => {
  it('欠損ファイルは空ストアとして読める', async () => {
    const projectId = await createTrackedProject();
    const store = await latentCanonService.readLatentCanonStore(projectId);
    expect(store.items).toEqual([]);
    expect(store.pendingConflicts).toEqual([]);
    expect(store.processedGenerationIds).toEqual([]);
    expect(store.latentSeedStatus).toBe('ok');
  });

  it('baseStatusWithoutEvidence欠損をsourceから補正する', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          { ...latentItem(), source: 'setup', baseStatusWithoutEvidence: undefined },
          { ...latentItem({ canonId: 'can-2', source: 'generation' }), baseStatusWithoutEvidence: undefined },
        ],
      },
      'proj-x'
    );
    expect(store.items[0].baseStatusWithoutEvidence).toBe('provisional');
    expect(store.items[1].baseStatusWithoutEvidence).toBe('retired');
  });

  it('revealedはevidenceなしではsource manual以外無効になる', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          { ...latentItem({ canonId: 'can-no-evidence', status: 'revealed', source: 'generation' }) },
        ],
      },
      'proj-x'
    );
    expect(store.items).toHaveLength(0);
  });

  it('未知のenumや空statementを安全に補正する', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          { ...latentItem({ canonId: 'can-bad', scope: 'unknown-scope', statement: '' }) },
          { ...latentItem({ canonId: 'can-ok', scope: 'history' }) },
        ],
      },
      'proj-x'
    );
    expect(store.items.map((item) => item.canonId)).toEqual(['can-ok']);
  });
});

describe('latentCanonService canon patch適用（設計書 6.3・12.3）', () => {
  it('upsertで新規項目を作り、evidenceとprocessed集合を付ける', () => {
    const store = latentCanonService.createEmptyLatentCanonStore('proj-x');
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry()],
      generation
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0].status).toBe('revealed');
    expect(next.items[0].source).toBe('generation');
    expect(next.items[0].baseStatusWithoutEvidence).toBe('retired');
    expect(next.items[0].evidence).toHaveLength(1);
    expect(next.items[0].evidence[0].generationId).toBe('gen-1');
    expect(next.processedGenerationIds).toContain('gen-1');
  });

  it('foreshadowed disclosureはforeshadowedへ昇格する', () => {
    const store = latentCanonService.createEmptyLatentCanonStore('proj-x');
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ disclosure: 'foreshadowed' })],
      generation
    );
    expect(next.items[0].status).toBe('foreshadowed');
  });

  it('既存の潜在設定をID維持でrevealedへ更新する', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      { items: [latentItem()] },
      'proj-x'
    );
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ canonId: 'can-1' })],
      generation
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0].canonId).toBe('can-1');
    expect(next.items[0].status).toBe('revealed');
    expect(next.items[0].evidence).toHaveLength(1);
  });

  it('scope+subject一致+statement包含で既存IDへmergeされる（12.2）', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({ subjectCharacterIds: ['char-1'], statement: '護衛の過去は傭兵だった' }),
        ],
      },
      'proj-x'
    );
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ subjectCharacterIds: ['char-1'], statement: '護衛の過去は傭兵だった（詳細）' })],
      generation
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0].canonId).toBe('can-1');
  });

  it('retireTargetはretired: contradictedになる', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      { items: [latentItem()] },
      'proj-x'
    );
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ operation: 'retire', canonId: 'can-1', retiredReason: 'contradicted' })],
      generation
    );
    expect(next.items[0].status).toBe('retired');
    expect(next.items[0].retiredReason).toBe('contradicted');
    expect(next.items[0].statusBeforeRetired).toBe('provisional');
    expect(next.items[0].retiredByGenerationId).toBe('gen-1');
  });

  it('自動退役はmanual lockとrevealedを保護する（レビュー指摘 P1）', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({ canonId: 'can-locked', manualLock: true }),
          latentItem({
            canonId: 'can-revealed',
            status: 'revealed',
            baseStatusWithoutEvidence: 'retired',
            evidence: [{ kind: 'manual', disclosure: 'revealed', createdAt: '2026-07-02T00:00:00Z' }],
          }),
        ],
      },
      'proj-x'
    );
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [
        upsertEntry({ operation: 'retire', canonId: 'can-locked', retiredReason: 'contradicted' }),
        upsertEntry({ operation: 'retire', canonId: 'can-revealed', retiredReason: 'contradicted' }),
      ],
      generation
    );
    expect(next.items[0].status).toBe('provisional');
    expect(next.items[1].status).toBe('revealed');
  });

  it('採用取消で矛盾退役した項目が元状態へ戻る（レビュー指摘 P1）', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            status: 'retired',
            statusBeforeRetired: 'provisional',
            retiredReason: 'contradicted',
            retiredByGenerationId: 'gen-1',
          }),
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.items[0].status).toBe('provisional');
    expect(next.items[0].retiredReason).toBeUndefined();
    expect(next.items[0].retiredByGenerationId).toBeUndefined();
  });

  it('別のgenerationで退役した項目は取消で戻らない', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            status: 'retired',
            statusBeforeRetired: 'provisional',
            retiredReason: 'contradicted',
            retiredByGenerationId: 'gen-2',
          }),
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.items[0].status).toBe('retired');
  });

  it('activeなprovisional/foreshadowedが40件を超えたら未使用から退役する', () => {
    const items = Array.from({ length: 41 }, (_, index) =>
      latentItem({
        canonId: `can-${index}`,
        statement: `設定${index}`,
        status: index < 40 ? 'provisional' : 'foreshadowed',
        createdAt: `2026-07-02T00:00:${String(index % 60).padStart(2, '0')}Z`,
        updatedAt: `2026-07-02T00:00:${String(index % 60).padStart(2, '0')}Z`,
      })
    );
    const store = latentCanonService.normalizeLatentCanonStore({ items }, 'proj-x');
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ statement: '新しい設定' })],
      generation
    );
    const active = next.items.filter(
      (item) => item.status === 'provisional' || item.status === 'foreshadowed'
    );
    expect(active.length).toBeLessThanOrEqual(40);
    expect(next.items.some((item) => item.status === 'retired' && item.retiredReason === 'unused')).toBe(true);
  });

  it('revealedとmanual lock項目は自動退役しない', () => {
    const items = Array.from({ length: 40 }, (_, index) =>
      latentItem({
        canonId: `can-${index}`,
        statement: `設定${index}`,
        status: index === 0 ? 'revealed' : 'provisional',
        manualLock: index === 1,
        baseStatusWithoutEvidence: index === 0 ? 'retired' : 'provisional',
        evidence: index === 0 ? [{ kind: 'manual', disclosure: 'revealed', createdAt: '2026-07-02T00:00:00Z' }] : [],
      })
    );
    const store = latentCanonService.normalizeLatentCanonStore({ items }, 'proj-x');
    const { store: next } = latentCanonService.applyCanonPatchUnlocked(
      store,
      [upsertEntry({ statement: '新しい設定' })],
      generation
    );
    const can0 = next.items.find((item) => item.canonId === 'can-0');
    const can1 = next.items.find((item) => item.canonId === 'can-1');
    expect(can0?.status).toBe('revealed');
    expect(can1?.status).toBe('provisional');
  });
});

describe('latentCanonService evidence削除と巻き戻し（設計書 6.4・12.3）', () => {
  it('根拠を失った項目はbaseStatusWithoutEvidenceへ戻る', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            status: 'revealed',
            baseStatusWithoutEvidence: 'provisional',
            evidence: [
              { kind: 'generation', disclosure: 'revealed', generationId: 'gen-1', createdAt: '2026-07-02T00:00:00Z' },
            ],
          }),
          latentItem({
            canonId: 'can-new',
            statement: '抽出された新事実',
            status: 'revealed',
            baseStatusWithoutEvidence: 'retired',
            source: 'generation',
            evidence: [
              { kind: 'generation', disclosure: 'revealed', generationId: 'gen-1', createdAt: '2026-07-02T00:00:00Z' },
            ],
          }),
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.items[0].status).toBe('provisional');
    expect(next.items[1].status).toBe('retired');
    expect(next.items[1].retiredReason).toBe('evidence-removed');
    expect(next.processedGenerationIds).not.toContain('gen-1');
  });

  it('他の根拠が残る項目は維持される', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            status: 'revealed',
            evidence: [
              { kind: 'generation', disclosure: 'revealed', generationId: 'gen-1', createdAt: '2026-07-02T00:00:00Z' },
              { kind: 'generation', disclosure: 'revealed', generationId: 'gen-2', createdAt: '2026-07-02T00:00:00Z' },
            ],
          }),
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.items[0].status).toBe('revealed');
    expect(next.items[0].evidence).toHaveLength(1);
  });

  it('manual evidenceが残る項目は採用取消で消えない', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            status: 'revealed',
            source: 'manual',
            evidence: [
              { kind: 'manual', disclosure: 'revealed', createdAt: '2026-07-02T00:00:00Z' },
            ],
          }),
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.items[0].status).toBe('revealed');
  });

  it('未解決conflictは採用取消で取り下げられる', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        pendingConflicts: [
          {
            conflictId: 'conf-1',
            generationId: 'gen-1',
            kind: 'hard-contract',
            summary: '契約と矛盾',
            evidenceExcerpt: '抜粋',
            status: 'pending',
            createdAt: '2026-07-02T00:00:00Z',
          },
        ],
      },
      'proj-x'
    );
    const next = latentCanonService.removeEvidenceForGenerationUnlocked(store, 'gen-1');
    expect(next.pendingConflicts).toHaveLength(0);
  });
});

describe('latentCanonService 編集・退役・ロック（設計書 4.3）', () => {
  it('手動編集はmanualLockになる', () => {
    const store = latentCanonService.normalizeLatentCanonStore({ items: [latentItem()] }, 'proj-x');
    const next = latentCanonService.updateCanonItemUnlocked(store, 'can-1', {
      statement: '編集後の設定',
    });
    expect(next.items[0].manualLock).toBe(true);
    expect(next.items[0].statement).toBe('編集後の設定');
  });

  it('手動退役はstatusBeforeRetiredで復元できる', () => {
    const store = latentCanonService.normalizeLatentCanonStore({ items: [latentItem()] }, 'proj-x');
    const retired = latentCanonService.retireCanonItemUnlocked(store, 'can-1', 'manual');
    expect(retired.items[0].status).toBe('retired');
    const restored = latentCanonService.restoreRetiredCanonItemUnlocked(retired, 'can-1');
    expect(restored.items[0].status).toBe('provisional');
    expect(restored.items[0].statusBeforeRetired).toBeUndefined();
  });

  it('lockは作者操作でのみ解除できる（store上のフラグ操作）', () => {
    const store = latentCanonService.normalizeLatentCanonStore({ items: [latentItem()] }, 'proj-x');
    const locked = latentCanonService.setCanonLockUnlocked(store, 'can-1', true);
    expect(locked.items[0].manualLock).toBe(true);
    const unlocked = latentCanonService.setCanonLockUnlocked(locked, 'can-1', false);
    expect(unlocked.items[0].manualLock).toBe(false);
  });
});

describe('latentCanonService 関連選択（設計書 6.1）', () => {
  it('revealed > manual lock > foreshadowed > provisionalの順で最大12件選ぶ', () => {
    const items: LatentCanonItem[] = [
      latentItem({ canonId: 'can-p', statement: '仮の設定' }),
      latentItem({ canonId: 'can-r', statement: '公開済み設定', status: 'revealed', baseStatusWithoutEvidence: 'retired', evidence: [{ kind: 'manual', disclosure: 'revealed', createdAt: '2026-07-02T00:00:00Z' }] }),
      latentItem({ canonId: 'can-f', statement: '示唆済み設定', status: 'foreshadowed' }),
      latentItem({ canonId: 'can-l', statement: '作者固定の設定', manualLock: true }),
    ];
    const selected = latentCanonService.selectRelatedCanonItems({
      items,
      wish: '',
      characters: [],
    });
    expect(selected[0].canonId).toBe('can-r');
    expect(selected.map((item) => item.canonId)).toContain('can-l');
    expect(selected.map((item) => item.canonId)).toContain('can-f');
  });

  it('視点人物に関連する項目を優先する', () => {
    const items: LatentCanonItem[] = [
      latentItem({ canonId: 'can-other', statement: '無関係な設定', subjectCharacterIds: ['char-b'] }),
      latentItem({ canonId: 'can-view', statement: '視点人物の設定', subjectCharacterIds: ['char-a'] }),
    ];
    const selected = latentCanonService.selectRelatedCanonItems({
      items,
      wish: '',
      viewpointCharacterId: 'char-a',
      characters: [{ characterId: 'char-a', name: 'アキ' }],
    });
    expect(selected[0].canonId).toBe('can-view');
  });

  it('authorUndecidedと語彙が重なる項目を除外できる', () => {
    const items: LatentCanonItem[] = [
      latentItem({ canonId: 'can-overlap', statement: '王の正体はまだ決めない' }),
      latentItem({ canonId: 'can-clear', statement: '港町の描写' }),
    ];
    const filtered = latentCanonService.excludeOverlappingWithAuthorUndecided(items, [
      { text: '王の正体' },
    ]);
    expect(filtered.map((item) => item.canonId)).toEqual(['can-clear']);
  });
});

describe('latentCanonService 競合（設計書 6.3）', () => {
  it('pendingConflictsへ登録・解決できる', () => {
    const store = latentCanonService.createEmptyLatentCanonStore('proj-x');
    const withConflict = latentCanonService.registerConflictsUnlocked(store, [
      {
        generationId: 'gen-1',
        contractId: 'ctr-1',
        kind: 'hard-contract',
        summary: '護衛が裏切る描写と契約が矛盾',
        evidenceExcerpt: '護衛は裏切った。',
      },
    ]);
    expect(withConflict.pendingConflicts).toHaveLength(1);
    const resolved = latentCanonService.resolveConflictUnlocked(
      withConflict,
      withConflict.pendingConflicts[0].conflictId,
      'exception-accepted'
    );
    expect(resolved.pendingConflicts[0].status).toBe('exception-accepted');
    expect(resolved.pendingConflicts[0].resolvedAt).toBeDefined();
  });
});

describe('latentCanonService shielded summary（設計書 7.2・12.5）', () => {
  it('shielded時は未公開本文を返さない', async () => {
    const projectId = await createTrackedProject();
    const store = await latentCanonService.readLatentCanonStore(projectId);
    const withItems = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({ statement: '秘密の設定' }),
          latentItem({
            canonId: 'can-revealed',
            statement: '公開済み設定',
            status: 'revealed',
            baseStatusWithoutEvidence: 'retired',
            evidence: [{ kind: 'manual', disclosure: 'revealed', createdAt: '2026-07-02T00:00:00Z' }],
          }),
        ],
      },
      projectId
    );
    const summary = latentCanonService.buildCanonSummary(withItems, 'shielded');
    expect(summary.hidden.total).toBe(1);
    expect(summary.revealed.map((item) => item.statement)).toEqual(['公開済み設定']);
    expect(JSON.stringify(summary)).not.toContain('秘密の設定');
  });

  it('visible時は未公開本文を含む', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      { items: [latentItem({ statement: '見える設定' })] },
      'proj-x'
    );
    const summary = latentCanonService.buildCanonSummary(store, 'visible');
    expect(summary.items?.[0].statement).toBe('見える設定');
  });

  it('退役項目をopaqueな一覧で返し、本文は含めない（レビュー指摘 P2）', () => {
    const store = latentCanonService.normalizeLatentCanonStore(
      {
        items: [
          latentItem({
            canonId: 'can-retired',
            statement: '退役した秘密の設定',
            status: 'retired',
            retiredReason: 'manual',
            statusBeforeRetired: 'provisional',
          }),
        ],
      },
      'proj-x'
    );
    const summary = latentCanonService.buildCanonSummary(store, 'shielded');
    expect(summary.retired.total).toBe(1);
    expect(summary.retired.items[0].canonId).toBe('can-retired');
    expect(summary.retired.items[0].retiredReason).toBe('manual');
    expect(JSON.stringify(summary)).not.toContain('退役した秘密の設定');
  });
});

describe('latentCanonService revision管理（設計書 5.3・7.2）', () => {
  it('保存のたびにrevisionが進む', async () => {
    const projectId = await createTrackedProject();
    const store = await latentCanonService.readLatentCanonStore(projectId);
    const next = await latentCanonService.saveLatentCanonStoreWithNextRevision(store);
    expect(next.revision).toBe(1);
    const reread = await latentCanonService.readLatentCanonStore(projectId);
    expect(reread.revision).toBe(1);
  });
});
