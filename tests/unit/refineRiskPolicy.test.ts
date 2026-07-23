import { describe, expect, it } from 'vitest';
import {
  classifyPatchRisk,
  computeStaticSettingsHash,
  effectivePatchOrigin,
  effectivePatchRiskLevel,
  evidenceQuoteFoundIn,
  isAutomationAllowedOperationKind,
  normalizeEvidenceQuoteForMatching,
} from '../../src/server/services/refineRiskPolicy';
import type { Character, RefinePatch, RefinePatchOperation } from '../../src/shared/types';

function character(overrides: Partial<Character> = {}): Character {
  return {
    characterId: 'char-a',
    name: 'A',
    role: 'protagonist',
    description: 'desc',
    ...overrides,
  };
}

describe('refineRiskPolicy.evidenceQuoteFoundIn / normalizeEvidenceQuoteForMatching', () => {
  it('matches an exact quote', () => {
    expect(evidenceQuoteFoundIn('丁寧な武家言葉', '彼は丁寧な武家言葉で話した。')).toBe(true);
  });

  it('matches across full-width/half-width and quote-mark differences', () => {
    expect(evidenceQuoteFoundIn('“丁寧な武家言葉”', '彼は「丁寧な武家言葉」で話した。')).toBe(true);
  });

  it('matches across CRLF/whitespace differences', () => {
    expect(evidenceQuoteFoundIn('丁寧な\r\n武家言葉', '彼は丁寧な\n武家言葉で話した。')).toBe(true);
  });

  it('does not match an unrelated quote', () => {
    expect(evidenceQuoteFoundIn('存在しない引用', '彼は丁寧な武家言葉で話した。')).toBe(false);
  });

  it('does not match an empty quote', () => {
    expect(evidenceQuoteFoundIn('   ', '本文')).toBe(false);
  });

  it('does not use fuzzy/paraphrase matching', () => {
    // NOTE: 「丁寧な言葉遣い」は意味的には近いが部分文字列としては一致しない。
    expect(evidenceQuoteFoundIn('丁寧な言葉遣い', '彼は丁寧な武家言葉で話した。')).toBe(false);
  });
});

describe('refineRiskPolicy.isAutomationAllowedOperationKind', () => {
  it('allows the five known operation kinds', () => {
    for (const kind of ['world-replace', 'world-append', 'character-update', 'character-add', 'character-remove']) {
      expect(isAutomationAllowedOperationKind(kind)).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(isAutomationAllowedOperationKind('system-prompt-update')).toBe(false);
  });
});

describe('refineRiskPolicy.classifyPatchRisk — safe allowlist', () => {
  const evidence = { evidenceScope: 'accepted' as const, evidenceQuote: '根拠引用', evidenceSourceText: '本文中の根拠引用です。' };

  it('classifies filling an empty speechStyle from confirmed evidence as safe', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      ...evidence,
    });
    expect(result.riskLevel).toBe('safe');
  });

  it('classifies filling empty traits from confirmed evidence as safe', () => {
    const result = classifyPatchRisk({
      operations: [
        { kind: 'character-update', characterId: 'char-a', fields: { traits: [{ label: '癖', text: '早口' }] } },
      ],
      characters: [character({ traits: [] })],
      worldText: '',
      ...evidence,
    });
    expect(result.riskLevel).toBe('safe');
  });

  it('classifies world-append onto empty world as safe', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'world-append', op: { text: '新しい設定' } }],
      characters: [],
      worldText: '   ',
      ...evidence,
    });
    expect(result.riskLevel).toBe('safe');
  });

  it('downgrades an otherwise-safe operation to review when evidence is missing', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      evidenceScope: 'accepted',
    });
    expect(result.riskLevel).toBe('review');
  });

  it('downgrades to review when the quote is not actually found in the source text', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      evidenceScope: 'accepted',
      evidenceQuote: '本文に存在しない引用',
      evidenceSourceText: '関係のない本文。',
    });
    expect(result.riskLevel).toBe('review');
  });

  it('overrides a model-reported-safe-shaped operation to review when evidenceScope is draft', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      evidenceScope: 'draft',
      evidenceQuote: '根拠引用',
      evidenceSourceText: '本文中の根拠引用です。',
    });
    expect(result.riskLevel).toBe('review');
  });

  it('overrides to review when evidenceScope is mixed', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      evidenceScope: 'mixed',
      evidenceQuote: '根拠引用',
      evidenceSourceText: '本文中の根拠引用です。',
    });
    expect(result.riskLevel).toBe('review');
  });

  it('overrides to review when evidenceScope is undefined (unknown)', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } }],
      characters: [character({ speechStyle: undefined })],
      worldText: '',
      evidenceScope: undefined,
      evidenceQuote: '根拠引用',
      evidenceSourceText: '本文中の根拠引用です。',
    });
    expect(result.riskLevel).toBe('review');
  });
});

