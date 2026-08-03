// NOTE: モデルへ実際に送った指示文（systemInstructions / userPrompt）を、開発版だけ
// ファイルへ落とす。目的は指示文そのものの推敲で、障害調査ではない。
//
// 既存の <generationId>.prompt.txt とは別物である点に注意。あちらは小説生成の
// userPrompt だけを「前文脈スナップショット」として作品データへ常時保存するもので、
// system 側（不変契約・ベース指示・カスタム指示・プリセット）を含まず、小説以外の
// 経路（roleplay / refine / setup / 生成後メンテ）も対象外。ここはその両方を埋める。
//
// 置き場所を作品データディレクトリにしないのは、対象が全経路で generationId を
// 持たない呼び出しが多く、プロジェクト配下に自然な置き場所が無いため。加えて開発専用
// の生成物を利用者のバックアップ対象へ混ぜたくない。

import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDevDiagnosticsEnabled } from './devDiagnostics.js';
import type { AdapterGenerateRequest } from '../types/index.js';

/** 詳細診断が有効でも、これを 0/false/off/no にすればダンプだけ止められる。 */
export const PROMPT_DUMP_ENV = 'CHAPTERFLOW_DEV_PROMPT_DUMP';
/** 出力先の上書き。未指定なら <cwd>/logs/prompts。 */
export const PROMPT_DUMP_DIR_ENV = 'CHAPTERFLOW_DEV_PROMPT_DUMP_DIR';

const DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);
const DEFAULT_DUMP_DIR = path.join('logs', 'prompts');
// NOTE: 出力先は環境変数で任意の場所へ向けられる。作品データの generations フォルダを
// 指されても巻き添えで消さないよう、自分が作ったファイルだけを名前で判別する。
// 特に <generationId>.prompt.txt（前文脈スナップショット）とは名前空間を分ける必要がある。
// 定数プレフィックスは時刻より前に付ける。全ダンプで共通なので辞書順＝時刻順が保たれる。
const FILE_PREFIX = 'cf-prompt-';
const FILE_EXTENSION = '.txt';
const DUMP_FILE_PATTERN = /^cf-prompt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{3}-.+\.txt$/;
// NOTE: 1回の指示文は最大 80,000 字（NOVEL_TOTAL_PROMPT_MAX_CHARS）。200件で概ね
// 16MB 上限。開発ループ中に古い分から自動で消える程度の余裕として決めた。
const MAX_DUMP_FILES = 200;
const MAX_LABEL_CHARS = 48;

// NOTE: 同一ミリ秒に複数回呼ばれてもファイル名が衝突しないための連番。
// プロセス内で単調増加すればよく、再起動でリセットされて構わない（時刻が先に立つ）。
let sequence = 0;
let warnedFailure = false;

export function isPromptDumpEnabled(): boolean {
  if (!isDevDiagnosticsEnabled()) return false;
  const raw = process.env[PROMPT_DUMP_ENV]?.trim().toLowerCase();
  return raw ? !DISABLED_VALUES.has(raw) : true;
}

export function promptDumpDir(): string {
  const override = process.env[PROMPT_DUMP_DIR_ENV]?.trim();
  return override ? path.resolve(override) : path.resolve(process.cwd(), DEFAULT_DUMP_DIR);
}

/** ファイル名に使える形へ落とす。区切り文字と空白は - に潰す。 */
function sanitizeLabel(label: string | undefined): string {
  const normalized = (label ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized ? normalized.slice(0, MAX_LABEL_CHARS) : 'unlabeled';
}

/** Windows のファイル名に使えない : と . を除いた ISO 時刻。 */
function fileTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function buildPromptDumpFileName(input: {
  now: Date;
  seq: number;
  label?: string;
  providerName: string;
}): string {
  const seq = String(input.seq % 1000).padStart(3, '0');
  return `${FILE_PREFIX}${fileTimestamp(input.now)}-${seq}-${sanitizeLabel(input.label)}-${sanitizeLabel(input.providerName)}${FILE_EXTENSION}`;
}

function metaLine(label: string, value: string | number | undefined): string {
  return `${label}: ${value === undefined || value === '' ? '-' : value}`;
}

export function buildPromptDumpText(input: {
  now: Date;
  providerName: string;
  request: AdapterGenerateRequest;
}): string {
  const { request } = input;
  return [
    '===== ChapterFlow prompt dump (dev only) =====',
    metaLine('createdAt', input.now.toISOString()),
    metaLine('label', request.debugLabel),
    metaLine('provider', input.providerName),
    metaLine('model', request.modelName),
    metaLine('temperature', request.temperature),
    metaLine('outputLength', request.outputLength),
    metaLine('maxOutputTokens', request.maxOutputTokens),
    metaLine('responseMimeType', request.responseMimeType),
    metaLine('frequencyPenalty', request.frequencyPenalty),
    metaLine('presencePenalty', request.presencePenalty),
    metaLine('systemInstructionsChars', request.systemInstructions.length),
    metaLine('userPromptChars', request.userPrompt.length),
    '',
    `===== systemInstructions (${request.systemInstructions.length} chars) =====`,
    request.systemInstructions,
    '',
    `===== userPrompt (${request.userPrompt.length} chars) =====`,
    request.userPrompt,
    '',
  ].join('\n');
}

/**
 * 上限を超えた古いダンプを消す。プレフィックスの後ろが時刻なので辞書順＝古い順。
 *
 * 対象は DUMP_FILE_PATTERN に完全一致するものだけ。出力先に無関係なファイルが
 * あっても触らない（拡張子だけで判定すると、作品データを指されたときに消してしまう）。
 */
function pruneOldDumps(dir: string): void {
  const names = readdirSync(dir)
    .filter((name) => DUMP_FILE_PATTERN.test(name))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - MAX_DUMP_FILES))) {
    try {
      unlinkSync(path.join(dir, name));
    } catch {
      // 他プロセスが掴んでいるなどで消せなくても、次回の書き込みで再試行される。
    }
  }
}

/**
 * 送信直前の指示文を1件書き出す。呼び出し順を保つため、また失敗・中断した生成でも
 * 「何を送ったか」を必ず残すために、モデル応答を待たず同期で書く。1回あたり最大
 * 80KB 程度で、生成1回につき1回しか呼ばれないので待ち時間への影響は無視できる。
 *
 * ダンプは診断であって機能ではない。書けなかったら黙って諦め、生成は絶対に止めない。
 */
export function dumpAdapterPrompt(
  providerName: string,
  request: AdapterGenerateRequest,
  now: Date = new Date()
): string | null {
  if (!isPromptDumpEnabled()) return null;
  try {
    const dir = promptDumpDir();
    mkdirSync(dir, { recursive: true });
    sequence += 1;
    const filePath = path.join(
      dir,
      buildPromptDumpFileName({ now, seq: sequence, label: request.debugLabel, providerName })
    );
    writeFileSync(filePath, buildPromptDumpText({ now, providerName, request }), 'utf-8');
    pruneOldDumps(dir);
    return filePath;
  } catch (err) {
    // NOTE: 生成のたびに同じ警告を出しても切り分けの役に立たないので初回だけ出す。
    if (!warnedFailure) {
      warnedFailure = true;
      console.warn('[dev] prompt dump failed; continuing without it', err);
    }
    return null;
  }
}

/** テスト用。プロセス内の連番と警告済みフラグを初期化する。 */
export function resetPromptDumpStateForTest(): void {
  sequence = 0;
  warnedFailure = false;
}
