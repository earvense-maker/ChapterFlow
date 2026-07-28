import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- 生成スクリプトは .mjs のまま共有する（他の scripts/ と同じ扱い）
import { collectInventory, renderInventoryMarkdown, workspaceRoot } from '../../scripts/web-portability.mjs';

const inventoryDocPath = path.join(workspaceRoot, 'docs', 'design', '公開Web版_移行インベントリ.md');

describe('公開Web版の可搬性ガード', () => {
  // NOTE: 設計書 Phase 0 の完了条件「Web版の空の起動系とストレージ契約を追加しても
  // Electron 配布物と保存先が変わらない」を、コードの側から守る。apps/web が
  // Electron 専用モジュールを1つでも掴んだ時点で、境界は壊れている。
  it('apps/web が Electron 専用モジュールを参照していない', async () => {
    const inventory = await collectInventory();
    expect(inventory.webAppViolations).toEqual([]);
  });

  it('契約へ移行済みのサービスが storageService を直接importし直していない', async () => {
    const inventory = await collectInventory();
    const migrated = [
      'src/server/services/projectService.ts',
      'src/server/services/stateService.ts',
      'src/server/services/memoryService.ts',
    ];
    for (const file of migrated) {
      expect(inventory.storageDataImporters).not.toContain(file);
      expect(inventory.storagePathImporters.map((entry: { file: string }) => entry.file)).not.toContain(file);
    }
  });

  // NOTE: 未移行の呼び出し元が増えても失敗はさせない（Phase 2 まで残るのが前提）。
  // ただしインベントリが古いまま放置されると計画の判断材料にならないので、
  // 生成物が現在のソースと一致していることだけは強制する。
  it('インベントリのドキュメントが最新である', async () => {
    const inventory = await collectInventory();
    const expected = renderInventoryMarkdown(inventory);
    const actual = await readFile(inventoryDocPath, 'utf-8');
    expect(normalizeNewlines(actual)).toBe(normalizeNewlines(expected));
  });

  it('契約アダプタだけが storage 配下から storageService を呼ぶ', async () => {
    const inventory = await collectInventory();
    expect(inventory.contractAdapters).toEqual(['src/server/storage/fileProjectStorage.ts']);
  });
});

function normalizeNewlines(value: string): string {
  return value.replaceAll('\r\n', '\n');
}