describe('refineRiskPolicy.classifyPatchRisk — always-review rules', () => {
  const evidence = { evidenceScope: 'accepted' as const, evidenceQuote: '根拠引用', evidenceSourceText: '本文中の根拠引用です。' };

  it('world-replace is always review', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'world-replace', op: { anchor: 'a', replacement: 'b' } }],
      characters: [],
      worldText: 'a',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });

  it('world-append onto a non-empty world is review', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'world-append', op: { text: '追記' } }],
      characters: [],
      worldText: '既存の世界設定',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });

  it('character-add is always review', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-add', character: character({ characterId: 'char-new' }) }],
      characters: [],
      worldText: '',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });

  it('character-remove is always review', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-remove', characterId: 'char-a' }],
      characters: [character()],
      worldText: '',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });

  it('changing name/role/description/secrets/currentState is review even with confirmed evidence', () => {
    const fieldPatches: RefinePatchOperation[] = [
      { kind: 'character-update', characterId: 'char-a', fields: { name: '新しい名前' } },
      { kind: 'character-update', characterId: 'char-a', fields: { description: '新しい説明' } },
      { kind: 'character-update', characterId: 'char-a', fields: { secrets: '新しい秘密' } },
      { kind: 'character-update', characterId: 'char-a', fields: { currentState: '新しい状態' } },
    ];
    for (const op of fieldPatches) {
      const result = classifyPatchRisk({
        operations: [op],
        characters: [character()],
        worldText: '',
        ...evidence,
      });
      expect(result.riskLevel).toBe('review');
    }
  });

  it('overwriting an already-non-empty speechStyle is review, not safe', () => {
    const result = classifyPatchRisk({
      operations: [{ kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '新しい口調' } }],
      characters: [character({ speechStyle: '既存の口調' })],
      worldText: '',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });

  it('a patch with multiple operations takes the highest risk of any operation', () => {
    const result = classifyPatchRisk({
      operations: [
        { kind: 'character-update', characterId: 'char-a', fields: { speechStyle: '丁寧な口調' } },
        { kind: 'world-replace', op: { anchor: 'a', replacement: 'b' } },
      ],
      characters: [character({ speechStyle: undefined })],
      worldText: 'a',
      ...evidence,
    });
    expect(result.riskLevel).toBe('review');
  });
});

describe('refineRiskPolicy.computeStaticSettingsHash', () => {
  it('is stable for equivalent input regardless of character order', () => {
    const a = computeStaticSettingsHash({
      worldText: '世界',
      characters: [character({ characterId: 'char-a' }), character({ characterId: 'char-b', name: 'B' })],
    });
    const b = computeStaticSettingsHash({
      worldText: '世界',
      characters: [character({ characterId: 'char-b', name: 'B' }), character({ characterId: 'char-a' })],
    });
    expect(a).toBe(b);
  });

  it('changes when world text changes', () => {
    const a = computeStaticSettingsHash({ worldText: '世界A', characters: [] });
    const b = computeStaticSettingsHash({ worldText: '世界B', characters: [] });
    expect(a).not.toBe(b);
  });

  it('is stable across CRLF/trailing-whitespace differences', () => {
    const a = computeStaticSettingsHash({ worldText: '世界\r\n設定', characters: [] });
    const b = computeStaticSettingsHash({ worldText: '世界\n設定  ', characters: [] });
    expect(a).toBe(b);
  });
});

describe('refineRiskPolicy legacy-patch fallbacks', () => {
  function patch(overrides: Partial<RefinePatch> = {}): RefinePatch {
    return {
      patchId: 'patch-1',
      createdAt: '2026-07-22T00:00:00.000Z',
      sourceMessageId: 'msg-1',
      summary: 's',
      operations: [],
      status: 'pending',
      ...overrides,
    };
  }

  it('treats a patch without riskLevel as review', () => {
    expect(effectivePatchRiskLevel(patch())).toBe('review');
  });

  it('treats a patch without origin as manual-chat', () => {
    expect(effectivePatchOrigin(patch())).toBe('manual-chat');
  });

  it('respects an explicit riskLevel/origin when present', () => {
    expect(effectivePatchRiskLevel(patch({ riskLevel: 'safe' }))).toBe('safe');
    expect(effectivePatchOrigin(patch({ origin: 'auto-scan' }))).toBe('auto-scan');
  });
});
