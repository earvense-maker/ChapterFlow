// 夢見るモードの生の選択記憶（docs/design/夢見るモード_MVP設計書.md §5）
//
// NOTE: 保存の正本は「そのとき、その情景に対して、実際に何を書いたか / 何も書かず眺めたか」
// だけ。rawText は trim・要約・書き換えをせず、クライアントが送った文字列をそのまま保存する。
// 生ログ（trace-events.jsonl）が正本で、recall-journal と起動中キャッシュは再構築可能な
// 補助データ。想起時に JSONL 全件を毎回読まないため、起動中キャッシュを使う（設計書 §14）。
//
// 冪等性: clientEventId が同じ追記は二重に書かない。roleplay session の user message 保存と
// trace 追記は別ファイルのため中途失敗が起こるが、messageId / clientEventId の冪等性と
// 再試行（regenerate 時の backfill）で収束させる（設計書 §5 / §14）。

import { createHash } from 'node:crypto';
import { KeyedMutex } from '../utils/keyedMutex.js';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type {
  DreamInputKind,
  DreamMemorySettings,
  DreamMemoryUpdateBody,
  DreamResonancePack,
  DreamTraceEvent,
  DreamTraceEventType,
} from '../types/index.js';

const memoryMutex = new KeyedMutex();
// NOTE: trace・journal・settings は相互に同じ整合性境界を持つ。用途別のキーに分けると、
// 全消去と追記が並走して DELETE 完了後に古いイベントが着地しうるため、単一キーで直列化する。
const DREAM_MEMORY_LOCK_KEY = 'dream-memory';

// NOTE: 起動中キャッシュ。JSONL 全件読みを毎回避ける（設計書 §14）。消去 API はキャッシュも
// 空にする。テスト用リセットは __resetDreamMemoryCacheForTesting で行う。
let cachedEvents: DreamTraceEvent[] | null = null;
let cachedSettings: DreamMemorySettings | null = null;

// NOTE: 同じ古い event を短期間に何度も残響として使わないための窓（設計書 §5 / AC18）。
export const DREAM_RECALL_COOLDOWN_MS = 30 * 60 * 1000;
// NOTE: 一度の pack に含める上限（設計書 §5: 3〜5件）。cooldown により 3 件未満になることは
// 許容する（AC18 を優先し、残響なしでも prompt は成立する）。
export const DREAM_RESONANCE_PACK_MAX = 5;
export const DREAM_RESONANCE_PACK_MIN = 3;
// NOTE: 閲覧 API で返す最新件数（全件は書き出し API の責務）。
export const DREAM_BROWSE_LIMIT = 200;

export class DreamMemoryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number
  ) {
    super(message);
    this.name = 'DreamMemoryError';
  }
}

function normalizeContextText(value: string): string {
  // NOTE: contextText も閲覧・書き出し対象の生データ。改行コードを含め、保存時に変形しない。
  return value;
}

export function hashDreamContext(text: string): string {
  return createHash('sha256').update(normalizeContextText(text)).digest('hex');
}

async function readAllEvents(): Promise<DreamTraceEvent[]> {
  if (cachedEvents === null) {
    cachedEvents = await storage.readDreamTraceEvents();
  }
  return cachedEvents;
}

export async function __resetDreamMemoryCacheForTesting(): Promise<void> {
  cachedEvents = null;
  cachedSettings = null;
}

// ===== 設定 =====

function defaultDreamMemorySettings(): DreamMemorySettings {
  return {
    schemaVersion: 1,
    recordingEnabled: true,
    disclosureAcknowledged: false,
    wipedAt: null,
    updatedAt: nowIso(),
  };
}

function normalizeDreamMemorySettings(value: DreamMemorySettings | null): DreamMemorySettings {
  if (!value || typeof value !== 'object') return defaultDreamMemorySettings();
  const now = nowIso();
  return {
    schemaVersion: 1,
    recordingEnabled:
      typeof value.recordingEnabled === 'boolean' ? value.recordingEnabled : true,
    disclosureAcknowledged:
      typeof value.disclosureAcknowledged === 'boolean' ? value.disclosureAcknowledged : false,
    wipedAt: typeof value.wipedAt === 'string' ? value.wipedAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : now,
  };
}

function dreamMemoryStateToken(settings: DreamMemorySettings): string {
  return `${settings.recordingEnabled ? 'on' : 'off'}:${
    settings.disclosureAcknowledged ? 'ack' : 'unack'
  }:${settings.wipedAt ?? 'never'}`;
}

function nextDreamTraceSequence(events: DreamTraceEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
}

