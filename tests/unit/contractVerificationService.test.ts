import { afterEach, describe, expect, it, vi } from 'vitest';
import * as contractVerificationService from '../../src/server/services/contractVerificationService';
import * as projectService from '../../src/server/services/projectService';
import * as storage from '../../src/server/services/storageService';
import { adapterMap } from '../../src/server/adapters/index.js';
import type { CreativeContract, Project } from '../../src/server/types/index';

const createdProjectIds: string[] = [];

async function createTrackedProject(): Promise<Project> {
  const project = await projectService.createProject({ title: 'Verify Test' });
  createdProjectIds.push(project.projectId);
  return project;
}

afterEach(async () => {
  await Promise.all(createdProjectIds.map((id) => storage.deleteProjectDir(id)));
  createdProjectIds.length = 0;
  vi.restoreAllMocks();
});

function contractWithHard(items: Array<{ contractId: string; text: string }>): CreativeContract {
  return {
    schemaVersion: 1,
    projectId: 'proj-x',
    revision: 1,
    items: items.map((item) => ({
      contractId: item.contractId,
      kind: 'promise',
      strength: 'hard',
      text: item.text,
      source: 'user',
      status: 'active',
      createdAt: '2026-07-02T00:00:00Z',
      updatedAt: '2026-07-02T00:00:00Z',
    })),
    exceptions: [],
    verificationMode: 'strict',
    updatedAt: '2026-07-02T00:00:00Z',
  };
}

async function verifyWith(contract: CreativeContract, text: string) {
  const project = await createTrackedProject();
  const adapter = adapterMap[project.activeModelProvider];
  const result = await contractVerificationService.verifyGeneratedText({
    project,
    adapter,
    contract,
    revealedCanon: [],
    text,
    ngExpressions: [],
    strict: true,
  });
  return { project, adapter, result };
}

