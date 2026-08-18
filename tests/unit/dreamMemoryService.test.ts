import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendDreamTrace,
  buildDreamResonancePack,
  browseDreamTraceEvents,
  deriveDreamClientEventId,
  DREAM_RECALL_COOLDOWN_MS,
  findDreamTraceByClientEventId,
  getDreamMemoryStatus,
  hashDreamContext,
  isDreamRecordingEnabled,
  readAllDreamTraceEvents,
  recordDreamWake,
  rewriteDreamTraceText,
  updateDreamMemorySettings,
  validateDreamResonancePack,
  __resetDreamMemoryCacheForTesting,
  wipeDreamMemory,
} from '../../src/server/services/dreamMemoryService';
import * as storage from '../../src/server/services/storageService';

async function baseEvent(overrides: Record<string, unknown> = {}) {
  return appendDreamTrace({
    projectId: 'proj-a',
    sessionId: 'sess-a',
    type: 'text',
    inputKind: 'text',
    rawText: overrides.rawText as string | undefined ?? '  鍵  ',
    anchor: {
      messageId: 'rm-1',
      contentRevision: 0,
      contextText: '石畳の隅で鍵が光っていた。',
    },
  });
}

beforeEach(async () => {
  await __resetDreamMemoryCacheForTesting();
  await storage.clearDreamTraceEvents();
  await storage.clearDreamRecallJournal();
  await updateDreamMemorySettings({
    recordingEnabled: true,
    disclosureAcknowledged: true,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __resetDreamMemoryCacheForTesting();
});

describe('dreamMemoryService append', () => {
  it('appends an event with a monotonically increasing sequence', async () => {
    const first = await baseEvent();
    const second = await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'observe',
      inputKind: 'observe',
      anchor: { messageId: 'rm-2', contentRevision: 0, contextText: '雨が続いている。' },
    });
    expect(first).toMatchObject({ sequence: 1, type: 'text', rawText: '  鍵  ' });
    expect(second).toMatchObject({ sequence: 2, type: 'observe' });
    expect(second?.rawText).toBeUndefined();
  });

  it('keeps rawText exactly as sent (no trim, no summary, no rewrite) (AC12)', async () => {
    const event = await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'text',
      inputKind: 'text',
      rawText: '  鍵を拾って、 光に透かす。  ',
      anchor: { messageId: 'rm-1', contentRevision: 0, contextText: '夜道。' },
    });
    expect(event?.rawText).toBe('  鍵を拾って、 光に透かす。  ');
    expect(event?.anchor.contextText).toBe('夜道。');
    expect(event?.anchor.contextHash).toBe(hashDreamContext('夜道。'));
  });

  it('is idempotent for the same clientEventId (AC13)', async () => {
    const first = await baseEvent();
    const second = await baseEvent();
    expect(second?.eventId).toBe(first?.eventId);
    const all = await readAllDreamTraceEvents();
    expect(all).toHaveLength(1);
  });

  it('does not record while recording is paused (AC19)', async () => {
    await updateDreamMemorySettings({ recordingEnabled: false });
    const event = await baseEvent();
    expect(event).toBeNull();
    expect(await readAllDreamTraceEvents()).toHaveLength(0);
    expect(await isDreamRecordingEnabled()).toBe(false);
  });

  it('records wake with the revision-derived idempotent clientEventId', async () => {
    const wake = await recordDreamWake({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      revision: 7,
      contextText: '灯台の光が消えた。',
      messageId: 'rm-9',
    });
    expect(wake).toMatchObject({ type: 'wake', clientEventId: 'dm-wake-sess-a-7' });
    const again = await recordDreamWake({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      revision: 7,
      contextText: '灯台の光が消えた。',
    });
    expect(again?.eventId).toBe(wake?.eventId);
  });

  it('derives a deterministic clientEventId from session and message ids', () => {
    expect(deriveDreamClientEventId('sess-a', 'rm-1')).toBe('dm-sess-a-rm-1');
  });

  it('exposes events for browse/export and wipes everything (AC17)', async () => {
    await baseEvent();
    const status = await getDreamMemoryStatus();
    expect(status.eventCount).toBe(1);
    const browse = await browseDreamTraceEvents();
    expect(browse.total).toBe(1);
    await wipeDreamMemory();
    expect(await readAllDreamTraceEvents()).toHaveLength(0);
    expect(await findDreamTraceByClientEventId(deriveDreamClientEventId('sess-a', 'rm-1'))).toBeNull();
    expect(await fs.readFile(storage.dreamTraceEventsPath(), 'utf-8')).toBe('');
  });

  // NOTE: P1-2（AC17）: 全消去より前に作られた入力の backfill を拒否し、古いセッションから
  // 生記憶が自動復活しない。wipe 後の新規入力は通常どおり記録される。
  it('rejects appending an input created before the last wipe (no resurrection)', async () => {
    await baseEvent();
    await wipeDreamMemory();

    const resurrected = await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'text',
      inputKind: 'text',
      rawText: '鍵',
      anchor: { messageId: 'rm-old', contentRevision: 0, contextText: '夜道。' },
      messageCreatedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(resurrected).toBeNull();

    const fresh = await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'text',
      inputKind: 'text',
      rawText: '新しい言葉',
      anchor: { messageId: 'rm-new', contentRevision: 0, contextText: '朝。' },
      messageCreatedAt: new Date().toISOString(),
    });
    expect(fresh).toMatchObject({ rawText: '新しい言葉', sequence: 1 });
  });

  // NOTE: P1-3: 失敗後の訂正（replace）を生記憶へ反映し、同じ内容なら変更しない。
  it('rewrites the rawText of an existing trace when corrected', async () => {
    await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'text',
      inputKind: 'text',
      rawText: '鍵を拾う',
      anchor: { messageId: 'rm-1', contentRevision: 0, contextText: '石畳。' },
    });
    const rewritten = await rewriteDreamTraceText({
      sessionId: 'sess-a',
      messageId: 'rm-1',
      type: 'text',
      rawText: '鍵を拾って、光に透かす',
      contentRevision: 0,
    });
    expect(rewritten).toMatchObject({ rawText: '鍵を拾って、光に透かす' });
    // sequence は維持され、イベントは1件のまま（二重記録しない）
    expect(rewritten?.sequence).toBe(1);
    expect(await readAllDreamTraceEvents()).toHaveLength(1);
    // 同一内容の再送では変更しない
    const again = await rewriteDreamTraceText({
      sessionId: 'sess-a',
      messageId: 'rm-1',
      type: 'text',
      rawText: '鍵を拾って、光に透かす',
      contentRevision: 0,
    });
    expect(again?.eventId).toBe(rewritten?.eventId);
  });

  it('returns null from rewrite when the trace does not exist (append path handles it)', async () => {
    const result = await rewriteDreamTraceText({
      sessionId: 'sess-a',
      messageId: 'rm-missing',
      type: 'text',
      rawText: 'x',
    });
    expect(result).toBeNull();
  });

  it('rewrites the input kind and clears stale text when corrected to observe', async () => {
    await baseEvent({ rawText: '扉を開ける' });
    const observed = await rewriteDreamTraceText({
      sessionId: 'sess-a',
      messageId: 'rm-1',
      type: 'observe',
      contentRevision: 1,
    });
    expect(observed).toMatchObject({ type: 'observe' });
    expect(observed?.rawText).toBeUndefined();

    const written = await rewriteDreamTraceText({
      sessionId: 'sess-a',
      messageId: 'rm-1',
      type: 'text',
      rawText: '窓を見る',
      contentRevision: 2,
    });
    expect(written).toMatchObject({ type: 'text', rawText: '窓を見る' });
  });

  // NOTE: P1-1: 一時停止・全消去後はメモ化された pack も無効と判定される。
  it('invalidates a cached resonance pack after pause or wipe', async () => {
    await appendDreamTrace({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      type: 'text',
      inputKind: 'text',
      rawText: '海',
      anchor: { messageId: 'rm-1', contentRevision: 0, contextText: '波の音。' },
    });
    const pack = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      currentTexts: ['海'],
    });
    expect(pack.events.length).toBeGreaterThan(0);
    expect(await validateDreamResonancePack(pack)).toBe(true);

    await updateDreamMemorySettings({ recordingEnabled: false });
    expect(await validateDreamResonancePack(pack)).toBe(false);

    await updateDreamMemorySettings({ recordingEnabled: true });
    await wipeDreamMemory();
    expect(await validateDreamResonancePack(pack)).toBe(false);
  });

  it('serializes an in-flight append before wipe so deleted memory cannot land afterward', async () => {
    const originalAppend = storage.appendDreamTraceEvent;
    let releaseAppend!: () => void;
    let notifyAppendStarted!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      notifyAppendStarted = resolve;
    });
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    vi.spyOn(storage, 'appendDreamTraceEvent').mockImplementation(async (event) => {
      notifyAppendStarted();
      await appendGate;
      await originalAppend(event);
    });

    const appendPromise = baseEvent();
    await appendStarted;
    let wipeFinished = false;
    const wipePromise = wipeDreamMemory().then(() => {
      wipeFinished = true;
    });
    await Promise.resolve();
    expect(wipeFinished).toBe(false);

    releaseAppend();
    await Promise.all([appendPromise, wipePromise]);
    expect(await readAllDreamTraceEvents()).toHaveLength(0);
    expect(await fs.readFile(storage.dreamTraceEventsPath(), 'utf-8')).toBe('');
  });
});

