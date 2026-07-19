import { describe, expect, it } from 'vitest';
import {
  ROLEPLAY_RECENT_MESSAGES_MAX_CHARS,
  ROLEPLAY_SYSTEM_MAX_CHARS,
  ROLEPLAY_WORLD_MAX_CHARS,
  buildRoleplaySystemInstructions,
  buildRoleplayUserPrompt,
} from '../../src/server/services/roleplayPromptBuilder';
import { baseInstruction } from '../../src/server/prompts/baseInstruction';
import type {
  Character,
  RoleplayContextSnapshot,
  RoleplayMessage,
} from '../../src/server/types/index';

function baseCharacter(overrides: Partial<Character> = {}): Character {
  return {
    characterId: 'char-a',
    name: 'アリス',
    role: 'protagonist',
    description: '17歳の女子高生。よく本を読む。',
    speechStyle: '柔らかい丁寧語',
    traits: [
      { label: '会話で望むこと', text: '静かに本を読みたい' },
      { label: '苦手なこと', text: '無視されること' },
    ],
    secrets: '実は父と仲が悪い',
    relationshipNotes: 'ユーザーとは幼馴染',
    currentState: '放課後の教室に一人でいる',
    greeting: 'あ、来てくれたんだ。',
    dialogueExamples: ['……ここ、隣あいてるよ。', 'また明日、ね。'],
    ...overrides,
  };
}

