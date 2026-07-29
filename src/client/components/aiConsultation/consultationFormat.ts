import type {
  Character,
  RefineAutomationMode,
  RefineEvidenceScope,
  RefineFindingKind,
  RefineFindingTarget,
  RefinePatchStatus,
} from '@shared/types';

export function statusLabel(status: RefinePatchStatus): string {
  switch (status) {
    case 'pending':
      return '要判断';
    case 'applied':
      return '反映済み';
    case 'rejected':
      return '見送り';
    case 'stale':
      return '古い提案';
  }
}

export function modeLabel(mode: RefineAutomationMode): string {
  switch (mode) {
    case 'off':
      return 'オフ';
    case 'suggest':
      return '提案だけ作る';
    case 'safe':
      return '安全な提案を自動適用';
    case 'all':
      return 'すべて自動適用';
  }
}

export function evidenceScopeLabel(scope: RefineEvidenceScope | undefined): string {
  switch (scope) {
    case 'static':
      return '既存設定';
    case 'accepted':
      return '採用済み本文';
    case 'draft':
      return '下書き（未採用）';
    case 'mixed':
      return '複合';
    default:
      return '不明';
  }
}

export function kindLabel(kind: RefineFindingKind): string {
  switch (kind) {
    case 'contradiction':
      return '⚠ 矛盾';
    case 'undefined':
      return '✎ 未定義';
    case 'suggestion':
      return '＋ 提案';
  }
}

export function formatFindingTarget(target: RefineFindingTarget): string {
  switch (target.kind) {
    case 'world':
      return '世界設定';
    case 'systemPrompt':
      return 'システムプロンプト';
    case 'storyState':
      return 'ストーリー状態';
    case 'character':
      return `人物: ${target.characterName}`;
    case 'other':
      return target.label;
  }
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatCharacterFieldValue(character: Character | undefined, key: string): string {
  if (!character) return '（該当なし）';
  const value = (character as unknown as Record<string, unknown>)[key];
  if (key === 'traits') return value === undefined ? '（未記入）' : formatCharacterPatchValue(value);
  if (typeof value === 'string') return value.trim() || '（未記入）';
  return '（未記入）';
}

export function formatCharacterPatchValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '（なし）';
    const lines = value.flatMap((item) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        Array.isArray(item) ||
        !('label' in item) ||
        !('text' in item) ||
        typeof item.label !== 'string' ||
        typeof item.text !== 'string'
      ) {
        return [];
      }
      const text = item.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\n  ');
      return [`${item.label}: ${text}`];
    });
    return lines.length > 0 ? lines.join('\n') : '（なし）';
  }
  if (typeof value === 'string') return value.trim() || '（未記入）';
  return value == null ? '（未記入）' : String(value);
}
