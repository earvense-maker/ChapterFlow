import { describe, expect, it } from 'vitest';
import {
  buildRoleplayUserPrompt,
  ROLEPLAY_VARIABLE_PROMPT_MAX_CHARS,
} from '../../src/server/services/roleplayPromptBuilder';
import {
  checkPromptTokenBudget,
  tokensToReducibleChars,
} from '../../src/server/prompts/promptBudget';
import type {
  Character,
  RoleplayContextSnapshot,
  RoleplayMessage,
} from '../../src/server/types/index';

function snapshot(): RoleplayContextSnapshot {
  const character: Character = {
    characterId: 'char-a',
    name: 'アリス',
    role: 'protagonist',
    description: '17歳。',
    speechStyle: '丁寧語',
  };
  return {
    character,
    otherCharacters: [],
    worldDigest: '',
    customSystemPrompt: '',
    capturedAt: '2026-07-13T00:00:00.000Z',
  };
}

function messages(count: number, content: string): RoleplayMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    messageId: `rm-${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('character' as const),
    content,
    createdAt: '2026-07-13T00:00:00.000Z',
  }));
}

// NOTE: レビュー指摘 P1-3 の回帰。buildTurnPrompt の縮小ループは private なので、
// そこが依存する2つの性質（進捗が出ること・削減量を過小評価しないこと）を直接検証する。
describe('ロールプレイの履歴縮小', () => {
  // 実装と同じ「古い側から削る」規則。4件以上落とす必要があるケースを再現する。
  function dropOldestByChars(list: RoleplayMessage[], reducibleChars: number): RoleplayMessage[] {
    let dropped = 0;
    let index = 0;
    while (index < list.length - 1 && dropped < reducibleChars) {
      dropped += list[index].content.length;
      index += 1;
    }
    return list.slice(Math.max(1, index));
  }

  it('短い発言が多数並んでも、1回ごとに必ず件数が減る', () => {
    let list = messages(12, 'ok.');
    const seen = new Set<number>();
    for (let i = 0; i < 20 && list.length > 1; i += 1) {
      seen.add(list.length);
      const next = dropOldestByChars(list, tokensToReducibleChars(1, list.map((m) => m.content).join('')));
      expect(next.length, '進捗が無いと無限ループになる').toBeLessThan(list.length);
      list = next;
    }
    expect(list.length).toBe(1);
    // 4回以上の縮小を経ている（旧実装の固定3回では届かなかったケース）
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('ASCII 中心の会話でも必要削減量を過小評価しない', () => {
    const ascii = 'This is an ordinary English sentence used in the conversation. '.repeat(40);
    const list = messages(10, ascii);
    const joined = list.map((m) => m.content).join('\n');

    const check = checkPromptTokenBudget({
      systemInstructions: '',
      userPrompt: joined,
      contextWindowTokens: 8_000,
      estimatedMaxOutputTokens: 1_000,
      providerTokens: null,
    });
    expect(check.ok).toBe(false);

    const reducible = tokensToReducibleChars(check.overByTokens, joined);
    // 旧実装の固定係数（over / 2.5）では大幅に足りなかった
    expect(reducible).toBeGreaterThan(Math.ceil(check.overByTokens / 2.5));
    const shrunk = dropOldestByChars(list, reducible);
    expect(shrunk.length).toBeLessThan(list.length);
  });
});

describe('ロールプレイ可変プロンプトの report', () => {
  it('成功時は entries を返し、上限内であることを示す', () => {
    const result = buildRoleplayUserPrompt({
      snapshot: snapshot(),
      scenario: '放課後の教室',
      recentMessages: messages(4, 'こんにちは。'),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chars).toBe(result.prompt.length);
      expect(result.chars).toBeLessThanOrEqual(ROLEPLAY_VARIABLE_PROMPT_MAX_CHARS);
      expect(result.entries.length).toBeGreaterThan(0);
      // report に原文は載せない
      for (const entry of result.entries) {
        expect(Object.keys(entry).sort()).toEqual(
          ['action', 'includedChars', 'originalChars', 'sectionId'].sort()
        );
      }
    }
  });
});
