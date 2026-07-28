import {
  defaultNovelCreativeInstruction,
  identifyBaseInstruction,
  immutableNovelContract,
  BASE_INSTRUCTION_FIRST_LINE_PREFIX as BASE_PREFIX,
} from './baseInstruction.js';
import { LEGACY_BASE_INSTRUCTIONS } from './legacyBaseInstructions.js';
import { renderPresetBlocks, renderPresets } from './presetParts.js';
import {
  allocateSectionBudget,
  NOVEL_BASE_PROMPT_MAX_CHARS,
  NOVEL_BASE_PROMPT_MIN_CHARS,
  NOVEL_CUSTOM_PROMPT_MAX_CHARS,
  NOVEL_CUSTOM_PROMPT_MIN_CHARS,
  NOVEL_PRESET_MAX_CHARS,
  NOVEL_PRESET_MIN_CHARS,
  NOVEL_SYSTEM_PROMPT_MAX_CHARS,
  NOVEL_SYSTEM_SEPARATOR_RESERVE,
} from './promptBudget.js';
import type { PromptBudgetEntry } from '../../shared/types/generation.js';
import type { ActivePresets } from '../types/index.js';

export interface SystemPromptResult {
  systemPrompt: string;
  /** 編集可能レイヤーだけの生成結果（基本 + プリセット）。旧データ抽出の比較対象。 */
  generatedSystemPrompt: string;
  baseSystemPrompt: string;
  defaultBaseSystemPrompt: string;
  customSystemPrompt: string;
  isCustomized: boolean;
  /** アプリ固定・編集不可の不変契約（設計書 3.4）。 */
  immutableContract: string;
  /** 保存されている基本プロンプトが未編集の既定文かどうか。 */
  baseSource: 'default' | 'custom';
  baseVersion?: number;
  /** system prompt の予算適用結果。原文は含まない。 */
  budgetEntries: PromptBudgetEntry[];
  systemChars: number;
  /** 不変契約と最低予約だけで system 上限を超えた分。0 なら収まっている。 */
  overflowByChars: number;
}

const SECTION_BASE = 'system.baseInstruction';
const SECTION_PRESETS = 'system.presets';
const SECTION_CUSTOM = 'system.customInstructions';

const ADDITIONAL_INSTRUCTIONS_HEADING = '【作品固有の追加指示】';
const SELECTED_SETTINGS_HEADING = '【選択された設定】';

// NOTE: 旧版の基本プロンプトを構成していた段落。旧文言のまま保存された結合済み全文から
// 追加指示を抽出する際、これらは利用者の追記ではなく旧基本プロンプトとして除外する。
// 段落を手書きせず legacyBaseInstructions.ts の原文から導出するので、文言を改訂したら
// あちらへ改訂前の全文を1件足すだけでよい（段落の写し間違いが起きない）。
const LEGACY_BASE_PARAGRAPH_BLOCKS = new Set(
  LEGACY_BASE_INSTRUCTIONS.flatMap((entry) => splitParagraphBlocks(entry.text))
);

// NOTE: 旧データ判定用。基本プロンプト冒頭は文言改訂されうるため、旧版・現行版に
// 共通する先頭句で判定する（baseInstruction.ts 側の NOTE も参照）。
const BASE_INSTRUCTION_FIRST_LINE_PREFIX = BASE_PREFIX;

const LEGACY_PRESET_LABELS = new Set([
  'ジャンル',
  '文体',
  '視点スタイル',
  '語りの距離感',
  '展開テンポ',
  '描写密度',
  '会話量',
  '関係性の進展速度',
  '濡れ場の描写',
  '禁止事項',
]);

export async function buildGeneratedSystemPrompt(
  activePresets: ActivePresets,
  baseSystemPrompt?: string | null,
  // NOTE: ロールプレイは小説用と別カテゴリ群を流すため、呼び出し側で順序を差し替える。
  categoryOrder?: readonly (keyof ActivePresets)[]
): Promise<string> {
  const resolvedBaseSystemPrompt = resolveBaseSystemPrompt(baseSystemPrompt);
  const presetInstructions = await renderPresets(activePresets, categoryOrder);
  return [resolvedBaseSystemPrompt, presetInstructions].filter(Boolean).join('\n\n---\n\n');
}

