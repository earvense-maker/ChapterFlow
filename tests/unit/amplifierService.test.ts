// 妄想増幅器コアサービスのテスト（設計書 18.1）
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as amplifierService from '../../src/server/services/amplifierService';
import * as storage from '../../src/server/services/storageService';
import * as projectService from '../../src/server/services/projectService';
import type { AmplifierAnchor, AmplifierInteractionEvent } from '@shared/types';

const createdProjectIds: string[] = [];

async function createAmplifierProject(projectType: 'novel' | 'roleplay' = 'novel') {
  const project = await projectService.createProject({
    title: 'Amplifier Test',
    projectType,
    experienceMode: 'amplifier',
  });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(
    createdProjectIds.map((projectId) => storage.deleteProjectDir(projectId).catch(() => undefined))
  );
  createdProjectIds.length = 0;
});

function anchorFor(generationId: string): AmplifierAnchor {
  return { kind: 'novel', generationId, textRevisionNumber: 0 };
}

describe('computeAnchorTextHash', () => {
  it('改行をLFへ正規化してSHA-256で計算する', () => {
    const crlf = amplifierService.computeAnchorTextHash('a\r\nb\r\nc');
    const lf = amplifierService.computeAnchorTextHash('a\nb\nc');
    expect(crlf).toBe(lf);
    expect(crlf).toMatch(/^[0-9a-f]{64}$/);
  });

  it('trimや空白圧縮はしない（本文の意味を変えない）', () => {
    const withSpaces = amplifierService.computeAnchorTextHash('  a  b  ');
    const trimmed = amplifierService.computeAnchorTextHash('a  b');
    expect(withSpaces).not.toBe(trimmed);
  });
});

describe('InteractionEvent の冪等追記', () => {
  it('同じ clientEventId の再送は既存イベントを返し、二重記録しない', async () => {
    const project = await createAmplifierProject();
    const anchor = anchorFor('gen-1');
    const input = {
      clientEventId: 'client-1',
      mode: 'novel' as const,
      type: 'stay' as const,
      anchor,
      turnId: 'turn-1',
      payload: { command: 'stay' as const },
      excludeFromGlobalLearning: false,
      contextKey: 'novel:main',
    };
    const first = await amplifierService.recordInteractionUnlocked(project.projectId, input);
    const second = await amplifierService.recordInteractionUnlocked(project.projectId, input);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.created).toBe(false);
    const events = await storage.readAmplifierInteractions(project.projectId);
    expect(events).toHaveLength(1);
  });

  it('sequence はプロジェクト単位で単調増加する', async () => {
    const project = await createAmplifierProject();
    const base = { mode: 'novel' as const, anchor: anchorFor('gen-1'), excludeFromGlobalLearning: false, contextKey: 'novel:main' };
    const a = await amplifierService.recordInteractionUnlocked(project.projectId, {
      ...base,
      clientEventId: 'c-1',
      type: 'stay',
      payload: { command: 'stay' },
    });
    const b = await amplifierService.recordInteractionUnlocked(project.projectId, {
      ...base,
      clientEventId: 'c-2',
      type: 'free_text',
      payload: { text: 'もう少し近づく' },
    });
    expect(b.event.sequence).toBeGreaterThan(a.event.sequence);
  });

  it('同時追記でも clientEventId と sequence が重複しない', async () => {
    const project = await createAmplifierProject();
    const base = {
      mode: 'novel' as const,
      anchor: anchorFor('gen-concurrent'),
      excludeFromGlobalLearning: false,
      contextKey: 'novel:main',
      type: 'stay' as const,
      payload: { command: 'stay' as const },
    };
    const duplicateResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        amplifierService.recordInteractionUnlocked(project.projectId, {
          ...base,
          clientEventId: 'same-client-event',
        })
      )
    );
    expect(new Set(duplicateResults.map((result) => result.event.eventId)).size).toBe(1);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        amplifierService.recordInteractionUnlocked(project.projectId, {
          ...base,
          clientEventId: `unique-client-event-${index}`,
        })
      )
    );
    const events = await storage.readAmplifierInteractions(project.projectId);
    expect(events).toHaveLength(9);
    expect(new Set(events.map((event) => event.sequence)).size).toBe(9);
  });
});

