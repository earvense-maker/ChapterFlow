import { describe, expect, it } from 'vitest';
import {
  chunkTextForPrompt,
  renderChunkBody,
  selectKnowledgeChunksForPrompt,
  selectWorldChunksForPrompt,
} from '../../src/server/services/knowledgePromptSelector';
import {
  NOVEL_KNOWLEDGE_CHUNK_CHARS,
  NOVEL_KNOWLEDGE_MAX_CHARS,
  NOVEL_KNOWLEDGE_MAX_CHUNKS_PER_FILE,
  NOVEL_WORLD_MAX_CHARS,
} from '../../src/server/prompts/promptBudget';

const query = (terms: string[], text: string) => ({ terms, text });

describe('chunkTextForPrompt', () => {
  it('見出しを境界にして分割し、直近見出しを保持する', () => {
    const chunks = chunkTextForPrompt({
      source: 'knowledge',
      sourceId: 'kb-1',
      sourceTitle: '用語集',
      sourceOrder: 0,
      text: '## 王都\n白い塔の街。\n\n## 港町\n霧が多い。',
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe('王都');
    expect(chunks[1].heading).toBe('港町');
    expect(chunks[0].text).toContain('白い塔の街。');
    expect(chunks[1].text).toContain('霧が多い。');
  });

  it('上限を超える単一段落は文境界で割る', () => {
    const long = '短い文です。'.repeat(600);
    const chunks = chunkTextForPrompt({
      source: 'knowledge',
      sourceId: 'kb-1',
      sourceTitle: '長文',
      sourceOrder: 0,
      text: long,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // overlap のぶんだけ上限をわずかに超えうるので、その余地込みで確認する
      expect(chunk.text.length).toBeLessThanOrEqual(NOVEL_KNOWLEDGE_CHUNK_CHARS * 2);
    }
  });

  it('隣接チャンクを両方採用したときだけ overlap を除いて描画する', () => {
    const chunks = chunkTextForPrompt({
      source: 'knowledge',
      sourceId: 'kb-1',
      sourceTitle: '資料',
      sourceOrder: 0,
      text: Array.from({ length: 40 }, (_, i) => `段落${i}。`.repeat(20)).join('\n\n'),
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1].overlapChars).toBeGreaterThan(0);

    // 隣接採用 → overlap を落とす
    const adjacent = renderChunkBody(chunks[1], chunks[0]);
    expect(adjacent.length).toBe(chunks[1].text.length - chunks[1].overlapChars);

    // 非隣接・単独採用 → そのまま（曖昧な類似判定はしない）
    expect(renderChunkBody(chunks[1], null)).toBe(chunks[1].text);
    if (chunks.length > 2) {
      expect(renderChunkBody(chunks[2], chunks[0])).toBe(chunks[2].text);
    }
  });
});

describe('selectKnowledgeChunksForPrompt', () => {
  const files = [
    { knowledgeId: 'kb-1', title: '人物名鑑', content: '## アキ\nアキは港町の灯台守。\n\n## ユイ\nユイは薬師。' },
    { knowledgeId: 'kb-2', title: '料理', content: '## パン\n小麦を焼く。\n\n## スープ\n野菜を煮る。' },
  ];

  it('関連するチャンクだけを選び、無関係な資料は落とす', () => {
    const result = selectKnowledgeChunksForPrompt(files, query(['アキ'], 'アキが灯台で待つ場面'));

    const titles = result.selected.map((chunk) => chunk.heading);
    expect(titles).toContain('アキ');
    expect(result.selected.length).toBeLessThan(result.totalCount);
    expect(result.omittedCount).toBe(result.totalCount - result.selected.length);
  });

  it('1ファイルあたりの採用数を守る', () => {
    const heavy = [
      {
        knowledgeId: 'kb-big',
        title: '大量資料',
        content: Array.from({ length: 30 }, (_, i) => `## 見出し${i}\nアキ について ${i}。`).join('\n\n'),
      },
    ];
    const result = selectKnowledgeChunksForPrompt(heavy, query(['アキ'], 'アキ'));
    expect(result.selected.length).toBeLessThanOrEqual(NOVEL_KNOWLEDGE_MAX_CHUNKS_PER_FILE);
  });

  it('20万字の資料でも合計上限を超えない', () => {
    const huge = [
      { knowledgeId: 'kb-huge', title: '巨大資料', content: 'あ'.repeat(200_000) },
    ];
    const result = selectKnowledgeChunksForPrompt(huge, query(['アキ'], 'アキ'));
    expect(result.selectedChars).toBeLessThanOrEqual(NOVEL_KNOWLEDGE_MAX_CHARS);
  });

  // NOTE: 一致ゼロで全資料が消えると「使用中にしたのに何も入らない」状態になる。
  it('正スコアが無ければ各ファイルの先頭チャンクを round-robin で拾う', () => {
    const result = selectKnowledgeChunksForPrompt(files, query([], 'まったく関係のない語彙 zzz'));

    expect(result.selected.length).toBeGreaterThan(0);
    const sourceIds = new Set(result.selected.map((chunk) => chunk.sourceId));
    expect(sourceIds.size).toBe(files.length);
    for (const chunk of result.selected) {
      expect(chunk.order).toBe(0);
    }
  });

  it('同じ入力からは並行実行しても同じ順序・同じ件数になる', async () => {
    const run = () => selectKnowledgeChunksForPrompt(files, query(['アキ'], 'アキが灯台へ'));
    const results = await Promise.all(Array.from({ length: 20 }, async () => run()));
    const expected = results[0].selected.map((c) => `${c.sourceId}:${c.order}`).join('|');
    for (const result of results) {
      expect(result.selected.map((c) => `${c.sourceId}:${c.order}`).join('|')).toBe(expected);
      expect(result.omittedCount).toBe(results[0].omittedCount);
    }
  });

  it('資料が無ければ空の結果を返す', () => {
    const result = selectKnowledgeChunksForPrompt([], query(['アキ'], 'アキ'));
    expect(result.selected).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});

describe('selectWorldChunksForPrompt', () => {
  const worldText = [
    '## 世界の土台',
    '魔法は免許制で、王都が管理している。',
    '',
    '## 開始時点の状況',
    'アキは港町に着いたばかり。',
  ].join('\n');

  it('世界の土台と開始時点の状況の意味区分を保つ', () => {
    const result = selectWorldChunksForPrompt(worldText, query(['アキ'], '港町の場面'));
    const titles = result.selected.map((chunk) => chunk.sourceTitle);

    expect(titles).toContain('世界の土台');
    expect(titles).toContain('開始時点の状況');
    for (const chunk of result.selected) {
      expect(chunk.source).toBe('world');
    }
  });

  it('世界の土台を開始時点の状況より高く並べる', () => {
    // NOTE: 開始時点の状況は採用済み本文・現在状態と競合しうるので一段低く扱う。
    const result = selectWorldChunksForPrompt(worldText, query([], '無関係な語 zzz'));
    const foundation = result.selected.findIndex((c) => c.sourceTitle === '世界の土台');
    const initial = result.selected.findIndex((c) => c.sourceTitle === '開始時点の状況');
    expect(foundation).toBeGreaterThanOrEqual(0);
    expect(initial).toBeGreaterThan(foundation);
  });

  it('長い世界設定でも合計上限を超えない', () => {
    const long = [
      '## 世界の土台',
      'あ'.repeat(30_000),
      '',
      '## 開始時点の状況',
      'い'.repeat(30_000),
    ].join('\n');
    const result = selectWorldChunksForPrompt(long, query(['アキ'], 'アキ'));
    expect(result.selectedChars).toBeLessThanOrEqual(NOVEL_WORLD_MAX_CHARS);
    expect(result.selected.length).toBeGreaterThan(0);
  });

  it('空の世界設定では何も返さない', () => {
    expect(selectWorldChunksForPrompt('', query([], '')).selected).toHaveLength(0);
  });
});