describe('dreamMemoryService resonance pack', () => {
  async function seedSession(
    sessionId: string,
    projectId: string,
    rows: Array<{ type: 'text' | 'observe'; rawText?: string; contextText: string; messageId: string }>,
    createdAtShiftMs = 0
  ): Promise<void> {
    for (const row of rows) {
      await appendDreamTrace({
        projectId,
        sessionId,
        type: row.type,
        inputKind: row.type,
        rawText: row.rawText,
        anchor: { messageId: row.messageId, contentRevision: 0, contextText: row.contextText },
      });
    }
    if (createdAtShiftMs) {
      // NOTE: 時系列をテストで制御するため、保存後に createdAt を古い順へ並べ直して
      // ファイルを書き直し、キャッシュを無効化する。
      const all = await readAllDreamTraceEvents();
      await storage.clearDreamTraceEvents();
      for (let index = 0; index < all.length; index += 1) {
        const entry = all[index];
        await storage.appendDreamTraceEvent({
          ...entry,
          createdAt: new Date(
            new Date(entry.createdAt).getTime() - createdAtShiftMs * (all.length - index)
          ).toISOString(),
        });
      }
      await __resetDreamMemoryCacheForTesting();
    }
  }

  it('picks recent + repeated + oldest (3 baseline) and excludes the current session', async () => {
    await seedSession('sess-old', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
      { type: 'observe', rawText: undefined, contextText: '何も起きない夜。', messageId: 'rm-2' },
      { type: 'text', rawText: '海のにおい', contextText: '浜辺に立っていた。', messageId: 'rm-3' },
    ]);
    const pack = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-current',
      currentTexts: ['海辺の夢'],
    });
    expect(pack.events.length).toBeGreaterThanOrEqual(3);
    expect(pack.events.length).toBeLessThanOrEqual(5);
    for (const event of pack.events) {
      expect(event.sessionId).not.toBe('sess-current');
    }
    // 語句の重なり（海）を含む event が入っているはず
    expect(pack.events.some((event) => event.rawText?.includes('海'))).toBe(true);
  });

  it('does not reuse the same event within the cooldown window (AC18)', async () => {
    await seedSession('sess-a', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
      { type: 'text', rawText: '山', contextText: '霧の中。', messageId: 'rm-2' },
      { type: 'text', rawText: '道', contextText: '石畳。', messageId: 'rm-3' },
      { type: 'text', rawText: '空', contextText: '雲が動く。', messageId: 'rm-4' },
      { type: 'text', rawText: '月', contextText: '静かな光。', messageId: 'rm-5' },
      { type: 'text', rawText: '星', contextText: '瞬いている。', messageId: 'rm-6' },
    ]);
    const first = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b1',
      currentTexts: ['海'],
    });
    expect(first.events.length).toBeGreaterThanOrEqual(3);
    const second = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b2',
      currentTexts: ['海'],
    });
    const firstIds = new Set(first.events.map((event) => event.eventId));
    const secondIds = new Set(second.events.map((event) => event.eventId));
    // cooldown 内なので共通の event を再利用しない
    expect([...firstIds].filter((id) => secondIds.has(id))).toHaveLength(0);
  });

  it('serializes concurrent pack selection so two sessions do not recall the same event', async () => {
    await seedSession('sess-a', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
      { type: 'text', rawText: '山', contextText: '霧の中。', messageId: 'rm-2' },
      { type: 'text', rawText: '道', contextText: '石畳。', messageId: 'rm-3' },
      { type: 'text', rawText: '空', contextText: '雲が動く。', messageId: 'rm-4' },
      { type: 'text', rawText: '月', contextText: '静かな光。', messageId: 'rm-5' },
      { type: 'text', rawText: '星', contextText: '瞬いている。', messageId: 'rm-6' },
    ]);
    const [first, second] = await Promise.all([
      buildDreamResonancePack({
        projectId: 'proj-b',
        sessionId: 'sess-concurrent-1',
        currentTexts: ['海'],
      }),
      buildDreamResonancePack({
        projectId: 'proj-b',
        sessionId: 'sess-concurrent-2',
        currentTexts: ['海'],
      }),
    ]);
    const firstIds = new Set(first.events.map((event) => event.eventId));
    expect(first.events.length).toBeGreaterThan(0);
    expect(second.events.length).toBeGreaterThan(0);
    expect(second.events.filter((event) => firstIds.has(event.eventId))).toHaveLength(0);
  });

  it('returns an empty pack when all events are on cooldown', async () => {
    await seedSession('sess-a', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
      { type: 'text', rawText: '山', contextText: '霧の中。', messageId: 'rm-2' },
      { type: 'text', rawText: '道', contextText: '石畳。', messageId: 'rm-3' },
    ]);
    const first = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b1',
      currentTexts: ['海'],
    });
    expect(first.events.length).toBeGreaterThanOrEqual(3);
    const second = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b2',
      currentTexts: ['海'],
    });
    expect(second.events).toHaveLength(0);
  });

  // NOTE: P2-1: cooldown が切れたイベントが再想起されると recalledAt が更新され、以後も
  // cooldown が機能し続ける。単純な eventId 重複スキップだと再想起時に時刻が更新されず、
  // 二度目以降の想起で cooldown が効かなくなる。
  it('refreshes the cooldown when an event is recalled again after expiry', async () => {
    await seedSession(
      'sess-a',
      'proj-a',
      [
        { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
        { type: 'text', rawText: '山', contextText: '霧の中。', messageId: 'rm-2' },
        { type: 'text', rawText: '道', contextText: '石畳。', messageId: 'rm-3' },
        { type: 'text', rawText: '空', contextText: '雲が動く。', messageId: 'rm-4' },
        { type: 'text', rawText: '月', contextText: '静かな光。', messageId: 'rm-5' },
        { type: 'text', rawText: '星', contextText: '瞬いている。', messageId: 'rm-6' },
      ],
      60 * 60 * 1000
    );

    // 1回目の想起（cooldown なし）: 直近（星）/ 語句一致（海）/ 最古（山）
    const first = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b1',
      currentTexts: ['海'],
    });
    expect(first.events.map((event) => event.rawText).sort()).toEqual(
      ['海', '山', '星'].sort()
    );

    // journal を cooldown 窓の外へ期限切れさせる（時間経過の代わり）
    const journal = await storage.readDreamRecallJournal();
    const expired = journal.map((entry) => ({
      ...entry,
      recalledAt: new Date(
        Date.now() - DREAM_RECALL_COOLDOWN_MS - 60 * 1000
      ).toISOString(),
    }));
    await storage.clearDreamRecallJournal();
    for (const entry of expired) await storage.appendDreamRecallJournalEntry(entry as never);

    // 2回目の想起: 同じ 3 件が再び選ばれ、journal の recalledAt が新しくなる
    const second = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b2',
      currentTexts: ['海'],
    });
    expect(second.events.map((event) => event.rawText).sort()).toEqual(
      ['海', '山', '星'].sort()
    );

    // 3回目の想起: 2回目で再想起した 3 件は cooldown 中なので、別の 3 件だけが選ばれる
    const third = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b3',
      currentTexts: ['海'],
    });
    const secondIds = new Set(second.events.map((event) => event.eventId));
    const thirdIds = new Set(third.events.map((event) => event.eventId));
    expect([...secondIds].filter((id) => thirdIds.has(id))).toHaveLength(0);
  });

  // NOTE: P2-2: 日本語は空白が無いため語単位のトークン化では短いモチーフが長文内で一致
  // しない。漢字1文字のモチーフが過去の長い文章と一致して選ばれることを確認する。
  it('matches a one-kanji motif against a longer past text (P2)', async () => {
    await seedSession('sess-a', 'proj-a', [
      {
        type: 'text',
        rawText: '　鍵を拾って、 光に透かしてみた。 誰かの落とし物だった。  ',
        contextText: '石畳の路地に立っていた。',
        messageId: 'rm-1',
      },
    ]);
    const pack = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      currentTexts: ['鍵'],
    });
    expect(pack.events.length).toBeGreaterThan(0);
    expect(pack.events[0].rawText).toContain('鍵');
  });

  it('returns an empty pack while recording is paused (AC19)', async () => {
    await seedSession('sess-a', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
    ]);
    await updateDreamMemorySettings({ recordingEnabled: false });
    const pack = await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      currentTexts: ['海'],
    });
    expect(pack.events).toHaveLength(0);
  });

  it('treats the recall journal as auxiliary: wipe clears it too', async () => {
    await seedSession('sess-a', 'proj-a', [
      { type: 'text', rawText: '海', contextText: '波の音。', messageId: 'rm-1' },
    ]);
    await buildDreamResonancePack({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      currentTexts: ['海'],
    });
    const journal = await fs.readFile(storage.dreamRecallJournalPath(), 'utf-8');
    expect(journal.trim().length).toBeGreaterThan(0);
    await wipeDreamMemory();
    expect(await fs.readFile(storage.dreamRecallJournalPath(), 'utf-8')).toBe('');
  });
});