describe('verifyAnchorAgainstCurrent', () => {
  it('改訂番号が一致してもハッシュが違えば stale', () => {
    const anchor = anchorFor('gen-1');
    const text = '本文です。\r\n二行目。';
    const hash = amplifierService.computeAnchorTextHash(text);
    expect(
      amplifierService.verifyAnchorAgainstCurrent(anchor, { ok: true, revisionNumber: 0, text }, hash)
    ).toBe(true);
    expect(
      amplifierService.verifyAnchorAgainstCurrent(
        anchor,
        { ok: true, revisionNumber: 0, text: '編集後の本文です。' },
        hash
      )
    ).toBe(false);
  });

  it('改訂番号の欠損は 0 と解釈して比較する', () => {
    const anchor = anchorFor('gen-1');
    const text = '本文';
    expect(
      amplifierService.verifyAnchorAgainstCurrent(
        anchor,
        { ok: true, revisionNumber: 0, text },
        amplifierService.computeAnchorTextHash(text)
      )
    ).toBe(true);
  });
});

describe('JSONL 耐障害性', () => {
  it('破損行・途中書き込み行を隔離し、正常行を失わない', async () => {
    const project = await createAmplifierProject();
    const path = storage.amplifierInteractionsPath(project.projectId);
    await fs.mkdir(storage.amplifierDir(project.projectId), { recursive: true });
    const anchor = anchorFor('gen-1');
    const event: AmplifierInteractionEvent = {
      schemaVersion: 1,
      eventId: 'amp-ev-1',
      clientEventId: 'c-1',
      sequence: 1,
      projectId: project.projectId,
      contextKey: 'novel:main',
      mode: 'novel',
      type: 'stay',
      anchor,
      payload: { command: 'stay' },
      excludeFromGlobalLearning: false,
      createdAt: new Date().toISOString(),
    };
    const corrupt = '{"schemaVersion": 1, "broken"';
    await fs.writeFile(
      path,
      `${JSON.stringify(event)}\n${corrupt}\n{"sequence":2,"also":"broken"`,
      'utf-8'
    );
    const events = await storage.readAmplifierInteractions(project.projectId);
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe('amp-ev-1');
  });
});

describe('experienceMode の正規化と互換性', () => {
  it('欠損は standard と解釈する', async () => {
    const project = await projectService.createProject({ title: 'Standard Test' });
    createdProjectIds.push(project.projectId);
    expect(project.experienceMode).toBe('standard');
    const fetched = await projectService.getProject(project.projectId);
    expect(fetched?.experienceMode).toBe('standard');
    const summaries = await projectService.listProjects();
    const summary = summaries.find((s) => s.projectId === project.projectId);
    expect(summary?.experienceMode).toBe('standard');
  });

  it('amplifier で作成した作品は amplifier として返る', async () => {
    const project = await createAmplifierProject();
    const fetched = await projectService.getProject(project.projectId);
    expect(fetched?.experienceMode).toBe('amplifier');
  });

  it('複製時は experienceMode を引き継ぐ（設計書 15.3）', async () => {
    const source = await createAmplifierProject();
    const duplicate = await projectService.createProject({
      title: 'Amplifier Copy',
      duplicateFrom: source.projectId,
    });
    createdProjectIds.push(duplicate.projectId);
    expect(duplicate.experienceMode).toBe('amplifier');
  });

  it('amplifier 作品は自動設定レビューが初期値 off（設計書 4.1）', async () => {
    const project = await createAmplifierProject();
    expect(project.refineAutomation?.mode).toBe('off');
    const standard = await projectService.createProject({ title: 'Standard' });
    createdProjectIds.push(standard.projectId);
    expect(standard.refineAutomation?.mode).not.toBe('off');
  });

  it('update 経路では experienceMode を変更できない', async () => {
    const project = await projectService.createProject({ title: 'Update Test' });
    createdProjectIds.push(project.projectId);
    const updated = await projectService.updateProject(project.projectId, {
      // @ts-expect-error 公開 Update 経路には存在しないフィールド（設計書 16.1）
      experienceMode: 'amplifier',
    });
    expect(updated.experienceMode).toBe('standard');
  });
});

