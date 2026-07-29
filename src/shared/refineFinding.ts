import type {
  RefineFinding,
  RefineFindingDisposition,
  RefineFindingTarget,
  RefineFindingTopic,
  RefineScanResult,
} from './types/refine.js';

// NOTE: fingerprint の素材スキーマ版。素材の並びや正規化規則を変えたら必ず上げる。
// 上げると既存 disposition は一致しなくなり、その finding は「未判断」へ戻る。
// 旧判断を黙って別の話題へ適用するより、もう一度確認してもらう方が安全。
export const REFINE_FINGERPRINT_SCHEMA_VERSION = 1;

const TOPIC_SET = new Set<RefineFindingTopic>([
  'motivation',
  'past',
  'goal',
  'relationship',
  'secret',
  'speech',
  'world-rule',
  'timeline',
  'state',
  'other',
]);

export function normalizeRefineFindingTopic(raw: unknown): RefineFindingTopic {
  if (typeof raw !== 'string') return 'other';
  const normalized = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return TOPIC_SET.has(normalized as RefineFindingTopic)
    ? (normalized as RefineFindingTopic)
    : 'other';
}

// NOTE: 自然言語の message は素材に使わない。モデルが同じ論点を言い換えただけで
// fingerprint が変わり、「意図的な空白」の判断が毎回失われるため。
function findingTargetKey(target: RefineFindingTarget, findingId: string): string {
  switch (target.kind) {
    case 'world':
    case 'systemPrompt':
    case 'storyState':
      return target.kind;
    case 'character':
      // NOTE: characterName はリネームで変わるので使わない。
      return `character:${target.characterId}`;
    case 'other':
      // NOTE: label はモデルが毎回書き起こす自由文で、安定識別子にならない。
      // 代わりに scan ローカルな finding id を混ぜ、この scan の中だけ一意にする。
      // 結果として fingerprint は scan をまたいで安定しないが、'other' には
      // 永続 disposition を許可しない（canMarkIntentionalGap / canMarkResolved）ので
      // 問題にならず、むしろ deferred が次回 scan で自然に失効する形になる。
      return `other:${findingId}`;
  }
}

export function buildRefineFindingFingerprintPayload(finding: {
  id: string;
  kind: RefineFinding['kind'];
  target: RefineFindingTarget;
  topic?: RefineFindingTopic;
}): string {
  return [
    `v${REFINE_FINGERPRINT_SCHEMA_VERSION}`,
    finding.kind,
    findingTargetKey(finding.target, finding.id),
    finding.topic ?? 'other',
  ].join('|');
}

// NOTE: target が 'other' の finding は fingerprint が scan をまたいで安定しない
// ので、永続的な判断（意図的な空白・解決済み）を保存させない。保存できてしまうと
// 次の scan では一致せず、ユーザーには「判断が消えた」ようにしか見えない。
export function canMarkIntentionalGap(finding: RefineFinding): boolean {
  if (finding.target.kind === 'other') return false;
  if (finding.kind === 'contradiction') return false;
  return (finding.topic ?? 'other') !== 'other';
}

export function canMarkResolved(finding: RefineFinding): boolean {
  return finding.target.kind !== 'other';
}

export function isRefineFindingDispositionAllowed(
  finding: RefineFinding,
  status: RefineFindingDisposition['status']
): boolean {
  switch (status) {
    case 'deferred':
      return true;
    case 'intentional-gap':
      return canMarkIntentionalGap(finding);
    case 'resolved':
      return canMarkResolved(finding);
  }
}

// NOTE: disposition が「今の scan に対してまだ有効か」の判定。UI のバッジ件数と
// サーバーの検証で同じ規則を使うため共有する。
export function isDispositionActive(
  disposition: RefineFindingDisposition,
  scan: Pick<RefineScanResult, 'generatedAt' | 'reviewedStaticInputHash'> | null
): boolean {
  switch (disposition.status) {
    case 'intentional-gap':
      return true;
    case 'deferred':
      // NOTE: 当該 scan の間だけ。再走査すれば同じ気づきをもう一度見せる。
      return Boolean(
        scan && disposition.scanGeneratedAt && disposition.scanGeneratedAt === scan.generatedAt
      );
    case 'resolved':
      // NOTE: 設定が変わったら再評価する。hash が取れない古いキャッシュでは
      // 判定材料が無いので有効とみなさない（未処理へ戻す方が安全側）。
      return Boolean(
        scan &&
          disposition.staticInputHash &&
          scan.reviewedStaticInputHash &&
          disposition.staticInputHash === scan.reviewedStaticInputHash
      );
  }
}

export function findActiveDisposition(
  finding: RefineFinding,
  dispositions: RefineFindingDisposition[],
  scan: Pick<RefineScanResult, 'generatedAt' | 'reviewedStaticInputHash'> | null
): RefineFindingDisposition | null {
  if (!finding.fingerprint) return null;
  const match = dispositions.find((d) => d.fingerprint === finding.fingerprint);
  if (!match) return null;
  return isDispositionActive(match, scan) ? match : null;
}

// NOTE: AI相談タブのバッジ件数。有効な disposition を持たない finding だけを数える。
export function countUnhandledRefineFindings(
  scan: RefineScanResult | null,
  dispositions: RefineFindingDisposition[]
): number {
  if (!scan) return 0;
  return scan.findings.filter((finding) => !findActiveDisposition(finding, dispositions, scan))
    .length;
}
