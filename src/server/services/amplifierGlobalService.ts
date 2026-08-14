// 妄想増幅器グローバル学習サービス（設計書 9.2 / 13.4 / 14.3）
//
// NOTE: グローバルデータは DATA_DIR/config/amplifier 配下に置き、プロジェクト削除と
// 独立させる。オン・オフ状態（globalLearningEnabled / globalLearningResetAt）は
// app-settings ではなく global-notebook.json に保存し、データ保存先の移動・バックアップ・
// 復元と一緒に移ることを保証する（設計書 9.2）。
// グローバル更新には専用mutexを持つ（設計書 9.4）。グローバルロックを保持したまま
// プロジェクトロックを取得しない（設計書 12.1）。

import { KeyedMutex } from '../utils/keyedMutex.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { localProjectStorage } from '../storage/boundProjectStorage.js';
import type {
  AmplifierGlobalObservation,
  GlobalNotebook,
  PreferenceAppliesTo,
  PreferenceCorrection,
  PreferenceMemo,
} from '../types/index.js';

const storage = localProjectStorage();

export class AmplifierGlobalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AmplifierGlobalError';
  }
}

const globalMutex = new KeyedMutex();

// NOTE: グローバル更新はすべてこの排他区間を通す（設計書 9.4）。Interpreter の
// prepare/commit もここで直列化し、グローバルロック保持中のプロジェクトロック取得を
// 呼び出し側で禁止する（設計書 12.1）。
export function withGlobalMutexRun<T>(task: () => Promise<T>): Promise<T> {
  return globalMutex.runExclusive('global-amplifier', task);
}

function createDefaultGlobalNotebook(): GlobalNotebook {
  const now = nowIso();
  return {
    schemaVersion: 1,
    globalLearningEnabled: true,
    globalLearningResetAt: null,
    memos: [],
    corrections: [],
    globalBoundary: '',
    // NOTE: 解釈カーソルは「畳み込み済み観察件数」。observations の行数が正本で、
    // 追記型ログの先頭から数える。
    foldedThroughSequence: 0,
    interpreter: { state: 'idle' },
    revision: 1,
    updatedAt: now,
  };
}

function normalizeGlobalNotebook(value: GlobalNotebook | null): GlobalNotebook {
  const now = nowIso();
  if (!value || typeof value !== 'object') return createDefaultGlobalNotebook();
  const raw = value as Partial<GlobalNotebook>;
  return {
    schemaVersion: 1,
    globalLearningEnabled:
      typeof raw.globalLearningEnabled === 'boolean' ? raw.globalLearningEnabled : true,
    globalLearningResetAt:
      typeof raw.globalLearningResetAt === 'string' ? raw.globalLearningResetAt : null,
    memos: Array.isArray(raw.memos) ? raw.memos : [],
    corrections: Array.isArray(raw.corrections) ? raw.corrections : [],
    globalBoundary: typeof raw.globalBoundary === 'string' ? raw.globalBoundary : '',
    foldedThroughSequence:
      typeof raw.foldedThroughSequence === 'number' ? raw.foldedThroughSequence : 0,
    interpreter:
      raw.interpreter && typeof raw.interpreter === 'object'
        ? (raw.interpreter as GlobalNotebook['interpreter'])
        : { state: 'idle' },
    revision: typeof raw.revision === 'number' && raw.revision >= 1 ? raw.revision : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
  };
}

export async function readGlobalNotebook(): Promise<GlobalNotebook> {
  return normalizeGlobalNotebook(await storage.readGlobalAmplifierNotebook());
}

async function writeGlobalNotebookUnlocked(notebook: GlobalNotebook): Promise<GlobalNotebook> {
  const next = { ...notebook, revision: notebook.revision + 1, updatedAt: nowIso() };
  await storage.writeGlobalAmplifierNotebook(next);
  return next;
}

