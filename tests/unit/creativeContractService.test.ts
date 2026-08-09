import { afterEach, describe, expect, it, vi } from 'vitest';
import * as creativeContractService from '../../src/server/services/creativeContractService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { adapterMap } from '../../src/server/adapters/index.js';
import type { CreativeContractItem, Project } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<Project> {
  const project = await projectService.createProject({ title: 'Contract Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
  vi.restoreAllMocks();
});

function item(overrides: Partial<CreativeContractItem> = {}): CreativeContractItem {
  return {
    contractId: 'ctr-test',
    kind: 'promise',
    strength: 'hard',
    text: '護衛は主人公を裏切らない',
    source: 'user',
    status: 'active',
    createdAt: '2026-07-02T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('creativeContractService 正規化と上限（設計書 12.1）', () => {
  it('欠損ファイルは空ストアとして読める', async () => {
    const project = await createTrackedProject();
    const contract = await creativeContractService.readCreativeContractOrEmpty(project.projectId);
    expect(contract.items).toEqual([]);
    expect(contract.exceptions).toEqual([]);
    expect(contract.revision).toBe(0);
  });

  it('hard 8件を超える入力を拒否する', () => {
    const items = Array.from({ length: 9 }, (_, index) =>
      item({ contractId: `ctr-${index}`, text: `約束${index}` })
    );
    expect(() =>
      creativeContractService.validateContractItems(items, { enforceRenderLimit: true })
    ).toThrow(/hard/);
  });

  it('soft 12件を超える入力を拒否する', () => {
    const items = Array.from({ length: 13 }, (_, index) =>
      item({
        contractId: `ctr-${index}`,
        kind: 'preference',
        strength: 'soft',
        text: `好み${index}`,
      })
    );
    expect(() => creativeContractService.validateContractItems(items)).toThrow(/soft/);
  });

  it('1件500文字を超える入力を拒否する', () => {
    expect(() =>
      creativeContractService.validateContractItems([item({ text: 'あ'.repeat(501) })])
    ).toThrow(/500/);
  });

  it('空文字と重複を拒否する', () => {
    expect(() =>
      creativeContractService.validateContractItems([item({ text: '' })])
    ).toThrow(/空/);
    expect(() =>
      creativeContractService.validateContractItems([
        item({ text: '同じ約束' }),
        item({ contractId: 'ctr-2', text: '同じ約束' }),
      ])
    ).toThrow(/重複/);
  });

  it('異なる本文でもcontractIdの重複を拒否する', () => {
    expect(() =>
      creativeContractService.validateContractItems([
        item({ contractId: 'ctr-duplicate', text: '最初の約束' }),
        item({ contractId: 'ctr-duplicate', text: '別の約束' }),
      ])
    ).toThrow(/契約ID/);
  });

  it('ai-suggested は soft にしかならない', () => {
    const [normalized] = creativeContractService.validateContractItems([
      item({ source: 'ai-suggested', strength: 'hard' }),
    ]);
    expect(normalized.strength).toBe('soft');
  });

  it('preference は必ず soft になる', () => {
    const [normalized] = creativeContractService.validateContractItems([
      item({ kind: 'preference', strength: 'hard' }),
    ]);
    expect(normalized.strength).toBe('soft');
  });

  it('hard render 4,000字の集約上限を検査する', () => {
    // 8件×500字（1件上限いっぱい）だと render 後は見出し・項目区切り込みで4,000字を超える
    const items = Array.from({ length: 8 }, (_, index) =>
      item({ contractId: `ctr-${index}`, text: `${index}${'約'.repeat(499)}` })
    );
    expect(() =>
      creativeContractService.validateContractItems(items, { enforceRenderLimit: true })
    ).toThrow(/4,000/);
    // 8件×450字ならrender後も上限内
    const within = Array.from({ length: 8 }, (_, index) =>
      item({ contractId: `ctr-${index}`, text: `${index}${'約'.repeat(449)}` })
    );
    expect(() =>
      creativeContractService.validateContractItems(within, { enforceRenderLimit: true })
    ).not.toThrow();
  });

  it('壊れた保存データを正規化して読める', async () => {
    const project = await createTrackedProject();
    await storage.writeCreativeContract({
      schemaVersion: 1,
      projectId: project.projectId,
      revision: 3,
      items: [
        { ...item(), text: '' },
        { ...item({ contractId: 'ctr-ok', text: '有効な約束' }) },
      ],
      exceptions: [],
      verificationMode: 'fast',
      updatedAt: '2026-07-02T00:00:00Z',
    } as unknown as never);
    const contract = await creativeContractService.readCreativeContractOrEmpty(project.projectId);
    expect(contract.items.map((entry) => entry.text)).toEqual(['有効な約束']);
    expect(contract.verificationMode).toBe('fast');
  });

  it('semantic conflict検出のfingerprintは内容で安定する', () => {
    const candidates = [{ contractIds: ['ctr-a', 'ctr-b'], reason: '両立しない' }];
    const fingerprint = creativeContractService.computeConflictFingerprint(candidates);
    expect(fingerprint).toMatch(/^[0-9a-f]{24}$/);
    // 配列順が変わっても同じfingerprintになる
    const reversed = [{ contractIds: ['ctr-b', 'ctr-a'], reason: '両立しない' }];
    expect(creativeContractService.computeConflictFingerprint(reversed)).toBe(fingerprint);
  });

  it('hard契約が2件未満ではconflict検出のLLMを呼ばない', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const spy = vi.spyOn(adapter, 'generateText');
    const conflicts = await creativeContractService.detectHardContractConflicts({
      project,
      adapter,
      items: [item()],
    });
    expect(conflicts).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('hard契約同士のsemantic conflictを検出する', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: JSON.stringify([
        { contractIds: ['ctr-a', 'ctr-b'], reason: 'Aは最後まで生きるのにBはAを殺す' },
      ]),
      finishReason: 'stop',
      retryable: false,
    });
    const conflicts = await creativeContractService.detectHardContractConflicts({
      project,
      adapter,
      items: [
        item({ contractId: 'ctr-a', text: 'Aは最後まで生きる' }),
        item({ contractId: 'ctr-b', text: '最終章でAは死ぬ' }),
      ],
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].contractIds.sort()).toEqual(['ctr-a', 'ctr-b']);
  });

  it('conflict検出のLLM失敗は保存を妨げない', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockRejectedValue(new Error('api down'));
    const conflicts = await creativeContractService.detectHardContractConflicts({
      project,
      adapter,
      items: [item({ contractId: 'ctr-a' }), item({ contractId: 'ctr-b' })],
    });
    expect(conflicts).toEqual([]);
  });

  it('exceptionの参照整合性を検証する', async () => {
    const project = await createTrackedProject();
    const contract = await creativeContractService.readCreativeContractOrEmpty(project.projectId);
    const withItems: typeof contract = {
      ...contract,
      items: [item()],
      exceptions: [
        {
          exceptionId: 'ex-1',
          contractId: 'ctr-missing',
          generationId: 'gen-1',
          evidenceExcerpt: '抜粋',
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
    };
    await expect(
      creativeContractService.validateContractExceptions(project.projectId, withItems)
    ).rejects.toThrow(/存在しない契約/);

    const episode = {
      episodeId: 'ep-1',
      title: '第1章',
      order: 1,
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
      scenes: [
        {
          sceneId: 'scene-1',
          episodeId: 'ep-1',
          order: 1,
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
          acceptedGenerationId: 'gen-1',
          draftGenerationIds: ['gen-1'],
        },
      ],
    };
    await storage.writeEpisodeRecord(project.projectId, episode as never);
    await storage.appendGenerationLog(project.projectId, {
      generationId: 'gen-1',
      sceneId: 'scene-1',
      episodeId: 'ep-1',
      request: { wish: '', outputLength: 1000, previousContextText: '' },
      responseText: '本文',
      usedPresets: { narration: 'third-close' },
      usedModel: { provider: 'gemini', modelName: 'gemini-test' },
      referencedMemoryIds: [],
      status: 'accepted',
      createdAt: '2026-07-02T00:00:00Z',
      parentGenerationId: null,
    } as never);
    const valid = await creativeContractService.validateContractExceptions(project.projectId, {
      ...withItems,
      exceptions: [
        {
          exceptionId: 'ex-1',
          contractId: 'ctr-test',
          generationId: 'gen-1',
          evidenceExcerpt: '抜粋',
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
    });
    expect(valid).toBeUndefined();
  });
});