export async function readDreamMemorySettings(): Promise<DreamMemorySettings> {
  if (cachedSettings === null) {
    cachedSettings = normalizeDreamMemorySettings(await storage.readDreamMemorySettings());
  }
  return cachedSettings;
}

export async function updateDreamMemorySettings(
  input: DreamMemoryUpdateBody
): Promise<DreamMemorySettings> {
  if (
    input.recordingEnabled !== undefined &&
    typeof input.recordingEnabled !== 'boolean'
  ) {
    throw new DreamMemoryError(
      'recordingEnabled は真偽値である必要があります。',
      'invalid_settings',
      false,
      400
    );
  }
  if (
    input.disclosureAcknowledged !== undefined &&
    typeof input.disclosureAcknowledged !== 'boolean'
  ) {
    throw new DreamMemoryError(
      'disclosureAcknowledged は真偽値である必要があります。',
      'invalid_settings',
      false,
      400
    );
  }
  const next = await memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    const current = await readDreamMemorySettings();
    const updated: DreamMemorySettings = {
      ...current,
      ...(input.recordingEnabled === undefined
        ? {}
        : { recordingEnabled: input.recordingEnabled }),
      ...(input.disclosureAcknowledged === undefined
        ? {}
        : { disclosureAcknowledged: input.disclosureAcknowledged }),
      updatedAt: nowIso(),
    };
    await storage.writeDreamMemorySettings(updated);
    cachedSettings = updated;
    return updated;
  });
  return next;
}

// NOTE: 一時停止中は新規記録だけでなく、過去記憶の prompt 送信も行わない（設計書 §5）。
export async function isDreamRecordingEnabled(): Promise<boolean> {
  return (await readDreamMemorySettings()).recordingEnabled;
}

// ===== 追記（冪等） =====

export interface AppendDreamTraceInput {
  projectId: string;
  sessionId: string;
  type: Exclude<DreamTraceEventType, 'wake'>;
  inputKind: DreamInputKind;
  rawText?: string;
  anchor: {
    messageId?: string;
    contentRevision?: number;
    contextText: string;
  };
  // NOTE: 対応する user message の作成時刻。全消去（wipedAt）より前に作られた入力を
  // backfill 経路で復活させないための判定に使う（AC17）。
  messageCreatedAt?: string;
}

// NOTE: 停止・全消去・一時停止をまたいでも同じ clientEventId の二重追記を防ぐための
// 派生。appendDreamTrace と同一規則。
export function deriveDreamClientEventId(sessionId: string, messageId: string): string {
  return `dm-${sessionId}-${messageId}`;
}

// NOTE: 失敗後の訂正（replacePendingMessageId）を生記憶へ反映する（設計書 §5 / AC12）。
// 同じ messageId の trace が既にあれば、type と rawText を訂正後の内容へ置き換える。訂正は
// 稀な操作なので JSONL 全件の原子的な書き換えコストを許容し、イベントの sequence と位置は
// 維持する（再試行でも冪等）。
// 既存 trace が無い場合は null を返し、呼び出し側が通常の append 経路で補う。
export async function rewriteDreamTraceText(input: {
  sessionId: string;
  messageId: string;
  type: Exclude<DreamTraceEventType, 'wake'>;
  rawText?: string;
  contentRevision?: number;
}): Promise<DreamTraceEvent | null> {
  return memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    const settings = await readDreamMemorySettings();
    if (!settings.recordingEnabled || !settings.disclosureAcknowledged) return null;
    const clientEventId = deriveDreamClientEventId(input.sessionId, input.messageId);
    const existing = await findEventByClientId(clientEventId);
    if (!existing) return null;
    const nextRawText = input.type === 'text' ? input.rawText : undefined;
    const nextContentRevision =
      input.contentRevision === undefined
        ? existing.anchor.contentRevision
        : input.contentRevision;
    if (
      existing.type === input.type &&
      existing.rawText === nextRawText &&
      (existing.anchor.contentRevision ?? 0) === (nextContentRevision ?? 0)
    ) {
      return existing;
    }
    const events = await readAllEvents();
    const { rawText: _previousRawText, ...existingWithoutRawText } = existing;
    const next: DreamTraceEvent = {
      ...existingWithoutRawText,
      type: input.type,
      ...(nextRawText === undefined ? {} : { rawText: nextRawText }),
      anchor: {
        ...existing.anchor,
        ...(nextContentRevision === undefined
          ? {}
          : { contentRevision: nextContentRevision }),
      },
    };
    // NOTE: 「除去してから追記」の二段階にすると、間でプロセスが終了した際に正本を失う。
    // 元の位置で置換した全件を safeWriteFile へ一度だけ渡し、順序も維持する。
    const rewritten = events.map((event) => (event.eventId === existing.eventId ? next : event));
    await storage.rewriteDreamTraceEvents(rewritten);
    cachedEvents = rewritten;
    return next;
  });
}

