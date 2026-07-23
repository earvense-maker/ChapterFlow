import { createHash } from 'node:crypto';
import type {
  Character,
  RefineEvidenceScope,
  RefinePatch,
  RefinePatchOperation,
  RefinePatchOrigin,
  RefineRiskLevel,
} from '../types/index.js';

// NOTE: このモジュールはサーバー側の最終リスク分類（正本）。モデルの自己申告する
// risk はヒントに過ぎず、ここでの再判定を必ず上書きに使う。I/O を一切持たない
// 純粋関数のみで構成し、ユニットテストで直接検証できるようにする。
//
// アンカー0/複数マッチ・対象人物不在・schema検証失敗といったハードガードは、ここでは
// 再実装しない。refineChatService.applyPatchOperationsToSnapshot が正本であり、
// 適用そのものが失敗すればこのpatchは自動適用対象から外れる（refineAutomationService
// 側で処理）。

export type AutomationOperationAllowKind = RefinePatchOperation['kind'];

// NOTE: RefinePatchOperation の kind union は現状 world/characters のみだが、将来 union
// が拡張されたときに自動的に許可範囲へ含まれてしまわないよう、実行時の allowlist を
// 明示的に持つ（defense-in-depth）。
export const AUTOMATION_OPERATION_ALLOWLIST: ReadonlySet<AutomationOperationAllowKind> = new Set([
  'world-replace',
  'world-append',
  'character-update',
  'character-add',
  'character-remove',
]);

export function isAutomationAllowedOperationKind(kind: string): kind is AutomationOperationAllowKind {
  return AUTOMATION_OPERATION_ALLOWLIST.has(kind as AutomationOperationAllowKind);
}

