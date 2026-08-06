// NOTE: プロンプト予算の調整結果を UI 通知・ログへ出し分けるための純関数群（AC13）。
// 入力は PromptBudgetReport だけで、本文・秘密・プロンプト原文は一切受け取らない。
// sectionId は機械的な識別子であり、そのまま利用者へ表示せず日本語ラベルへ変換する。

import type {
  PromptBudgetAction,
  PromptBudgetEntry,
  PromptBudgetReport,
} from './types/generation.js';

/** 利用者へ通知・ログの対象になる action（full 以外の全て）。 */
export const ADJUSTED_BUDGET_ACTIONS: ReadonlySet<PromptBudgetAction> = new Set([
  'truncated',
  'omitted',
  'selected',
  'summarized',
]);

// NOTE: ロールプレイの各ターン report（buildTurnPrompt の結合 report）には system 側の
// 縮小結果も含まれる。system 調整はセッション作成時に一度だけ通知・ログするため、
// ターン単位の通知・ログではこの sectionId だけを見る（設計書 6.3 / AC13）。
export const ROLEPLAY_TURN_SECTION_IDS: ReadonlySet<string> = new Set([
  'roleplay.variablePrompt',
  'roleplay.recentMessages',
]);

// NOTE: promptBuilder / systemPrompt / roleplayPromptBuilder が使う sectionId の正本。
// 未知の sectionId（将来追加分・外部データ）は「プロンプトの一部」という一般的な
// ラベルへ落とし、生の sectionId を利用者へ見せない。
const SECTION_LABELS: Record<string, string> = {
  // 小説 system
  'system.baseInstruction': '基本プロンプト',
  'system.presets': '選択プリセット',
  'system.customInstructions': '追加指示',
  // 小説 user
  'user.coreConcept': '作品の核',
  'user.worldSettings': '世界設定',
  'user.characters': '人物設定',
  'user.relationships': '関係性',
  'user.knowledge': '参考資料',
  'user.currentState': '現在状態',
  'user.characterKnowledgeState': '人物の情報状態',
  'user.importantPast': '重要イベント',
  'user.preferenceNotes': '好み・NG',
  'user.contextSummary': '要約',
  'user.recentContext': '直近の本文',
  'user.rewriteTarget': '書き直し対象',
  'user.frequentPhrases': '頻出表現の注意',
  'user.styleLens': '文体レンズ',
  'user.styleSample': '文体見本',
  'user.sceneDirection': '場面演出の指示',
  'user.outputConditions': '出力形式',
  'user.wish': '今回の指示',
  'user.knowledgeChunks': '参考資料',
  'user.worldChunks': '世界設定',
  // ロールプレイ system
  'roleplay.fixedRules': '固定規則',
  'roleplay.character': '対象キャラクター',
  'roleplay.userPersona': '会話相手設定',
  'roleplay.dialogueExamples': '口調例',
  'roleplay.stylePreset': '会話の作風',
  'roleplay.projectSystemPrompt': '作品の基本システム指示',
  'roleplay.customSystemPrompt': '追加のシステム指示',
  'roleplay.worldDigest': '世界観ダイジェスト',
  'roleplay.otherCharacters': '他の登場人物',
  // ロールプレイ user
  'roleplay.variablePrompt': '会話プロンプト',
  'roleplay.recentMessages': '直近の会話',
};

export function budgetSectionLabel(sectionId: string): string {
  // プリセットは1件ごとに個別エントリができる（system.preset:{category}:{presetId}）。
  if (sectionId.startsWith('system.preset:')) return '選択プリセット';
  return SECTION_LABELS[sectionId] ?? 'プロンプトの一部';
}

/** report 内に 1 件でも truncated / omitted / selected / summarized があれば true。 */
export function hasAdjustedBudgetEntries(
  report: PromptBudgetReport | null | undefined
): boolean {
  return Boolean(report?.entries.some((entry) => ADJUSTED_BUDGET_ACTIONS.has(entry.action)));
}

/** 調整が発生したエントリだけを返す。ログ用（sectionId は機械識別子なのでこのまま出す）。
 * sectionIds を渡すと、そのセクションだけに絞る（ロールプレイのターン単位ログなど）。 */
export function collectAdjustedBudgetEntries(
  report: PromptBudgetReport | null | undefined,
  sectionIds?: ReadonlySet<string>
): PromptBudgetEntry[] {
  if (!report) return [];
  return report.entries.filter(
    (entry) =>
      ADJUSTED_BUDGET_ACTIONS.has(entry.action) &&
      (sectionIds === undefined || sectionIds.has(entry.sectionId))
  );
}

/**
 * 利用者向けの簡潔な通知文を組み立てる。全項目が full なら null（通知しない）。
 * 同じラベルへ複数エントリ（例: プリセット2件、チャンク単位の選択）が落ちても1回に畳む。
 * 生の sectionId は本文へ出さない。
 * options.sectionIds を渡すと、そのセクションだけを対象にする
 * （ロールプレイのターン通知: system 調整はセッション作成時に一度だけ通知するため）。
 */
export function formatBudgetNotice(
  report: PromptBudgetReport | null | undefined,
  options?: { sectionIds?: ReadonlySet<string> }
): string | null {
  if (!report) return null;
  const sectionIds = options?.sectionIds;

  const grouped = new Map<PromptBudgetAction, string[]>();
  for (const entry of report.entries) {
    if (!ADJUSTED_BUDGET_ACTIONS.has(entry.action)) continue;
    if (sectionIds !== undefined && !sectionIds.has(entry.sectionId)) continue;
    const label = budgetSectionLabel(entry.sectionId);
    const labels = grouped.get(entry.action) ?? [];
    if (!labels.includes(label)) labels.push(label);
    grouped.set(entry.action, labels);
  }
  if (grouped.size === 0) return null;

  const phrases: string[] = [];
  for (const action of ['omitted', 'truncated', 'selected', 'summarized'] as const) {
    const labels = grouped.get(action);
    if (!labels || labels.length === 0) continue;
    const subject = labels.join('・');
    if (action === 'omitted') phrases.push(`${subject}を省略しました`);
    else if (action === 'truncated') phrases.push(`${subject}の一部を省略しました`);
    else if (action === 'selected') phrases.push(`${subject}の一部のみを使用しました`);
    else phrases.push(`${subject}を要約して収めました`);
  }
  return phrases.join('\n');
}