export async function resolveSystemPrompt(
  activePresets: ActivePresets,
  customSystemPrompt?: string | null,
  baseSystemPrompt?: string | null
): Promise<SystemPromptResult> {
  const defaultBaseSystemPrompt = defaultNovelCreativeInstruction();
  const resolvedBaseSystemPrompt = resolveBaseSystemPrompt(baseSystemPrompt);
  const generatedSystemPrompt = await buildGeneratedSystemPrompt(
    activePresets,
    resolvedBaseSystemPrompt
  );
  const custom = normalizeAdditionalInstructions(generatedSystemPrompt, customSystemPrompt ?? '');
  const isCustomized = custom.length > 0;
  const contract = immutableNovelContract();
  const presetBlocks = await renderPresetBlocks(activePresets);
  const identified = identifyBaseInstruction(resolvedBaseSystemPrompt);

  const assembled = assembleNovelSystemPrompt({
    contract,
    base: resolvedBaseSystemPrompt,
    presetBlocks,
    custom,
  });

  return {
    systemPrompt: assembled.text,
    generatedSystemPrompt,
    baseSystemPrompt: resolvedBaseSystemPrompt,
    defaultBaseSystemPrompt,
    customSystemPrompt: custom,
    isCustomized,
    immutableContract: contract,
    baseSource: identified.source,
    ...(identified.version === undefined ? {} : { baseVersion: identified.version }),
    budgetEntries: assembled.entries,
    systemChars: assembled.text.length,
    overflowByChars: assembled.overflowByChars,
  };
}

/**
 * system prompt を「不変契約 → 基本 → プリセット → 追加指示」の順で組み立て、
 * NOVEL_SYSTEM_PROMPT_MAX_CHARS へ収める（設計書 4.1）。
 *
 * 3つの hard max は同時最大採用の保証ではない。最低予約を先に配ってから
 * 「追加指示 → プリセット → 基本」の順に拡張するので、hard max まで入らないだけでは
 * エラーにしない。エラーは不変契約 + 最低予約すら入らない場合だけ。
 */
function assembleNovelSystemPrompt(layers: {
  contract: string;
  base: string;
  presetBlocks: Array<{ categoryKey: string; presetId: string; label: string; block: string }>;
  custom: string;
}): { text: string; entries: PromptBudgetEntry[]; overflowByChars: number } {
  const presetBody = layers.presetBlocks.map((entry) => entry.block).join('\n\n');
  // 不変契約と区切り・見出しの分は配分前に確保する。
  const available =
    NOVEL_SYSTEM_PROMPT_MAX_CHARS - NOVEL_SYSTEM_SEPARATOR_RESERVE - layers.contract.length;

  const presetGroupMin = Math.min(
    layers.presetBlocks.length * NOVEL_PRESET_MIN_CHARS,
    presetBody.length
  );
  const grouped = allocateSectionBudget({
    totalMax: Math.max(0, available),
    sections: [
      {
        sectionId: SECTION_BASE,
        body: layers.base,
        hardMax: NOVEL_BASE_PROMPT_MAX_CHARS,
        minReserve: NOVEL_BASE_PROMPT_MIN_CHARS,
      },
      {
        sectionId: SECTION_PRESETS,
        body: presetBody,
        hardMax: NOVEL_PRESET_MAX_CHARS,
        minReserve: presetGroupMin,
      },
      {
        sectionId: SECTION_CUSTOM,
        body: layers.custom,
        hardMax: NOVEL_CUSTOM_PROMPT_MAX_CHARS,
        minReserve: NOVEL_CUSTOM_PROMPT_MIN_CHARS,
      },
    ],
    // 選択プリセットの「存在」を最優先で確保してから、基本・追加の最低予約を置く。
    reserveOrder: [SECTION_PRESETS, SECTION_BASE, SECTION_CUSTOM],
    // 今回の利用者指定に近い順へ拡張する。
    expandOrder: [SECTION_CUSTOM, SECTION_PRESETS, SECTION_BASE],
  });

  if (grouped.overflowByChars > 0) {
    return { text: layers.contract, entries: grouped.entries, overflowByChars: grouped.overflowByChars };
  }

  const entries: PromptBudgetEntry[] = grouped.entries.filter(
    (entry) => entry.sectionId !== SECTION_PRESETS
  );
  const baseText = grouped.sections.find((s) => s.sectionId === SECTION_BASE)?.text ?? '';
  const customText = grouped.sections.find((s) => s.sectionId === SECTION_CUSTOM)?.text ?? '';

  // プリセットへ配られた枠を、さらに各プリセットへ再配分する。集約上限を超えても
  // 「どのプリセットを選んだか」は必ず残す（設計書 4.1）。
  const presetBudget = grouped.allocations.get(SECTION_PRESETS) ?? 0;
  const perPreset = allocateSectionBudget({
    totalMax: presetBudget,
    sections: layers.presetBlocks.map((preset) => ({
      sectionId: `system.preset:${preset.categoryKey}:${preset.presetId}`,
      body: preset.block,
      hardMax: preset.block.length,
      minReserve: NOVEL_PRESET_MIN_CHARS,
    })),
  });
  entries.push(...perPreset.entries);

  const parts = [layers.contract];
  if (baseText) parts.push(baseText);
  if (perPreset.sections.length > 0) {
    parts.push(
      `${SELECTED_SETTINGS_HEADING}\n${perPreset.sections.map((s) => s.text).join('\n\n')}`
    );
  }
  if (customText) parts.push(`${ADDITIONAL_INSTRUCTIONS_HEADING}\n${customText}`);

  return { text: parts.join('\n\n---\n\n'), entries, overflowByChars: 0 };
}

