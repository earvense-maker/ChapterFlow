// 夢見るモードの生の選択記憶（docs/design/夢見るモード_MVP設計書.md §5）
//
// NOTE: この記憶は「ユーザー理解」ではない。何を好むか、なぜ選んだか、どのような人間かは
// 保存しない。保存の正本は「そのとき、その情景に対して、実際に何を書いたか / 何も書かず
// 眺めたか」だけである。rawText は trim・要約・書き換えをせず、クライアントが送った文字列
// をそのまま保存する（設計書 §5）。
//
// 保存先: DATA_DIR/config/dream/trace-events.jsonl（プロジェクト外・無期限・全消去APIのみ削除）。

import type { ProjectId } from './ids.js';
import type { RoleplaySessionId } from './roleplay.js';

export type DreamTraceEventType = 'text' | 'observe' | 'wake';

export interface DreamTraceEvent {
  schemaVersion: 1;
  eventId: string;
  clientEventId: string;
  sequence: number;
  projectId: ProjectId;
  sessionId: RoleplaySessionId;
  type: DreamTraceEventType;
  // NOTE: 'text' は生入力原文。'observe' は擬似文字列を作らず undefined のままにする。
  // 'wake' はどの情景で夢を終えたかの行動記録なので undefined。
  rawText?: string;
  anchor: {
    // NOTE: 対応する roleplay session の user message（ターン復旧用の運用コピー）。
    // 最初の observe や失敗時は未確定のため optional。
    messageId?: string;
    contentRevision?: number;
    // NOTE: 直前の夢本文（生テキスト）。短い入力にも後から意味のある文脈を戻すため。
    contextText: string;
    contextHash: string;
  };
  createdAt: string;
}

// NOTE: 各セッション開始時に決定的に選ぶ 3〜5 件の生イベント（設計書 §5）。選択は生イベント
// のみを返し、「ユーザーは鍵が好き」のような中間解釈を作らない。
export interface DreamResonancePack {
  schemaVersion: 1;
  events: DreamTraceEvent[];
  createdAt: string;
  // NOTE: 一時停止・再開や全消去をまたいで、古いセッションキャッシュを再利用しないための
  // 内部トークン。旧キャッシュとの互換のため optional とし、欠損時は再構築する。
  memoryStateToken?: string;
}

// NOTE: 想起済み eventId と時刻の記録（recall-journal.jsonl）。同じ過去を短期間に繰り返し
// 使わないための補助データで、生ログ（trace-events.jsonl）が正本。
export interface DreamRecallJournalEntry {
  schemaVersion: 1;
  eventId: string;
  sessionId: RoleplaySessionId;
  recalledAt: string;
}

// NOTE: 夢記憶の設定（DATA_DIR/config/dream/settings.json）。「ずっと記憶する」は明示的な
// 削除権より優先しない（設計書 §5）。recordingEnabled をオフにしても既存記憶は自動削除しない。
export interface DreamMemorySettings {
  schemaVersion: 1;
  recordingEnabled: boolean;
  disclosureAcknowledged: boolean;
  // NOTE: 最後に全消去した時刻（AC17）。全消去より前に作成された入力の backfill を拒否し、
  // 古いセッションからの生記憶の自動復活を防ぐ。null は一度も全消去していない状態。
  wipedAt: string | null;
  updatedAt: string;
}

export const DREAM_DISCLOSURE_TEXT =
  '夢の中であなたが書いた入力原文と、その直前の夢本文は、作品を越えてこのアプリの保存先に記録されます。' +
  '記録された言葉は、未来の夢の本文として、現在選択中のモデル提供者へ送信されることがあります。' +
  'アプリ設定から閲覧・書き出し・全消去・一時停止できます。';

// NOTE: 夢記憶の API レスポンス（設計書 §11 system.ts）。
export interface DreamMemorySettingsResponse {
  settings: DreamMemorySettings;
  eventCount: number;
}

export interface DreamMemoryEventsResponse {
  events: DreamTraceEvent[];
  total: number;
}

export interface DreamMemoryExportResponse {
  events: DreamTraceEvent[];
}

export interface DreamMemoryUpdateBody {
  recordingEnabled?: boolean;
  disclosureAcknowledged?: boolean;
}