function baseSnapshot(overrides: Partial<RoleplayContextSnapshot> = {}): RoleplayContextSnapshot {
  return {
    character: baseCharacter(),
    otherCharacters: [
      { characterId: 'char-b', name: 'ボブ', description: 'アリスの兄。' },
    ],
    worldDigest: '架空の日本の高校を舞台にした穏やかな日常。',
    customSystemPrompt: '',
    capturedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

function makeMessages(pairs: Array<[RoleplayMessage['role'], string]>): RoleplayMessage[] {
  return pairs.map(([role, content], i) => ({
    messageId: `rm-${i}`,
    role,
    content,
    createdAt: '2026-07-13T00:00:00.000Z',
  }));
}

describe('buildRoleplaySystemInstructions', () => {
  it('drops the strict 1〜3 sentence rule in favor of a length hint + parenthesized action guide', () => {
    const system = buildRoleplaySystemInstructions({
      snapshot: baseSnapshot(),
      outputLength: 350,
    });
    // 旧「1〜3文」制約は含まない
    expect(system).not.toContain('1〜3文');
    // 括弧書き動作の例が入っている
    expect(system).toContain('括弧書き');
    // 目安字数がプロンプトに埋め込まれる
    expect(system).toContain('350字程度');
  });

  it('falls back to 250 chars when outputLength is not provided', () => {
    const system = buildRoleplaySystemInstructions({ snapshot: baseSnapshot() });
    expect(system).toContain('250字程度');
  });

  it('includes persona fields (name, traits, secrets, currentState)', () => {
    const snapshot = baseSnapshot();
    const system = buildRoleplaySystemInstructions({ snapshot });
    expect(system).toContain('アリス');
    expect(system).toContain('静かに本を読みたい');
    expect(system).toContain('無視されること');
    expect(system).toContain('会話で望むこと');
    expect(system).toContain('苦手なこと');
    expect(system).toContain('実は父と仲が悪い');
    expect(system).toContain('放課後の教室に一人でいる');
  });

  it('includes the editable project base prompt captured for the session', () => {
    const system = buildRoleplaySystemInstructions({
      snapshot: baseSnapshot({
        projectSystemPrompt: 'この会話では短い比喩を使う。',
      }),
    });

    expect(system).toContain('【作品の基本システム指示】');
    expect(system).toContain('この会話では短い比喩を使う。');
  });

  it('treats secrets as hidden by the character (self-referential rule)', () => {
    const system = buildRoleplaySystemInstructions({ snapshot: baseSnapshot() });
    expect(system).toContain('隠している秘密');
    expect(system).toContain('自分からは明かさない');
  });

  it('formats dialogueExamples as quoted lines under the character name', () => {
    const system = buildRoleplaySystemInstructions({ snapshot: baseSnapshot() });
    expect(system).toContain('アリス:「……ここ、隣あいてるよ。」');
    expect(system).toContain('アリス:「また明日、ね。」');
  });

  it('respects overall system char budget by dropping optional sections', () => {
    const hugeWorld = 'あ'.repeat(ROLEPLAY_WORLD_MAX_CHARS * 2);
    const otherCharacters = Array.from({ length: 20 }).map((_, i) => ({
      characterId: `char-${i}`,
      name: `キャラ${i}`,
      description: '概要'.repeat(50),
    }));
    const snapshot = baseSnapshot({
      worldDigest: hugeWorld,
      otherCharacters,
      customSystemPrompt: '追加指示'.repeat(500),
    });
    const system = buildRoleplaySystemInstructions({ snapshot });
    expect(system.length).toBeLessThanOrEqual(ROLEPLAY_SYSTEM_MAX_CHARS);
    // 固定規則と対象キャラは常に含まれる
    expect(system).toContain('ロールプレイ規則');
    expect(system).toContain('対象キャラクター');
  });

  it('applies world digest cap when world is short (no truncation needed)', () => {
    const snapshot = baseSnapshot({ worldDigest: '短い世界観' });
    const system = buildRoleplaySystemInstructions({ snapshot });
    expect(system).toContain('短い世界観');
  });

  it('does not inject a legacy generated prompt as an additional roleplay instruction', () => {
    const legacyFullPrompt = [
      baseInstruction(),
      '【選択された設定】\n【文体: 自然な会話】\n自然な会話文で書く。',
    ].join('\n\n---\n\n');
    const system = buildRoleplaySystemInstructions({
      snapshot: baseSnapshot({ customSystemPrompt: legacyFullPrompt }),
    });

    expect(system).not.toContain(baseInstruction());
    expect(system).not.toContain('【追加のシステム指示】');
  });
});

describe('buildRoleplayUserPrompt', () => {
  it('quotes scenario within a data marker (not as command)', () => {
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      scenario: '放課後の教室で二人きり',
      recentMessages: [],
    });
    expect(prompt).toContain('<scenario>');
    expect(prompt).toContain('放課後の教室で二人きり');
    expect(prompt).toContain('</scenario>');
  });

  it('formats recent messages as ユーザー/キャラクター名 alternating lines', () => {
    const messages = makeMessages([
      ['user', 'こんにちは'],
      ['character', 'あ、来てくれたんだ。'],
      ['user', '本、読んでたの？'],
    ]);
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: messages,
    });
    expect(prompt).toContain('ユーザー: こんにちは');
    expect(prompt).toContain('アリス: あ、来てくれたんだ。');
    expect(prompt).toContain('ユーザー: 本、読んでたの？');
  });

  it('ends with a direct instruction addressed to the character', () => {
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
    });
    expect(prompt).toContain('アリスとして応答してください。');
  });

  it('truncates recent messages when they exceed the char budget', () => {
    const longContent = 'あ'.repeat(1000);
    const messages = makeMessages(
      Array.from({ length: 30 }).map((_, i) => [
        i % 2 === 0 ? 'user' : 'character',
        `${longContent}${i}`,
      ] as [RoleplayMessage['role'], string])
    );
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: messages,
    });
    // 予算内には収まっている
    const recentSection = prompt.split('【直近の会話】')[1] ?? '';
    expect(recentSection.length).toBeLessThan(ROLEPLAY_RECENT_MESSAGES_MAX_CHARS + 500);
  });

  it('includes conversationSummary as a labeled section when present', () => {
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      conversationSummary: 'これまでの経緯：小さな喧嘩からの仲直り',
      recentMessages: [],
    });
    expect(prompt).toContain('これまでの会話の要約');
    expect(prompt).toContain('小さな喧嘩からの仲直り');
  });

  it('omits the banned-expressions section when the list is empty or undefined', () => {
    const noArg = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
    });
    expect(noArg).not.toContain('【表現上の注意】');

    const emptyArg = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
      bannedExpressions: [],
    });
    expect(emptyArg).not.toContain('【表現上の注意】');
  });

  it('renders banned expressions right before the final instruction, each quoted with 「」', () => {
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
      bannedExpressions: ['息を呑んだ', '胸の奥が'],
    });
    expect(prompt).toContain('【表現上の注意】');
    expect(prompt).toContain('- 「息を呑んだ」');
    expect(prompt).toContain('- 「胸の奥が」');
    // 【指示】より前に置かれている
    const noticeIdx = prompt.indexOf('【表現上の注意】');
    const finalIdx = prompt.indexOf('【指示】');
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(finalIdx).toBeGreaterThan(noticeIdx);
  });

  it('drops entries with newlines to protect the banned-expressions section boundary', () => {
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
      bannedExpressions: ['ok', 'bad\ninjection', '  ok2  '],
    });
    expect(prompt).toContain('- 「ok」');
    expect(prompt).toContain('- 「ok2」');
    expect(prompt).not.toContain('bad');
    expect(prompt).not.toContain('injection');
  });

  it('caps banned entries at 12 and dedupes trimmed duplicates', () => {
    const items: string[] = [];
    for (let i = 0; i < 20; i++) items.push(`NG${i}`);
    items.push('  NG0  ');
    const prompt = buildRoleplayUserPrompt({
      snapshot: baseSnapshot(),
      recentMessages: [],
      bannedExpressions: items,
    });
    // 12 件までに絞られる（0..11）
    for (let i = 0; i < 12; i++) {
      expect(prompt).toContain(`- 「NG${i}」`);
    }
    expect(prompt).not.toContain('- 「NG12」');
    // 重複（トリム後同じ）は追加されない
    const occurrences = (prompt.match(/- 「NG0」/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});