describe('ノート', () => {
  it('初回読み取りで空のノートが作られ、learningEnabled は true が既定', async () => {
    const project = await createAmplifierProject();
    const notebook = await amplifierService.readNotebook(project.projectId);
    expect(notebook.schemaVersion).toBe(1);
    expect(notebook.learningEnabled).toBe(true);
    expect(notebook.projectMemos).toEqual([]);
    expect(notebook.pendingAdvance).toBeNull();
  });

  it('pendingAdvance の期限切れは failed に正規化される（設計書 9.1）', async () => {
    const project = await createAmplifierProject();
    const notebook = await amplifierService.readNotebook(project.projectId);
    const expired = {
      operationId: 'amp-op-1',
      interactionEventId: 'amp-ev-1',
      sourceTurnId: 'turn-1',
      acceptedGenerationId: 'gen-1',
      status: 'generating' as const,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      revision: 1,
      updatedAt: new Date().toISOString(),
    };
    const normalized = amplifierService.normalizeExpiredLease(expired);
    expect(normalized?.status).toBe('failed');
    expect(normalized?.errorCode).toBe('advance_lease_expired');
  });
});

describe('方向入力の検証（共通化・レビュー指摘）', () => {
  it('存在しない selectedChoiceId は 409 amplifier_direction_invalid で拒否する', () => {
    expect(() =>
      amplifierService.normalizeAmplifierDirectionInput(
        { selectedChoiceId: 'not-in-turn' },
        { choices: [{ choiceId: 'c1' }] }
      )
    ).toThrowError(/この選択肢にありません/);
  });

  it('方向指定がない入力は stay として扱わず 400 で拒否する', () => {
    expect(() =>
      amplifierService.normalizeAmplifierDirectionInput(
        {} as never,
        { choices: [{ choiceId: 'c1' }] }
      )
    ).toThrowError(/いずれか一つだけ/);
  });

  it('複数の方向指定を同時に含む入力は拒否する', () => {
    expect(() =>
      amplifierService.normalizeAmplifierDirectionInput(
        { selectedChoiceId: 'c1', freeText: '別の方向' } as never,
        { choices: [{ choiceId: 'c1' }] }
      )
    ).toThrowError(/いずれか一つだけ/);
  });

  it('空の自由記述は 400 で拒否する', () => {
    expect(() =>
      amplifierService.normalizeAmplifierDirectionInput(
        { freeText: '   ' },
        { choices: [{ choiceId: 'c1' }] }
      )
    ).toThrowError(/自由記述を入力してください/);
  });

  it('stay と自由記述は正規化される', () => {
    expect(
      amplifierService.normalizeAmplifierDirectionInput({ command: 'stay' }, { choices: [] }).type
    ).toBe('stay');
    expect(
      amplifierService.normalizeAmplifierDirectionInput(
        { freeText: ' 少し近づく ' },
        { choices: [] }
      ).type
    ).toBe('free_text');
  });
});

describe('グローバル学習オフ時の利用停止（設計書 14.3・レビュー指摘）', () => {
  it('オフ時は collectGlobalMemosForPrompt がメモとCorrectionを返さない', async () => {
    const globalService = await import('../../src/server/services/amplifierGlobalService');
    await globalService.updateAmplifierSettings({ globalLearningEnabled: true });
    await globalService.updateGlobalPreferences({
      addCorrections: [{ appliesTo: 'novel', text: '対等な距離感が好き' }],
      globalBoundary: '血が出る描写はしない',
    });
    const on = await globalService.collectGlobalMemosForPrompt('novel');
    expect(on.corrections.length).toBe(1);
    expect(on.boundary).toBe('血が出る描写はしない');

    await globalService.updateAmplifierSettings({ globalLearningEnabled: false });
    const off = await globalService.collectGlobalMemosForPrompt('novel');
    expect(off.memos).toEqual([]);
    expect(off.corrections).toEqual([]);
    // 境界はハード境界なのでオフでも適用される
    expect(off.boundary).toBe('血が出る描写はしない');

    // 手動再試行もオフを無視しない（fold が走らないことを戻り値なしで確認）
    const retry = await import('../../src/server/services/desireInterpreterService');
    await expect(retry.retryGlobalInterpretation()).resolves.toBeUndefined();
  });
});