export async function getAmplifierSettings(): Promise<{
  globalLearningEnabled: boolean;
  globalLearningResetAt: string | null;
}> {
  const notebook = await readGlobalNotebook();
  return {
    globalLearningEnabled: notebook.globalLearningEnabled,
    globalLearningResetAt: notebook.globalLearningResetAt,
  };
}

// NOTE: オン・オフAPIはグローバルmutex下でこのファイルを更新し、app-settingsへ二重保存しない
// （設計書 9.2）。オフ時も既存グローバルデータは削除しない（設計書 14.3）。
export async function updateAmplifierSettings(input: {
  globalLearningEnabled?: boolean;
}): Promise<{ globalLearningEnabled: boolean; globalLearningResetAt: string | null }> {
  if (input.globalLearningEnabled !== undefined && typeof input.globalLearningEnabled !== 'boolean') {
    throw new AmplifierGlobalError(
      'globalLearningEnabled は真偽値である必要があります。',
      'invalid_settings',
      false,
      400
    );
  }
  const notebook = await globalMutex.runExclusive('global-amplifier', async () => {
    const current = await readGlobalNotebook();
    const next: GlobalNotebook = {
      ...current,
      ...(input.globalLearningEnabled === undefined
        ? {}
        : { globalLearningEnabled: input.globalLearningEnabled }),
    };
    return writeGlobalNotebookUnlocked(next);
  });
  return {
    globalLearningEnabled: notebook.globalLearningEnabled,
    globalLearningResetAt: notebook.globalLearningResetAt,
  };
}

export async function getGlobalPreferences(): Promise<{ notebook: GlobalNotebook }> {
  return { notebook: await readGlobalNotebook() };
}

function normalizeAppliesTo(value: unknown): PreferenceAppliesTo {
  return value === 'roleplay' || value === 'mixed' ? value : 'novel';
}