async function findEventByClientId(clientEventId: string): Promise<DreamTraceEvent | null> {
  const events = await readAllEvents();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].clientEventId === clientEventId) return events[index];
  }
  return null;
}

export async function findDreamTraceByClientEventId(
  clientEventId: string
): Promise<DreamTraceEvent | null> {
  return findEventByClientId(clientEventId);
}

// NOTE: セッション単位でメモ化された残響 pack が、現在の記憶状態でも使ってよいかを
// 検証する（P1）。一時停止中は過去記憶の prompt 送信自体を行わない（AC19）ため false。
// 全消去されたイベントが含まれる場合も false とし、呼び出し側が再構築（全消去後は空）へ
// 落とす（AC17: 古いセッションから自動復活しない）。
export async function validateDreamResonancePack(pack: DreamResonancePack): Promise<boolean> {
  return memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    const settings = await readDreamMemorySettings();
    if (!settings.recordingEnabled || !settings.disclosureAcknowledged) return false;
    if (pack.memoryStateToken !== dreamMemoryStateToken(settings)) return false;
    if (pack.events.length === 0) return true;
    const events = await readAllEvents();
    const currentById = new Map(events.map((event) => [event.eventId, event]));
    return pack.events.every((event) => {
      const current = currentById.get(event.eventId);
      return (
        current?.type === event.type &&
        current?.rawText === event.rawText &&
        current?.anchor.contextHash === event.anchor.contextHash &&
        (current?.anchor.contentRevision ?? 0) === (event.anchor.contentRevision ?? 0)
      );
    });
  });
}

export async function appendDreamTrace(input: AppendDreamTraceInput): Promise<DreamTraceEvent | null> {
  return memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    const settings = await readDreamMemorySettings();
    if (!settings.recordingEnabled || !settings.disclosureAcknowledged) return null;
    const clientEventId = input.anchor.messageId
      ? deriveDreamClientEventId(input.sessionId, input.anchor.messageId)
      : '';
    if (!clientEventId) return null;
    const existing = await findEventByClientId(clientEventId);
    if (existing) return existing;

    // NOTE: 全消去より前に作られた入力は復活させない（AC17）。roleplay session の運用
    // コピーが残っていても、生記憶（正本）へは戻さない。
    if (
      settings.wipedAt &&
      input.messageCreatedAt &&
      input.messageCreatedAt < settings.wipedAt
    ) {
      return null;
    }

    const events = await readAllEvents();
    const now = nowIso();
    const sequence = nextDreamTraceSequence(events);
    const contextText = normalizeContextText(input.anchor.contextText);
    const event: DreamTraceEvent = {
      schemaVersion: 1,
      eventId: generateTimestampId('dmtr'),
      clientEventId,
      sequence,
      projectId: input.projectId,
      sessionId: input.sessionId,
      type: input.type,
      ...(input.type === 'text' && typeof input.rawText === 'string'
        ? { rawText: input.rawText }
        : {}),
      anchor: {
        ...(input.anchor.messageId ? { messageId: input.anchor.messageId } : {}),
        ...(input.anchor.contentRevision !== undefined
          ? { contentRevision: input.anchor.contentRevision }
          : {}),
        contextText,
        contextHash: hashDreamContext(contextText),
      },
      createdAt: now,
    };
    await storage.appendDreamTraceEvent(event);
    cachedEvents = [...events, event];
    return event;
  });
}

// NOTE: 目覚める（wake）の行動記録（設計書 §5）。どの情景で夢を終えたかを残す。archived
// セッションの messageId は messageId で紐づけ、clientEventId は archive のたびに決定的に
// 変わる（sessionId + revision）ので再送で重複しない。
export async function recordDreamWake(input: {
  projectId: string;
  sessionId: string;
  revision: number;
  contextText: string;
  messageId?: string;
  actionCreatedAt?: string;
}): Promise<DreamTraceEvent | null> {
  return memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    const settings = await readDreamMemorySettings();
    if (!settings.recordingEnabled || !settings.disclosureAcknowledged) return null;
    if (settings.wipedAt && input.actionCreatedAt && input.actionCreatedAt < settings.wipedAt) {
      return null;
    }
    const clientEventId = `dm-wake-${input.sessionId}-${input.revision}`;
    const existing = await findEventByClientId(clientEventId);
    if (existing) return existing;
    const events = await readAllEvents();
    const sequence = nextDreamTraceSequence(events);
    const contextText = normalizeContextText(input.contextText);
    const event: DreamTraceEvent = {
      schemaVersion: 1,
      eventId: generateTimestampId('dmtr'),
      clientEventId,
      sequence,
      projectId: input.projectId,
      sessionId: input.sessionId,
      type: 'wake',
      anchor: {
        ...(input.messageId ? { messageId: input.messageId } : {}),
        contextText,
        contextHash: hashDreamContext(contextText),
      },
      createdAt: input.actionCreatedAt ?? nowIso(),
    };
    await storage.appendDreamTraceEvent(event);
    cachedEvents = [...events, event];
    return event;
  });
}

