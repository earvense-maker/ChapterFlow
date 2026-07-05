import { afterEach, describe, expect, it, vi } from 'vitest';
import * as refineScanService from '../../src/server/services/refineScanService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { GeminiAdapter } from '../../src/server/adapters/geminiAdapter';
import type { Character } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<string> {
  const project = await projectService.createProject({ title: 'Refine Test' });
  createdProjectIds.push(project.projectId);
  return project.projectId;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
});

describe('refineScanService', () => {
  it('returns null when no cached scan exists', async () => {
    const projectId = await createTrackedProject();
    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).toBeNull();
  });

  it('parses well-formed JSON and normalizes findings', async () => {
    const projectId = await createTrackedProject();
    const character: Character = {
      characterId: 'char-1',
      name: '秋葉',
      role: 'protagonist',
      description: '27歳、蘭学者。',
    };
    await storage.writeCharacters(projectId, [character]);
    await storage.writeWorld(projectId, '江戸後期の江戸を舞台にした物語。');

    const responseJson = JSON.stringify({
      coreConcept: '江戸後期の蘭学者を軸にした静かなドラマ。',
      findings: [
        {
          kind: 'contradiction',
          target: {
            kind: 'character',
            characterId: 'char-1',
            characterName: '秋葉',
          },
          message: '宗教観と第2章の独白に矛盾があります。',
          detail: '独白では神仏を否定しているが、人物設定では信仰心があるとされる。',
        },
        {
          kind: 'undefined',
          target: { kind: 'world' },
          message: '舞台の季節が未設定です。',
        },
        {
          // 不正なペイロード: kind 不明 → 除外されるべき
          kind: 'unknown',
          target: { kind: 'world' },
          message: 'ignored',
        },
      ],
    });
    mockAdapterGenerateText({
      text: '```json\n' + responseJson + '\n```',
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.coreConcept).toContain('蘭学者');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0].kind).toBe('contradiction');
    expect(result.findings[0].target).toMatchObject({
      kind: 'character',
      characterId: 'char-1',
    });
    expect(result.findings[1].kind).toBe('undefined');
    expect(result.lastError).toBeNull();

    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).not.toBeNull();
    expect(cached!.findings).toHaveLength(2);
  });

  it('falls back gracefully when the model returns non-JSON', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text: 'すみません、JSONを返し忘れました。',
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.findings).toEqual([]);
    expect(result.coreConcept).toBe('');
    expect(result.lastError).toContain('解釈できません');
    // NOTE: 診断に応答の一部を載せる
    expect(result.lastError).toContain('JSONを返し忘れ');

    const cached = await refineScanService.readCachedRefineScan(projectId);
    expect(cached).not.toBeNull();
    expect(cached!.lastError).toContain('解釈できません');
  });

  it('surfaces empty response with a targeted hint', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({ text: '', finishReason: 'stop' });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toContain('空の応答');
  });

  it('accepts raw JSON without a code fence', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text: JSON.stringify({
        coreConcept: 'テスト作品',
        findings: [],
      }),
      finishReason: 'stop',
    });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toBeNull();
    expect(result.coreConcept).toBe('テスト作品');
  });

  it('extracts JSON when the response has preamble text before a code fence', async () => {
    const projectId = await createTrackedProject();
    mockAdapterGenerateText({
      text:
        '以下が結果です:\n\n```json\n' +
        JSON.stringify({ coreConcept: '骨のある物語', findings: [] }) +
        '\n```\n\n以上です。',
      finishReason: 'stop',
    });
    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.lastError).toBeNull();
    expect(result.coreConcept).toBe('骨のある物語');
  });

  it('passes responseMimeType=application/json to the adapter', async () => {
    const projectId = await createTrackedProject();
    const spy = vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
      text: '{"coreConcept":"","findings":[]}',
      finishReason: 'stop',
      retryable: false,
    });
    await refineScanService.scanProjectSettings(projectId);
    expect(spy.mock.calls[0][0].responseMimeType).toBe('application/json');
  });

  it('rewrites unknown character ids into "other" targets', async () => {
    const projectId = await createTrackedProject();
    await storage.writeCharacters(projectId, []);

    mockAdapterGenerateText({
      text: JSON.stringify({
        coreConcept: '',
        findings: [
          {
            kind: 'contradiction',
            target: {
              kind: 'character',
              characterId: 'char-does-not-exist',
              characterName: '望月',
            },
            message: 'テスト',
          },
        ],
      }),
      finishReason: 'stop',
    });

    const result = await refineScanService.scanProjectSettings(projectId);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].target).toEqual({ kind: 'other', label: '人物: 望月' });
  });
});

function mockAdapterGenerateText(result: {
  text: string;
  finishReason: 'stop' | 'error' | 'timeout' | 'length' | 'content_filter';
}) {
  // NOTE: デフォルトプロバイダーは gemini なので Gemini adapter だけ差し替える。
  vi.spyOn(GeminiAdapter.prototype, 'generateText').mockResolvedValue({
    text: result.text,
    finishReason: result.finishReason,
    retryable: false,
  });
}