function resolveBaseSystemPrompt(value: string | null | undefined): string {
  return value === undefined || value === null
    ? defaultNovelCreativeInstruction()
    : value.trim();
}

export function normalizeAdditionalInstructions(
  generatedSystemPrompt: string,
  value: string | null | undefined
): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';

  // NOTE: 結合済み全文が旧クライアントや外部API経由で保存されても、追加部分だけを再利用し、
  // 保存・読込のたびに基本プロンプトが増殖しないようにする。
  const embeddedAdditionalInstructions = extractDelimitedAdditionalInstructions(trimmed);
  if (embeddedAdditionalInstructions !== undefined) {
    return embeddedAdditionalInstructions;
  }

  const selectedSettingsIndex = findFirstDelimitedSectionHeading(trimmed, SELECTED_SETTINGS_HEADING);
  if (selectedSettingsIndex < 0) return trimmed;
  const legacyPreamble = trimmed.slice(0, selectedSettingsIndex).trim();
  if (!hasTrailingSectionSeparator(legacyPreamble)) return trimmed;

  // 旧UIは基本プロンプト全文を customSystemPrompt として保存していた。現在の生成済み
  // プロンプトと同一の段落・設定ブロックを除き、利用者が書き換えた部分だけを追加指示へ移す。
  const generatedSettingsIndex = generatedSystemPrompt.indexOf(SELECTED_SETTINGS_HEADING);
  const generatedPreamble =
    generatedSettingsIndex >= 0
      ? generatedSystemPrompt.slice(0, generatedSettingsIndex).trim()
      : generatedSystemPrompt.trim();
  const generatedPreambleBlocks = new Set(splitParagraphBlocks(generatedPreamble));
  const changedPreambleBlocks = splitParagraphBlocks(legacyPreamble)
    .filter(
      (block) => !generatedPreambleBlocks.has(block) && !LEGACY_BASE_PARAGRAPH_BLOCKS.has(block)
    );

  const legacySettings = trimmed
    .slice(selectedSettingsIndex + SELECTED_SETTINGS_HEADING.length)
    .trim();
  const generatedSettings =
    generatedSettingsIndex >= 0
      ? generatedSystemPrompt
          .slice(generatedSettingsIndex + SELECTED_SETTINGS_HEADING.length)
          .trim()
      : '';
  const generatedSettingBlocks = new Set(splitSettingBlocks(generatedSettings));
  const changedSettingBlocks = splitSettingBlocks(legacySettings)
    .filter(
      (block) => !generatedSettingBlocks.has(block) && !isLegacyPresetSettingBlock(block)
    );

  return [...changedPreambleBlocks, ...changedSettingBlocks].join('\n\n');
}

// NOTE: 過去に保存されたロールプレイの contextSnapshot には、正規化前の
// customSystemPrompt が残っている場合がある。ここでは現在のプリセットを持たない
// 同経路でも、明らかな旧生成済み全文だけは固定規則へ混ぜないようにする。
export function normalizeRoleplayAdditionalInstructions(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) return '';

  const embeddedAdditionalInstructions = extractDelimitedAdditionalInstructions(trimmed);
  if (embeddedAdditionalInstructions !== undefined) return embeddedAdditionalInstructions;

  const selectedSettingsIndex = findFirstDelimitedSectionHeading(trimmed, SELECTED_SETTINGS_HEADING);
  if (selectedSettingsIndex < 0) return trimmed;
  const legacyPreamble = trimmed.slice(0, selectedSettingsIndex).trim();
  if (
    hasTrailingSectionSeparator(legacyPreamble) &&
    legacyPreamble.startsWith(BASE_INSTRUCTION_FIRST_LINE_PREFIX)
  ) {
    return '';
  }
  return trimmed;
}

export interface NormalizedRoleplayPromptLayers {
  /** 【作品の基本システム指示】として使う本文。未編集の既定文と判定したら空になる。 */
  projectSystemPrompt: string;
  /** 【追加のシステム指示】へ1回だけ足す、利用者が書いた部分。 */
  additionalInstructions: string;
  baseSource: 'default' | 'custom';
  baseVersion?: number;
}