export async function updateGlobalPreferences(input: {
  addCorrections?: Array<{ appliesTo: PreferenceAppliesTo; text: string }>;
  withdrawCorrectionIds?: string[];
  deleteMemoIds?: string[];
  globalBoundary?: string | null;
}): Promise<{ notebook: GlobalNotebook }> {
  const notebook = await globalMutex.runExclusive('global-amplifier', async () => {
    const current = await readGlobalNotebook();
    const now = nowIso();
    const corrections = [...current.corrections];
    const memos = [...current.memos];
    const revisions: Array<{
      scope: 'global';
      kind: 'correction_add' | 'correction_withdraw' | 'memo_delete';
      memoId?: string;
      correctionId?: string;
      beforeText?: string;
      afterText?: string;
    }> = [];

    for (const correctionInput of input.addCorrections ?? []) {
      const text = correctionInput.text.trim();
      if (!text || text.length > 2000) {
        throw new AmplifierGlobalError(
          '修正文は1〜2000文字にしてください。',
          'invalid_correction',
          false,
          400
        );
      }
      const correction: PreferenceCorrection = {
        correctionId: generateTimestampId('amp-corr'),
        scope: 'global',
        appliesTo: normalizeAppliesTo(correctionInput.appliesTo),
        text,
        status: 'active',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      corrections.push(correction);
      revisions.push({
        scope: 'global',
        kind: 'correction_add',
        correctionId: correction.correctionId,
        afterText: text,
      });
    }
    for (const correctionId of input.withdrawCorrectionIds ?? []) {
      const index = corrections.findIndex((candidate) => candidate.correctionId === correctionId);
      if (index >= 0 && corrections[index].status === 'active') {
        corrections[index] = {
          ...corrections[index],
          status: 'withdrawn',
          revision: corrections[index].revision + 1,
          updatedAt: now,
        };
        revisions.push({ scope: 'global', kind: 'correction_withdraw', correctionId });
      }
    }
    for (const memoId of input.deleteMemoIds ?? []) {
      const index = memos.findIndex((memo) => memo.memoId === memoId);
      if (index >= 0) {
        memos.splice(index, 1);
        revisions.push({ scope: 'global', kind: 'memo_delete', memoId });
      }
    }
    const next: GlobalNotebook = {
      ...current,
      memos,
      corrections,
      ...(input.globalBoundary === undefined
        ? {}
        : { globalBoundary: (input.globalBoundary ?? '').trim().slice(0, 2000) }),
    };
    const written = await writeGlobalNotebookUnlocked(next);
    for (const entry of revisions) {
      await storage.appendGlobalAmplifierNotebookRevision({
        revisionId: generateTimestampId('amp-noterev'),
        scope: 'global',
        kind: entry.kind,
        ...(entry.memoId ? { memoId: entry.memoId } : {}),
        ...(entry.correctionId ? { correctionId: entry.correctionId } : {}),
        ...(entry.beforeText !== undefined ? { beforeText: entry.beforeText } : {}),
        ...(entry.afterText !== undefined ? { afterText: entry.afterText } : {}),
        createdAt: now,
      });
    }
    return written;
  });
  return { notebook };
}

// NOTE: 全消去（設計書 13.4 DELETE）。メモ・Correction・版履歴・抽象観察を削除し、
// 現在の globalLearningEnabled と新しい reset 時刻を持つ空のノートを再作成する。
// オン・オフ状態は勝手に変えない。リセット時刻より前の観察から理解を復活させない。
export async function wipeGlobalPreferences(): Promise<{
  notebook: GlobalNotebook;
  resetAt: string;
}> {
  const result = await globalMutex.runExclusive('global-amplifier', async () => {
    const current = await readGlobalNotebook();
    const resetAt = nowIso();
    const fresh: GlobalNotebook = {
      ...createDefaultGlobalNotebook(),
      globalLearningEnabled: current.globalLearningEnabled,
      globalLearningResetAt: resetAt,
      revision: current.revision + 1,
    };
    await storage.writeGlobalAmplifierNotebook(fresh);
    await storage.clearGlobalAmplifierObservations();
    await storage.clearGlobalAmplifierNotebookRevisions();
    await storage.appendGlobalAmplifierNotebookRevision({
      revisionId: generateTimestampId('amp-noterev'),
      scope: 'global',
      kind: 'reset',
      note: 'グローバル理解の全消去',
      createdAt: resetAt,
    });
    return { notebook: fresh, resetAt };
  });
  return result;
}

export async function appendGlobalObservation(
  observation: AmplifierGlobalObservation
): Promise<void> {
  await globalMutex.runExclusive('global-amplifier', () =>
    storage.appendGlobalAmplifierObservation(observation)
  );
}

export async function readGlobalObservations(): Promise<AmplifierGlobalObservation[]> {
  return storage.readGlobalAmplifierObservations();
}

// NOTE: 生成プロンプト用の関連グローバルメモ。appliesTo が今回の形式（novel/roleplay）か
// mixed のものだけを返す（設計書 6.3 / 11.1）。
// グローバル学習がオフのときはメモとCorrectionを返さない（設計書 14.3）。境界は
// ハード境界であり学習状態と独立して常に適用するため返す。
export async function collectGlobalMemosForPrompt(mode: 'novel' | 'roleplay'): Promise<{
  memos: PreferenceMemo[];
  corrections: PreferenceCorrection[];
  boundary: string;
}> {
  const notebook = await readGlobalNotebook();
  if (!notebook.globalLearningEnabled) {
    return { memos: [], corrections: [], boundary: notebook.globalBoundary };
  }
  const memos = notebook.memos.filter(
    (memo) => memo.appliesTo === 'mixed' || memo.appliesTo === mode
  );
  const corrections = notebook.corrections.filter(
    (correction) =>
      correction.status === 'active' &&
      (correction.appliesTo === 'mixed' || correction.appliesTo === mode)
  );
  return { memos, corrections, boundary: notebook.globalBoundary };
}