// ===== 閲覧・書き出し・全消去 =====

export async function readAllDreamTraceEvents(): Promise<DreamTraceEvent[]> {
  return [...(await readAllEvents())];
}

export async function getDreamMemoryStatus(): Promise<{
  settings: DreamMemorySettings;
  eventCount: number;
}> {
  const [settings, events] = await Promise.all([readDreamMemorySettings(), readAllEvents()]);
  return { settings, eventCount: events.length };
}

export async function browseDreamTraceEvents(limit = DREAM_BROWSE_LIMIT): Promise<{
  events: DreamTraceEvent[];
  total: number;
}> {
  const events = await readAllEvents();
  const total = events.length;
  const head = events.slice(-Math.max(1, Math.floor(limit)));
  return { events: head, total };
}

// NOTE: 全消去（設計書 §5 / AC17）。生ログと journal を空にし、キャッシュも無効化する。
// 全消去後は古い project や session から自動復活しない（キャッシュを残さない + wipedAt より
// 前の入力の backfill を拒否する）。
export async function wipeDreamMemory(): Promise<void> {
  await memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, async () => {
    await storage.clearDreamTraceEvents();
    await storage.clearDreamRecallJournal();
    cachedEvents = [];
    const wipedAt = nowIso();
    const settings = { ...(await readDreamMemorySettings()), wipedAt, updatedAt: wipedAt };
    await storage.writeDreamMemorySettings(settings);
    cachedSettings = settings;
  });
}

// ===== 想起（残響 pack） =====

// NOTE: 表層の語句比較用トークン化。日本語は空白が無いため `[\p{L}\p{N}]+` のままでは
// 「鍵を拾う」のような文全体が1トークンになり、短いモチーフ（鍵・海・糸）が長文の中で
// 一致しない（P2）。そこで:
//  - 漢字は意味を持つモチーフ単位として1文字ずつ。
//  - かな連続は2文字の連接（「しばらく」→ しば/ばら/らく）。単独かなは雑音になるため対象外。
//  - ラテン・数字列は語全体を1トークン（"key" はそのまま）。
function surfaceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ');
  for (const match of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!/[\u4e00-\u9fff\u3040-\u30ff]/.test(match)) {
      tokens.add(match);
      continue;
    }
    for (const char of match) {
      if (/[\u4e00-\u9fff]/.test(char)) tokens.add(char);
    }
    for (const run of match.match(/[\u3040-\u30ff]+/g) ?? []) {
      for (let index = 0; index < run.length - 1; index += 1) {
        tokens.add(run.slice(index, index + 2));
      }
    }
  }
  return tokens;
}

function tokenOverlapCount(text: string, tokens: Set<string>): number {
  const own = surfaceTokens(text);
  let count = 0;
  for (const token of own) {
    if (tokens.has(token)) count += 1;
  }
  return count;
}

function bySequenceDesc(a: DreamTraceEvent, b: DreamTraceEvent): number {
  return b.sequence - a.sequence;
}

// NOTE: 各セッション開始時に決定的に選ぶ 3〜5 件（設計書 §5）。選ばれた eventId は
// recall-journal へ記録し、cooldown 中は再利用しない（AC18）。すべて cooldown 中なら
// 空 pack を返す（prompt 側は残響なしで成立する）。
export async function buildDreamResonancePack(input: {
  projectId: string;
  sessionId: string;
  currentTexts: string[];
}): Promise<DreamResonancePack> {
  return memoryMutex.runExclusive(DREAM_MEMORY_LOCK_KEY, () =>
    buildDreamResonancePackUnlocked(input)
  );
}