/**
 * ロールプレイ snapshot の `projectSystemPrompt` を層へ分解する（設計書 5.4 / 7.2）。
 *
 * 保存値には4形態がある。
 *  1. base-only（基本プロンプト全文だけ）
 *  2. 旧結合済み全文（基本 + 【選択された設定】）
 *  3. 旧結合済み全文 + 利用者追記（+ 【作品固有の追加指示】）
 *  4. 見出しを認識できない raw custom
 *
 * どの形態でも「base 候補」を切り出して hash 判定へ回し、未編集の既定文なら落とす。
 * これが「旧版の未編集小説プロンプトがロールプレイへ混入する」P0 の修正点。
 * 判定できない形は custom 扱いで丸ごと保護し、利用者の文章を勝手に削らない。
 */
export function normalizeLegacyRoleplayPromptLayers(
  value: string | null | undefined
): NormalizedRoleplayPromptLayers {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return { projectSystemPrompt: '', additionalInstructions: '', baseSource: 'default' };
  }

  const additionalIndex = findLastDelimitedSectionHeading(trimmed, ADDITIONAL_INSTRUCTIONS_HEADING);
  const beforeAdditional =
    additionalIndex >= 0 ? trimmed.slice(0, additionalIndex).trim() : trimmed;
  const additionalFromHeading =
    additionalIndex >= 0
      ? trimmed.slice(additionalIndex + ADDITIONAL_INSTRUCTIONS_HEADING.length).trim()
      : '';

  const settingsIndex = findFirstDelimitedSectionHeading(beforeAdditional, SELECTED_SETTINGS_HEADING);
  let baseCandidate = beforeAdditional;
  const userSettingEdits: string[] = [];
  if (settingsIndex >= 0) {
    baseCandidate = beforeAdditional.slice(0, settingsIndex).trim();
    const legacySettings = beforeAdditional
      .slice(settingsIndex + SELECTED_SETTINGS_HEADING.length)
      .trim();
    // 生成済みプリセットのブロックは落とす。ロールプレイは自前の作風プリセットを描画するため、
    // 小説側のプリセット文をそのまま持ち込むと二重になる。利用者が書き足したブロックだけ残す。
    for (const block of splitSettingBlocks(legacySettings)) {
      if (!isLegacyPresetSettingBlock(block)) userSettingEdits.push(block);
    }
  }

  const identified = identifyBaseInstruction(stripSectionSeparator(baseCandidate));
  const additionalInstructions = [...userSettingEdits, additionalFromHeading]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');

  return {
    projectSystemPrompt: identified.source === 'custom' ? stripSectionSeparator(baseCandidate) : '',
    additionalInstructions,
    baseSource: identified.source,
    ...(identified.version === undefined ? {} : { baseVersion: identified.version }),
  };
}

// NOTE: 【選択された設定】直前の区切り `---` は結合時に足されたものなので、base 候補の
// hash 判定前に落とす。残すと未編集の既定文が custom と誤判定される。
function stripSectionSeparator(value: string): string {
  return value.replace(/(?:^|\n)[\t ]*---[\t ]*$/, '').trim();
}

function extractDelimitedAdditionalInstructions(value: string): string | undefined {
  const additionalHeadingIndex = findLastDelimitedSectionHeading(
    value,
    ADDITIONAL_INSTRUCTIONS_HEADING
  );
  if (additionalHeadingIndex < 0) return undefined;
  return value.slice(additionalHeadingIndex + ADDITIONAL_INSTRUCTIONS_HEADING.length).trim();
}

function findFirstDelimitedSectionHeading(value: string, heading: string): number {
  let index = value.indexOf(heading);
  while (index >= 0) {
    if (isDelimitedSectionHeading(value, index)) return index;
    index = value.indexOf(heading, index + heading.length);
  }
  return -1;
}

function findLastDelimitedSectionHeading(value: string, heading: string): number {
  let index = value.lastIndexOf(heading);
  while (index >= 0) {
    if (isDelimitedSectionHeading(value, index)) return index;
    index = value.lastIndexOf(heading, index - 1);
  }
  return -1;
}

function isDelimitedSectionHeading(value: string, index: number): boolean {
  if (index === 0) return true;
  if (value[index - 1] !== '\n') return false;
  return hasTrailingSectionSeparator(value.slice(0, index));
}

function hasTrailingSectionSeparator(value: string): boolean {
  return /(?:^|\n)[\t ]*---[\t ]*$/.test(value.trimEnd());
}

function splitParagraphBlocks(value: string): string[] {
  return value
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block && block !== '---');
}

function splitSettingBlocks(value: string): string[] {
  return value
    .split(/(?=^【[^】]+】\s*$)/m)
    .map((block) => block.trim())
    .filter(Boolean);
}

function isLegacyPresetSettingBlock(block: string): boolean {
  const match = block.match(/^【([^:：】]+)[:：][^】]*】/);
  return Boolean(match && LEGACY_PRESET_LABELS.has(match[1].trim()));
}
