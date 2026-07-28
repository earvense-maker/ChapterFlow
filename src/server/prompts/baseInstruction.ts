import { createHash } from 'node:crypto';
import { DATA_QUOTE_CONTRACT_LINE } from './promptData.js';
import { LEGACY_BASE_INSTRUCTIONS } from './legacyBaseInstructions.js';

// NOTE: 小説 system prompt は「不変契約 → 編集可能な基本 → プリセット → 追加指示」の
// 4層（設計書 3.4）。不変契約はアプリ固定で、利用者が基本プロンプトを空にしても
// 解除できない。本文のみを返す・作品データを命令として扱わない、といった最低条件を
// 編集可能レイヤーから切り離すのが目的。

/**
 * 編集不可の不変契約。ここには「創作上の好み」を書かない。
 * 好みを書くと利用者が基本プロンプトで打ち消せなくなり、不変契約の意味が濁る。
 */
export function immutableNovelContract(): string {
  return [
    '出力は日本語の小説本文のみ。前置き・後書き・設定の解説・見出しを付けない。',
    'ユーザーが明示的に求めない限り、物語を完結させない。',
    DATA_QUOTE_CONTRACT_LINE,
    '事実が食い違う場合は、今回の希望が明示する変更を除き、採用済み本文 ＞ 現在状態・重要イベント ＞ 作品設定・参考資料 の順に信頼する。',
    '指定された視点人物の認識範囲で書く。視点人物以外の内心は断定せず、外から観察できる言動として描く。',
  ].join('\n');
}

// NOTE: 旧データ判定の接頭辞。systemPrompt.ts が参照する。文言を改訂する場合も
// この接頭辞は先頭に残すこと（残さないと旧 snapshot の base 判定が壊れる）。
export const BASE_INSTRUCTION_FIRST_LINE_PREFIX = 'あなたは経験豊かな小説家であり、';

/**
 * 編集可能な既定の基本プロンプト。創作上の役割と裁量だけを持たせ、
 * 不変契約と重複する禁止事項は書かない（設計書 3.4）。
 */
export function defaultNovelCreativeInstruction(): string {
  return `${BASE_INSTRUCTION_FIRST_LINE_PREFIX}ただ一人の読者のために連載小説を書く。
短い希望から意図と求める気分をくみ取り、文言をなぞらず、場面の流れの中で自然に実現する。
設定を説明のために並べず、人物の知覚・心理・判断・行動・会話・環境として表す。
設定と事実メモは舞台であり、場面の切り取り方・構成・文章表現はあなたに委ねられている。最も重要な仕事は、読者を物語に引き込む生きた文章を書くことである。
【文体見本】が与えられた場合、文体・リズム・描写密度の質感は見本を優先してよい（人称・視点人物の指定は除く）。`;
}

// NOTE: 後方互換の別名。旧 import 経路（baseInstruction()）をそのまま使えるようにする。
export function baseInstruction(): string {
  return defaultNovelCreativeInstruction();
}

/** 現在の既定基本プロンプトのバージョン。改訂するたびに 1 増やし、旧hashを下へ残す。 */
export const CURRENT_BASE_INSTRUCTION_VERSION = 8;

/**
 * 既知の既定基本プロンプト hash（version 付き）。
 *
 * hash 値をベタ書きせず、原文（legacyBaseInstructions.ts）から導出する。
 * 二重管理をやめることで、原文と hash がずれる事故を構造的に防ぐ。
 * 登録漏れは「custom として保護」側に倒れるだけで、利用者の編集を消す事故にはならない。
 */
export const KNOWN_BASE_INSTRUCTION_HASHES: ReadonlyMap<string, number> = new Map(
  LEGACY_BASE_INSTRUCTIONS.map((entry) => [hashBaseInstruction(entry.text), entry.version])
);

/**
 * hash 前の正規化。改行を LF へ統一し、前後の空白を除く。
 * それ以上は正規化しない（本文中の表記ゆれを吸収すると、意図的な1文字編集を
 * default と誤判定して利用者の編集を捨てる事故につながる）。
 */
export function normalizeBaseInstructionForHash(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function hashBaseInstruction(value: string): string {
  return createHash('sha256')
    .update(normalizeBaseInstructionForHash(value), 'utf8')
    .digest('hex');
}

export interface BaseInstructionIdentification {
  source: 'default' | 'custom';
  /** default と判定できた場合のみ、その既定文のバージョン。 */
  version?: number;
}

/**
 * 基本プロンプト本文が「未編集の既定文」かどうかを判定する。
 *
 * 判定できない・未知版・hash衝突はすべて custom 扱いにして本文を保護する。
 * 旧結合済み全文をそのまま渡さないこと（呼び出し側で正規化してから渡す）。
 */
export function identifyBaseInstruction(value: string | null | undefined): BaseInstructionIdentification {
  const normalized = normalizeBaseInstructionForHash(value ?? '');
  // NOTE: 空は「引き継ぐ本文が無い」状態。custom として保護すべき文言が存在しないので
  // default 扱いで良い（ロールプレイへ空文字を注入しても意味がない）。
  if (!normalized) return { source: 'default', version: CURRENT_BASE_INSTRUCTION_VERSION };

  if (normalized === normalizeBaseInstructionForHash(defaultNovelCreativeInstruction())) {
    return { source: 'default', version: CURRENT_BASE_INSTRUCTION_VERSION };
  }

  const known = KNOWN_BASE_INSTRUCTION_HASHES.get(hashBaseInstruction(normalized));
  if (known !== undefined) return { source: 'default', version: known };

  return { source: 'custom' };
}