async function buildDreamResonancePackUnlocked(input: {
  projectId: string;
  sessionId: string;
  currentTexts: string[];
}): Promise<DreamResonancePack> {
  const settings = await readDreamMemorySettings();
  const memoryStateToken = dreamMemoryStateToken(settings);
  if (!settings.recordingEnabled || !settings.disclosureAcknowledged) {
    return { schemaVersion: 1, events: [], createdAt: nowIso(), memoryStateToken };
  }

  const candidates = (await readAllEvents())
    .filter((event) => event.sessionId !== input.sessionId)
    .sort(bySequenceDesc);

  const journal = await storage.readDreamRecallJournal();
  const cutoff = Date.now() - DREAM_RECALL_COOLDOWN_MS;
  const recentlyRecalled = new Set(
    journal
      .filter((entry) => new Date(entry.recalledAt).getTime() >= cutoff)
      .map((entry) => entry.eventId)
  );

  const currentTokens = new Set<string>();
  for (const text of input.currentTexts) {
    for (const token of surfaceTokens(text)) currentTokens.add(token);
  }

  const picked: DreamTraceEvent[] = [];
  const pickedIds = new Set<string>();
  const pick = (event: DreamTraceEvent | undefined) => {
    if (!event || pickedIds.has(event.eventId)) return;
    picked.push(event);
    pickedIds.add(event.eventId);
  };

  // 1. 直近の夢から 1 件（cooldown 中なら次に新しいものから）
  for (const event of candidates) {
    if (recentlyRecalled.has(event.eventId)) continue;
    pick(event);
    break;
  }

  // 2. 表層上同じ語句や操作が繰り返された記録から 1 件
  if (picked.length < DREAM_RESONANCE_PACK_MAX) {
    let best: DreamTraceEvent | undefined;
    let bestScore = 0;
    for (const event of candidates) {
      if (recentlyRecalled.has(event.eventId) || pickedIds.has(event.eventId)) continue;
      const score = tokenOverlapCount(
        [event.rawText, event.anchor.contextText].filter(Boolean).join('\n'),
        currentTokens
      );
      if (score > bestScore) {
        bestScore = score;
        best = event;
      }
    }
    if (!best) {
      // NOTE: 語句の重なりが無くても、「観察（眺める）」という操作の反復は残響になりうる。
      // 直近の observe を繰り返し操作の代表として使う（設計書 §7 深度の階段・共鳴）。
      best = candidates.find(
        (event) => event.type === 'observe' && !recentlyRecalled.has(event.eventId)
      );
    }
    pick(best);
  }

  // 3. 長い間、夢に戻されていない古い記録から 1 件
  if (picked.length < DREAM_RESONANCE_PACK_MAX) {
    const oldest = [...candidates]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .find((event) => !recentlyRecalled.has(event.eventId) && !pickedIds.has(event.eventId));
    pick(oldest);
  }

  // 4. 現在の夢の語句と文字列上の重なりがある記録（上で拾えなかった別の 1 件）
  if (picked.length < DREAM_RESONANCE_PACK_MAX) {
    let best: DreamTraceEvent | undefined;
    let bestScore = 0;
    for (const event of candidates) {
      if (recentlyRecalled.has(event.eventId) || pickedIds.has(event.eventId)) continue;
      const score = tokenOverlapCount(
        [event.rawText, event.anchor.contextText].filter(Boolean).join('\n'),
        currentTokens
      );
      if (score > bestScore) {
        bestScore = score;
        best = event;
      }
    }
    pick(best);
  }

  // NOTE: ここまでで 3 件未満でも cooldown を無視して補わない。AC18 の「同じ古い event を
  // 短期間に何度も残響として使わない」を厳守し、pack は 0〜5 件になる（design §5 の 3〜5 件
  // は十分な材料があるときの目標。cooldown 中は残響なしで prompt は成立する）。

  // NOTE: journal 追記。P2: 単純な eventId 重複スキップだと、cooldown が切れたイベントの
  // 再想起時に recalledAt が更新されず、以後 cooldown が二度と機能しなくなる。そこで
  // 「最後の想起が cooldown 窓内のときだけスキップ」し、窓外の再想起では必ず新しい
  // エントリを追記して cooldown を張り直す（AC18）。
  if (picked.length > 0) {
    const latestRecalledAt = new Map<string, string>();
    for (const entry of journal) {
      const current = latestRecalledAt.get(entry.eventId);
      if (!current || entry.recalledAt > current) {
        latestRecalledAt.set(entry.eventId, entry.recalledAt);
      }
    }
    for (const event of picked) {
      const lastRecalled = latestRecalledAt.get(event.eventId);
      if (lastRecalled && new Date(lastRecalled).getTime() >= cutoff) continue;
      await storage.appendDreamRecallJournalEntry({
        schemaVersion: 1,
        eventId: event.eventId,
        sessionId: input.sessionId,
        recalledAt: nowIso(),
      });
    }
  }

  return { schemaVersion: 1, events: picked, createdAt: nowIso(), memoryStateToken };
}
