// 妄想増幅器の既存操作成功hook（設計書 7.4）
//
// NOTE: 既存サービスの成功hookで作るイベントは、元の編集・再生成が失敗した場合に記録
// しない（設計書 7.4 末尾）。ここは fire-and-forget で呼び、失敗しても元の操作を
// ブロックしない（非同期補助処理の失敗を成功した本文生成の失敗へ変えない・設計書 21）。
// clientEventId はサーバー採番（設計書 7.4 の「サーバー採番」列）。

import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import { withProjectWriteLock } from './projectLock.js';
import * as amplifier from './amplifierService.js';
import { normalizeExperienceMode } from '../types/index.js';
import type {
  AmplifierAnchor,
  AmplifierInteractionEvent,
} from '../types/index.js';

const storage = localProjectStorage();

async function isAmplifierProject(projectId: string): Promise<boolean> {
  const project = await storage.readProject(projectId).catch(() => null);
  return normalizeExperienceMode(project?.experienceMode) === 'amplifier';
}

export async function runContentEditedHook(input: {
  projectId: string;
  anchor: AmplifierAnchor;
  beforeText: string;
  afterText: string;
}): Promise<void> {
  try {
    if (!(await isAmplifierProject(input.projectId))) return;
    await withProjectWriteLock(input.projectId, async () => {
      // 事前確認後に作品削除が割り込んだ場合、削除済みディレクトリを再作成しない。
      if (!(await isAmplifierProject(input.projectId))) return;
      const notebook = await amplifier.readNotebook(input.projectId);
      const contextKey = buildHookContextKey(input.anchor);
      const { event } = await amplifier.recordInteractionUnlocked(input.projectId, {
        // NOTE: サーバー採番。再送の可能性が無い一意キーとして「種別+時刻ID」を使う。
        clientEventId: `server:content_edited:${generateTimestampId('hook')}`,
        mode: input.anchor.kind === 'roleplay' ? 'roleplay' : 'novel',
        type: 'content_edited',
        anchor: input.anchor,
        payload: {
          anchor: input.anchor,
          beforeHash: amplifier.computeAnchorTextHash(input.beforeText),
          afterHash: amplifier.computeAnchorTextHash(input.afterText),
        },
        // NOTE: 会話枠ごとのグローバル学習除外も反映する（設計書 14.2）。
        excludeFromGlobalLearning: await amplifier.resolveEventExcludeFromGlobalLearning(
          input.projectId,
          contextKey,
          notebook
        ),
        contextKey,
      });
      // NOTE: 本文保存後に旧turnをsupersedeする（設計書 4.3）。失敗しても編集は残す。
      await supersedeTurnsForAnchorUnlocked(input.projectId, input.anchor, event);
    });
  } catch (error) {
    console.warn('Amplifier content_edited hook failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runSceneRegeneratedHook(input: {
  projectId: string;
  beforeAnchor: AmplifierAnchor;
  afterAnchor: AmplifierAnchor;
}): Promise<void> {
  try {
    if (!(await isAmplifierProject(input.projectId))) return;
    await withProjectWriteLock(input.projectId, async () => {
      if (!(await isAmplifierProject(input.projectId))) return;
      const notebook = await amplifier.readNotebook(input.projectId);
      const contextKey = buildHookContextKey(input.afterAnchor);
      await amplifier.recordInteractionUnlocked(input.projectId, {
        clientEventId: `server:scene_regenerated:${generateTimestampId('hook')}`,
        mode: input.afterAnchor.kind === 'roleplay' ? 'roleplay' : 'novel',
        type: 'scene_regenerated',
        anchor: input.afterAnchor,
        payload: {
          beforeAnchor: input.beforeAnchor,
          afterAnchor: input.afterAnchor,
        },
        // NOTE: 会話枠ごとのグローバル学習除外も反映する（設計書 14.2）。
        excludeFromGlobalLearning: await amplifier.resolveEventExcludeFromGlobalLearning(
          input.projectId,
          contextKey,
          notebook
        ),
        contextKey,
      });
    });
  } catch (error) {
    console.warn('Amplifier scene_regenerated hook failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// NOTE: 小説の書き直し・別案（regenerate/variate）成功後の hook（設計書 7.4）。
// before の改訂番号は保存済みレコードから解決する。
export async function runNovelRegenerateHook(input: {
  projectId: string;
  beforeGenerationId: string;
  afterGenerationId: string;
}): Promise<void> {
  try {
    if (!(await isAmplifierProject(input.projectId))) return;
    const before = await storage.findGenerationRecord(input.projectId, input.beforeGenerationId);
    await runSceneRegeneratedHook({
      projectId: input.projectId,
      beforeAnchor: {
        kind: 'novel',
        generationId: input.beforeGenerationId,
        textRevisionNumber: before?.textRevisionNumber ?? 0,
      },
      afterAnchor: {
        kind: 'novel',
        generationId: input.afterGenerationId,
        textRevisionNumber: 0,
      },
    });
  } catch (error) {
    console.warn('Amplifier scene_regenerated hook failed', {
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function buildHookContextKey(anchor: AmplifierAnchor): string {
  if (anchor.kind === 'roleplay') return `roleplay:${anchor.sessionId}`;
  return 'novel:main';
}

// NOTE: 同じアンカーの未消費ターンを superseded にする（設計書 4.3）。本文が変わった
// 場合は、保存済み実効本文からハッシュを作り直すため、既存ターンは古いものとして扱う。
async function supersedeTurnsForAnchorUnlocked(
  projectId: string,
  anchor: AmplifierAnchor,
  event: AmplifierInteractionEvent
): Promise<void> {
  const contextKey = buildHookContextKey(anchor);
  const turns = await amplifier.readTurnsForContextKey(projectId, contextKey);
  for (const turn of turns) {
    if (turn.status === 'consumed' || turn.status === 'superseded') continue;
    if (anchor.kind === 'novel') {
      if (turn.anchor.kind !== 'novel' || turn.anchor.generationId !== anchor.generationId) {
        continue;
      }
    } else if (
      turn.anchor.kind !== 'roleplay' ||
      turn.anchor.sessionId !== anchor.sessionId ||
      turn.anchor.messageId !== anchor.messageId
    ) {
      continue;
    }
    const next = {
      ...turn,
      status: 'superseded' as const,
      consumedByEventId: event.eventId,
      updatedAt: nowIso(),
    };
    await amplifier.writeTurn(projectId, next);
  }
}