export function computeStaticSettingsHash(input: { worldText: string; characters: Character[] }): string {
  const normalizedCharacters = input.characters
    .map((character) => ({
      characterId: normalizeHashText(character.characterId),
      name: normalizeHashText(character.name),
      aliases: (character.aliases ?? []).map(normalizeHashText).filter(Boolean).sort(),
      role: character.role,
      description: normalizeHashText(character.description),
      speechStyle: normalizeHashText(character.speechStyle ?? ''),
      relationshipNotes: normalizeHashText(character.relationshipNotes ?? ''),
      secrets: normalizeHashText(character.secrets ?? ''),
      traits: (character.traits ?? []).map((trait) => ({
        label: normalizeHashText(trait.label),
        text: normalizeHashText(trait.text),
      })),
      currentState: normalizeHashText(character.currentState ?? ''),
    }))
    .sort((a, b) => a.characterId.localeCompare(b.characterId));
  const payload = JSON.stringify({
    world: normalizeHashText(input.worldText),
    characters: normalizedCharacters,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function normalizeHashText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

// NOTE: safe 判定の quote 照合専用の正規化。NFKC + 改行 + 連続空白 + 引用符の外枠を
// 畳み込み、部分文字列一致だけを許す（編集距離・埋め込み類似度・意味的一致は使わない）。
// NOTE: ASCII 直引用符・カーブ引用符・和文カギ括弧・全角引用符をまとめて畳み込む。
// NFKC はカーブ引用符と直引用符のような「非互換だが見た目が近い」記号までは
// 統一しないため、ここで明示的に列挙する。
const QUOTE_MARK_PATTERN = /["'“”‘’「」『』＂＇]/g;

export function normalizeEvidenceQuoteForMatching(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(QUOTE_MARK_PATTERN, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function evidenceQuoteFoundIn(quote: string, sourceText: string): boolean {
  const normalizedQuote = normalizeEvidenceQuoteForMatching(quote);
  if (!normalizedQuote) return false;
  const normalizedSource = normalizeEvidenceQuoteForMatching(sourceText);
  return normalizedSource.includes(normalizedQuote);
}

export interface ClassifyPatchRiskInput {
  operations: RefinePatchOperation[];
  // NOTE: 適用前の現在値。「非空の確定値を上書きするか」の判定に使う。
  characters: Character[];
  worldText: string;
  evidenceScope: RefineEvidenceScope | undefined;
  evidenceQuote?: string;
  evidenceSourceText?: string;
}

export interface ClassifyPatchRiskResult {
  riskLevel: RefineRiskLevel;
  riskReasons: string[];
}

const RISK_RANK: Record<RefineRiskLevel, number> = { safe: 0, review: 1 };

function maxRisk(a: RefineRiskLevel, b: RefineRiskLevel): RefineRiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

// character-update が触れてよい「空欄補完のみ」フィールド。それ以外のフィールドへの
// 変更は常に review（設計書 7.3 の review固定リスト）。
const SAFE_FILLABLE_CHARACTER_FIELDS = ['speechStyle', 'relationshipNotes', 'traits'] as const;

function classifyOperation(
  op: RefinePatchOperation,
  characters: Character[],
  worldText: string
): { risk: RefineRiskLevel; reasons: string[] } {
  switch (op.kind) {
    case 'world-replace':
      return { risk: 'review', reasons: ['world-replace は常に要確認です。'] };

    case 'world-append': {
      if (worldText.trim().length === 0) {
        return { risk: 'safe', reasons: [] };
      }
      return { risk: 'review', reasons: ['既存の世界設定への追記は要確認です。'] };
    }

    case 'character-add':
      return { risk: 'review', reasons: ['人物の追加は常に要確認です。'] };

    case 'character-remove':
      return { risk: 'review', reasons: ['人物の削除は常に要確認です。'] };

    case 'character-update': {
      const target = characters.find((c) => c.characterId === op.characterId);
      if (!target) {
        // 対象不在自体はハードガード（applyPatchOperationsToSnapshot）が拒否するが、
        // ここでも安全側に倒す。
        return { risk: 'review', reasons: ['対象人物が見つかりません。'] };
      }
      const touchedFields = Object.keys(op.fields) as Array<keyof typeof op.fields>;
      if (touchedFields.length === 0) {
        return { risk: 'review', reasons: ['変更内容が空です。'] };
      }
      const reasons: string[] = [];
      let risk: RefineRiskLevel = 'safe';
      for (const field of touchedFields) {
        if (!SAFE_FILLABLE_CHARACTER_FIELDS.includes(field as (typeof SAFE_FILLABLE_CHARACTER_FIELDS)[number])) {
          risk = 'review';
          reasons.push(`${field} の変更は要確認です。`);
          continue;
        }
        if (field === 'traits') {
          const currentTraits = target.traits ?? [];
          if (currentTraits.length > 0) {
            risk = 'review';
            reasons.push('既存の traits を上書きするため要確認です。');
          }
        } else {
          const currentValue = (target[field] as string | undefined) ?? '';
          if (currentValue.trim().length > 0) {
            risk = 'review';
            reasons.push(`既存の ${field} を上書きするため要確認です。`);
          }
        }
      }
      return { risk, reasons };
    }

    default:
      return { risk: 'review', reasons: ['未対応の操作種別です。'] };
  }
}

export function classifyPatchRisk(input: ClassifyPatchRiskInput): ClassifyPatchRiskResult {
  let riskLevel: RefineRiskLevel = 'safe';
  const reasons: string[] = [];

  for (const op of input.operations) {
    const result = classifyOperation(op, input.characters, input.worldText);
    riskLevel = maxRisk(riskLevel, result.risk);
    reasons.push(...result.reasons);
  }

  if (
    input.evidenceScope === undefined ||
    input.evidenceScope === 'draft' ||
    input.evidenceScope === 'mixed'
  ) {
    riskLevel = 'review';
    reasons.push('根拠が下書きのみ、または不明確なため要確認です。');
  } else if (!input.evidenceQuote || !input.evidenceSourceText) {
    riskLevel = 'review';
    reasons.push('根拠の引用が確認できないため要確認です。');
  } else if (!evidenceQuoteFoundIn(input.evidenceQuote, input.evidenceSourceText)) {
    riskLevel = 'review';
    reasons.push('根拠の引用が本文中に見つからないため要確認です。');
  }

  return { riskLevel, riskReasons: dedupe(reasons) };
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

// NOTE: 古いパッチにはこれらのフィールドが存在しない。欠損時のフォールバックを
// 1箇所に集約する（設計書 5.4）。
export function effectivePatchRiskLevel(patch: RefinePatch): RefineRiskLevel {
  return patch.riskLevel ?? 'review';
}

export function effectivePatchOrigin(patch: RefinePatch): RefinePatchOrigin {
  return patch.origin ?? 'manual-chat';
}
