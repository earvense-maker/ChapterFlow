import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type { ContextSummaryState, ProjectState } from '../types/index.js';

// NOTE: 「採用済み本文」から派生するデータと、それを壊しうるイベントの対応表。
// 以前はこの表がどこにも存在せず、各イベントのハンドラがコメント頼みで自分のセルを
// 埋めていた。実際に「採用取消 × 文脈要約」のセルだけが空のまま出荷され、要約が
// 二度とプロンプトへ入らない無言の不具合になった。セルを増減させるときはまずこの表を
// 更新し、空欄には「意図的に何もしない」理由を書くこと。
//
//               │ 文脈要約(※1)        │ 物語状態(※2)        │ 章 .md              │ 文体トレース
// ──────────────┼──────────────────────┼──────────────────────┼─────────────────────┼──────────────────
// 新規採用      │ 背景ジョブで畳む     │ refresh pending →    │ updateEpisode-      │ queueAccepted-
//               │ (startContextSummary │ 背景抽出             │ Markdown            │ GenerationStyle-
//               │  AfterAcceptance)    │                      │                     │ Analysis
// 採用差し替え  │ 旧IDが畳み済みなら   │ 同上（新本文から     │ 同上                │ 同上
// (同一シーン)  │ 全破棄→背景再構築    │ 再抽出）             │                     │
// 採用取消      │ 同上                 │ 直近diffのrevert +   │ 同上                │ 何もしない：解析は
//               │                      │ stale マーク         │                     │ 採用時のみ。残った
//               │                      │                      │                     │ トレースは次の採用
//               │                      │                      │                     │ で上書きされる
// NGリライト    │ 畳み済みなら         │ 何もしない：NG表現   │ rebuildEpisode-     │ 旧本文のまま：文体
// (同一IDで     │ 全破棄→背景再構築    │ の局所置換は物語の   │ MarkdownFor-        │ 指標への影響は軽微
//  本文差替)    │                      │ 事実を変えない前提   │ AcceptedGeneration  │ と割り切る
// 却下(reject)  │ 全列何もしない：却下できるのは draft のみで、採用済み本文には触れない。
//               │ この前提は rejectGenerationUnlocked のガードで保証する。
//
// ※1 context_summary.md ＋ state.contextSummary.summarizedGenerationIds。
//    要約は畳み込み済み本文の集約なので、収載済み本文が消える・変わるときは
//    「差し引き」ができず全破棄→再構築しかない（この判定を下の関数へ集約した）。
// ※2 story-state.json。抽出・revert は storyStateService / generationReaderState が持つ。

// NOTE: 採用済み本文が「消える・別物になる・同一IDのまま書き換わる」ときに呼ぶ。
// 対象IDが要約へ畳み込み済みなら、要約本文と畳み済みID集合を対で破棄し、新しい
// contextSummary パッチを返す（呼び出し側が同じロック区間の writeState に混ぜる）。
// 畳んでいなければ何もせず null。ファイルと state を別々のタイミングで消すと
// 「片方だけ残って二重に畳む／二度と畳まない」が起きるため、判定と破棄を1箇所に置く。
// 呼び出し側は project write lock を保持していること。
export async function invalidateContextSummaryOnAcceptedTextChangeUnlocked(
  projectId: string,
  state: ProjectState,
  changedGenerationIds: readonly string[]
): Promise<ContextSummaryState | null> {
  const summarized = state.contextSummary?.summarizedGenerationIds ?? [];
  if (!changedGenerationIds.some((generationId) => summarized.includes(generationId))) {
    return null;
  }
  await storage.writeContextSummary(projectId, '');
  return {
    summarizedGenerationIds: [],
    updatedAt: nowIso(),
  };
}

// NOTE: NGリライトのように「呼び出し側が state を書き直す予定のない」経路向け。
// state の読み直しと書き戻しまで面倒を見る。無効化したら true。
export async function invalidateContextSummaryForGenerationUnlocked(
  projectId: string,
  generationId: string
): Promise<boolean> {
  const state = await storage.readState(projectId);
  if (!state) return false;
  const patch = await invalidateContextSummaryOnAcceptedTextChangeUnlocked(projectId, state, [
    generationId,
  ]);
  if (!patch) return false;
  await storage.writeState(projectId, { ...state, contextSummary: patch });
  return true;
}
