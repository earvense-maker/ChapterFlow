import * as storage from './storageService.js';
import { withProjectWriteLock } from './projectLock.js';
import { nowIso } from '../utils/date.js';
import type { RefineMaintenancePhase, RefineMaintenanceStatus } from '../types/index.js';

// NOTE: このファイルは意図的に generationService.js / refineChatService.js に依存しない
// 末端モジュールとして切り出す。generationService が自動レビューのガードを呼ぶ一方、
// refineAutomationService は generationService（withProjectWriteLock）と
// refineChatService（withSessionLock 等）の両方に依存するため、ガード判定を
// refineAutomationService.js に置いたまま generationService.js からimportすると
// generationService -> refineAutomationService -> generationService の循環importに
// なる。判定ロジックだけをこの依存の無いモジュールへ切り出し、
// refineAutomationService.js 側は re-export して外部からの見え方は変えない。

export class RefineAutomationError extends Error {
  code: string;
  retryable: boolean;
  status: number;

  constructor(message: string, code: string, retryable: boolean, status = 500) {
    super(message);
    this.name = 'RefineAutomationError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

const MAINTENANCE_BLOCKING_PHASES = new Set<RefineMaintenancePhase>([
  'scanning',
  'applying',
  'reverting',
]);

export function maintenanceBlocksGeneration(phase: RefineMaintenancePhase | undefined): boolean {
  return phase !== undefined && MAINTENANCE_BLOCKING_PHASES.has(phase);
}

export class MaintenanceInProgressError extends RefineAutomationError {
  constructor() {
    super(
      '設定を自動レビュー中のため、いまは生成できません。完了後にもう一度お試しください。',
      'post_generation_maintenance_in_progress',
      true,
      409
    );
  }
}

// NOTE: プロセスが途中で死ぬなどして lease だけが取り残された blocking phase を
// 恒久的な生成ロックにしないため、期限切れの blocking レコードは failed へ
// 正規化してから判定する（設計書 7.8）。実際に pipeline を実行中の live プロセスは
// lease を定期更新できていないため、Phase C 実装時にはハートビート更新を導入する。
// Phase B の間は「明らかに孤立した expired lease は無視する」だけで十分。
//
// 書き込み経路は withProjectWriteLock 内でだけ行う。preflight（SSE の writeHead 前）
// から呼ばれた場合でも、read → 期限判定 → write を同じロックで直列化することで、
// storyStateRefresh / accept / apply などと state を奪い合わないようにする。
function isExpired(maintenance: RefineMaintenanceStatus): boolean {
  const expiresAt = Date.parse(maintenance.leaseExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt < Date.now();
}

async function normalizeExpiredLease(projectId: string): Promise<RefineMaintenanceStatus | undefined> {
  return withProjectWriteLock(projectId, async () => {
    const state = await storage.readState(projectId);
    const maintenance = state?.refineMaintenance;
    if (!state || !maintenance) return undefined;
    if (!maintenanceBlocksGeneration(maintenance.phase)) return maintenance;
    if (!isExpired(maintenance)) return maintenance;
    const failed: RefineMaintenanceStatus = {
      ...maintenance,
      phase: 'failed',
      updatedAt: nowIso(),
      errorMessage: maintenance.errorMessage ?? 'メンテナンスの実行が中断されました。',
    };
    await storage.writeState(projectId, { ...state, refineMaintenance: failed });
    return failed;
  });
}

export async function readAndNormalizeMaintenance(
  projectId: string
): Promise<RefineMaintenanceStatus | undefined> {
  // NOTE: 高頻度に呼ばれる guard なので、まず lock なしで read して blocking かつ
  // 期限切れの場合だけ lock 取得＋書き戻しに入る。ロック内でも最新状態を再検査するため、
  // 判定中に別runが開始しても有効なleaseを上書きしない。
  const state = await storage.readState(projectId);
  const maintenance = state?.refineMaintenance;
  if (!maintenance || !maintenanceBlocksGeneration(maintenance.phase)) return maintenance;
  if (!isExpired(maintenance)) return maintenance;
  return normalizeExpiredLease(projectId);
}

export async function assertGenerationNotBlockedByMaintenance(projectId: string): Promise<void> {
  const maintenance = await readAndNormalizeMaintenance(projectId);
  if (maintenanceBlocksGeneration(maintenance?.phase)) {
    throw new MaintenanceInProgressError();
  }
}
