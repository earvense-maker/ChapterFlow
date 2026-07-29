import { createHash } from 'node:crypto';
import { buildRefineFindingFingerprintPayload } from '../../shared/refineFinding.js';
import type {
  RefineFindingKind,
  RefineFindingTarget,
  RefineFindingTopic,
  RefineScanResult,
} from '../types/index.js';

// NOTE: fingerprint は AI に作らせず、必ずサーバーで計算する。素材は
// buildRefineFindingFingerprintPayload（スキーマ版 + kind + 安定識別子 + topic）で、
// 自然文の message は含めない。モデルが同じ論点を言い換えただけで判断（意図的な
// 空白など）が失われるのを防ぐため。
//
// refineScanService と refineChatService の双方から使うので独立モジュールにしている
// （どちらか片方に置くと相互 import になる）。
export function createRefineFindingFingerprint(finding: {
  id: string;
  kind: RefineFindingKind;
  target: RefineFindingTarget;
  topic: RefineFindingTopic;
}): string {
  return createHash('sha256')
    .update(buildRefineFindingFingerprintPayload(finding), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

// NOTE: fingerprint 導入前のキャッシュには fingerprint が無い。読み込み時に補って、
// 古い走査結果からでも判断を保存できるようにする。ファイルへは書き戻さない
// （次の走査で自然に付くため、読み取り経路で書き込みを増やさない）。
export function ensureFindingFingerprints(scan: RefineScanResult): RefineScanResult {
  if (scan.findings.every((f) => typeof f.fingerprint === 'string' && f.fingerprint)) return scan;
  return {
    ...scan,
    findings: scan.findings.map((finding) => {
      if (finding.fingerprint) return finding;
      const topic = finding.topic ?? 'other';
      return {
        ...finding,
        topic,
        fingerprint: createRefineFindingFingerprint({
          id: finding.id,
          kind: finding.kind,
          target: finding.target,
          topic,
        }),
      };
    }),
  };
}