describe('contractVerificationService（設計書 12.4）', () => {
  it('hard契約が無ければsemantic verifierを呼ばない', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const spy = vi.spyOn(adapter, 'generateText');
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: null,
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.status).toBe('skipped');
    expect(spy).not.toHaveBeenCalled();
  });

  it('NG表現の決定的検査で違反を検出し、修復に流す', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const semanticPass = {
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '問題なし' }],
      }),
      finishReason: 'stop',
      retryable: false,
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(semanticPass)
      .mockResolvedValueOnce({
        text: '彼女は微笑んだ。',
        finishReason: 'stop',
        retryable: false,
      })
      .mockResolvedValueOnce(semanticPass);
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '彼女は涙を流した。',
      ngExpressions: [{ id: 'ng-1', text: '涙を流した' }],
      strict: true,
    });
    expect(result.validation.repairCalls).toBe(1);
    expect(result.validation.status).toBe('repaired');
    expect(result.finalText).toBe('彼女は微笑んだ。');
  });

  it('verifierはactive model・30秒timeoutで呼ばれる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const generateText = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '問題なし' }],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '護衛は守り続けた。',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.checkedContractIds).toEqual(['ctr-1']);
    const calls = generateText.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0].debugLabel).toContain('semanticCheck');
    expect(calls[0][0].timeoutMs).toBe(30_000);
    expect(calls[0][0].modelName).toBe(project.activeModelName);
  });

  it('fail時の修復は1回を超えず、修復成功時はrepairedになる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const generateText = vi
      .fn()
      // 1回目: fail判定
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ contractId: 'ctr-1', verdict: 'fail', reason: '裏切り描写がある' }],
        }),
        finishReason: 'stop',
        retryable: false,
      })
      // 2回目: 修復（本文を差し替える）
      .mockResolvedValueOnce({
        text: '護衛は裏切らずに守り続けた。',
        finishReason: 'stop',
        retryable: false,
      })
      // 3回目: 再検証でpass
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '問題なし' }],
        }),
        finishReason: 'stop',
        retryable: false,
      });
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);

    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '護衛は裏切った。',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.status).toBe('repaired');
    expect(result.validation.repairCalls).toBe(1);
    expect(result.validation.verifierCalls).toBe(2);
    expect(result.finalText).toBe('護衛は裏切らずに守り続けた。');
    expect(result.reviewRequired).toBe(false);
  });

  it('修復後もfailが残るとreview-requiredになる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const generateText = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ contractId: 'ctr-1', verdict: 'fail', reason: '裏切り描写がある' }],
        }),
        finishReason: 'stop',
        retryable: false,
      })
      .mockResolvedValueOnce({
        text: '護衛は裏切らずに守り続けた。',
        finishReason: 'stop',
        retryable: false,
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          results: [{ contractId: 'ctr-1', verdict: 'fail', reason: '裏切り描写が残る' }],
        }),
        finishReason: 'stop',
        retryable: false,
      });
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);

    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '護衛は裏切った。',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.status).toBe('review-required');
    expect(result.validation.repairCalls).toBe(1);
    expect(result.reviewRequired).toBe(true);
  });

  it('verifierのtimeoutはuncertainとして扱い、別modelへフォールバックしない', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: '',
      finishReason: 'timeout',
      retryable: true,
    });
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.uncertainContractIds).toEqual(['ctr-1']);
    expect(result.validation.status).toBe('review-required');
  });

  it('verifierの不正JSONは全契約をuncertainにして合格扱いにしない', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: 'これはJSONではありません',
      finishReason: 'stop',
      retryable: false,
    });
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([
        { contractId: 'ctr-1', text: '護衛は裏切らない' },
        { contractId: 'ctr-2', text: '魔女は人を信じない' },
      ]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.uncertainContractIds.sort()).toEqual(['ctr-1', 'ctr-2']);
    expect(result.validation.status).toBe('review-required');
  });

  it('verifierの空配列も全契約をuncertainにする', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: JSON.stringify({ results: [] }),
      finishReason: 'stop',
      retryable: false,
    });
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.uncertainContractIds).toEqual(['ctr-1']);
  });

  it('判定が欠落した契約IDはuncertainになる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '問題なし' }],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([
        { contractId: 'ctr-1', text: '護衛は裏切らない' },
        { contractId: 'ctr-2', text: '魔女は人を信じない' },
      ]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.uncertainContractIds).toEqual(['ctr-2']);
    expect(result.validation.status).toBe('review-required');
  });

  it('未知のverdict（"passed"等）はuncertainとして扱い合格にしない（レビュー指摘 P1）', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        results: [
          { contractId: 'ctr-1', verdict: 'passed', reason: '問題なし（タイポ）' },
        ],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.uncertainContractIds).toEqual(['ctr-1']);
    expect(result.validation.status).toBe('review-required');
  });

  it('revealed canonとの矛盾（canonContradiction）を検出して修復対象にする（レビュー指摘 P1）', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const passResult = {
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '問題なし' }],
        canonContradiction: '',
      }),
      finishReason: 'stop',
      retryable: false,
    };
    const contradictionResult = {
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '契約は守られている' }],
        canonContradiction: '本文が「護衛は死んだ」と書いているが、正史は生存',
      }),
      finishReason: 'stop',
      retryable: false,
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(contradictionResult)
      .mockResolvedValueOnce({
        text: '護衛は生きている。',
        finishReason: 'stop',
        retryable: false,
      })
      .mockResolvedValueOnce(passResult);
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [
        {
          canonId: 'can-1',
          scope: 'character',
          statement: '護衛は生きている',
          status: 'revealed',
          baseStatusWithoutEvidence: 'retired',
          epistemicStatus: 'fact',
          source: 'generation',
          manualLock: false,
          evidence: [],
          createdAt: '2026-07-02T00:00:00Z',
          updatedAt: '2026-07-02T00:00:00Z',
        },
      ],
      text: '護衛は死んだ。',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.repairCalls).toBe(1);
    expect(result.validation.status).toBe('repaired');
    expect(result.finalText).toBe('護衛は生きている。');
  });

  it('修復後もcanonContradictionが残るとreview-requiredになる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const contradictionResult = {
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'pass', reason: '契約は守られている' }],
        canonContradiction: '本文が「護衛は死んだ」と書いている',
      }),
      finishReason: 'stop',
      retryable: false,
    };
    const generateText = vi
      .fn()
      .mockResolvedValueOnce(contradictionResult)
      .mockResolvedValueOnce({ text: '護衛は死んだ。', finishReason: 'stop', retryable: false })
      .mockResolvedValueOnce(contradictionResult);
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '護衛は死んだ。',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.status).toBe('review-required');
    expect(result.reviewRequired).toBe(true);
  });

  it('uncertainだけの場合は修復せずreview-requiredになる', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    const generateText = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'uncertain', reason: '判定できない' }],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    vi.spyOn(adapter, 'generateText').mockImplementation(generateText);
    const result = await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract: contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]),
      revealedCanon: [],
      text: '本文',
      ngExpressions: [],
      strict: true,
    });
    expect(result.validation.repairCalls).toBe(0);
    expect(result.validation.status).toBe('review-required');
  });

  it('警告を越えて採用しても契約は自動変更されない（検証は契約を書かない）', async () => {
    const project = await createTrackedProject();
    const adapter = adapterMap[project.activeModelProvider];
    vi.spyOn(adapter, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        results: [{ contractId: 'ctr-1', verdict: 'fail', reason: '違反' }],
      }),
      finishReason: 'stop',
      retryable: false,
    });
    const contract = contractWithHard([{ contractId: 'ctr-1', text: '護衛は裏切らない' }]);
    const before = JSON.stringify(contract);
    await contractVerificationService.verifyGeneratedText({
      project,
      adapter,
      contract,
      revealedCanon: [],
      text: '護衛は裏切った。',
      ngExpressions: [],
      strict: true,
    });
    expect(JSON.stringify(contract)).toBe(before);
  });
});
