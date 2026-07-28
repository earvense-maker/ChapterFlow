import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURRENT_BASE_INSTRUCTION_VERSION,
  defaultNovelCreativeInstruction,
  hashBaseInstruction,
  identifyBaseInstruction,
  immutableNovelContract,
  KNOWN_BASE_INSTRUCTION_HASHES,
  normalizeBaseInstructionForHash,
} from '../../src/server/prompts/baseInstruction';
import { LEGACY_BASE_INSTRUCTIONS } from '../../src/server/prompts/legacyBaseInstructions';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/legacyBaseInstructions');

// NOTE: 設計書 5.4 の要求。既知hashは「Git上に実在する改訂版」から作り、推測した文面を
// 登録しない。fixture は git show で機械的に切り出した原文なので、これと出荷側の定数が
// 一致し続けることを検証すれば、hash が原文から乖離した状態を検出できる。
describe('旧デフォルト基本プロンプトの履歴', () => {
  it('fixture の原文と出荷側の定数が一致する', async () => {
    for (const entry of LEGACY_BASE_INSTRUCTIONS) {
      const fixture = await fs.readFile(
        path.join(FIXTURE_DIR, `v${entry.version}.txt`),
        'utf8'
      );
      expect(normalizeBaseInstructionForHash(fixture)).toBe(
        normalizeBaseInstructionForHash(entry.text)
      );
    }
  });

  it('fixture から同じ hash を再現できる', async () => {
    for (const entry of LEGACY_BASE_INSTRUCTIONS) {
      const fixture = await fs.readFile(
        path.join(FIXTURE_DIR, `v${entry.version}.txt`),
        'utf8'
      );
      expect(KNOWN_BASE_INSTRUCTION_HASHES.get(hashBaseInstruction(fixture))).toBe(entry.version);
    }
  });

  it('バージョンが重複せず、現行版より小さい', () => {
    const versions = LEGACY_BASE_INSTRUCTIONS.map((entry) => entry.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const version of versions) {
      expect(version).toBeLessThan(CURRENT_BASE_INSTRUCTION_VERSION);
    }
  });

  it('hash 衝突が無い', () => {
    expect(KNOWN_BASE_INSTRUCTION_HASHES.size).toBe(LEGACY_BASE_INSTRUCTIONS.length);
  });
});

describe('identifyBaseInstruction', () => {
  it('現行の既定文を default と判定する', () => {
    const result = identifyBaseInstruction(defaultNovelCreativeInstruction());
    expect(result.source).toBe('default');
    expect(result.version).toBe(CURRENT_BASE_INSTRUCTION_VERSION);
  });

  it('全ての旧版を default と判定する', () => {
    for (const entry of LEGACY_BASE_INSTRUCTIONS) {
      expect(identifyBaseInstruction(entry.text)).toEqual({
        source: 'default',
        version: entry.version,
      });
    }
  });

  it('改行コードと前後空白の違いは吸収する', () => {
    const crlf = LEGACY_BASE_INSTRUCTIONS[0].text.replace(/\n/g, '\r\n');
    expect(identifyBaseInstruction(`\n  ${crlf}  \n`).source).toBe('default');
  });

  // NOTE: 判定できない・未知版は必ず custom へ倒す。default と誤判定すると
  // 利用者が書いた本文を黙って捨てることになる。
  it('1文字でも編集された旧版は custom として保護する', () => {
    for (const entry of LEGACY_BASE_INSTRUCTIONS) {
      expect(identifyBaseInstruction(`${entry.text}。`).source).toBe('custom');
      expect(identifyBaseInstruction(entry.text.slice(0, -1)).source).toBe('custom');
    }
  });

  it('未知の独自プロンプトは custom として扱う', () => {
    const result = identifyBaseInstruction('まったく独自の基本プロンプト。');
    expect(result.source).toBe('custom');
    expect(result.version).toBeUndefined();
  });

  it('不変契約そのものを既定文と取り違えない', () => {
    expect(identifyBaseInstruction(immutableNovelContract()).source).toBe('custom');
  });
});
