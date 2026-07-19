import { baseInstruction } from './baseInstruction.js';
import { renderPresets } from './presetParts.js';
import type { ActivePresets } from '../types/index.js';

export interface SystemPromptResult {
  systemPrompt: string;
  generatedSystemPrompt: string;
  baseSystemPrompt: string;
  defaultBaseSystemPrompt: string;
  customSystemPrompt: string;
  isCustomized: boolean;
}

const ADDITIONAL_INSTRUCTIONS_HEADING = '【作品固有の追加指示】';
const SELECTED_SETTINGS_HEADING = '【選択された設定】';
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
  baseSystemPrompt?: string | null
): Promise<string> {
  const resolvedBaseSystemPrompt = resolveBaseSystemPrompt(baseSystemPrompt);
  const presetInstructions = await renderPresets(activePresets);
  return [resolvedBaseSystemPrompt, presetInstructions].filter(Boolean).join('\n\n---\n\n');
}

export async function resolveSystemPrompt(
  activePresets: ActivePresets,
  customSystemPrompt?: string | null,
  baseSystemPrompt?: string | null
): Promise<SystemPromptResult> {
  const defaultBaseSystemPrompt = baseInstruction();
  const resolvedBaseSystemPrompt = resolveBaseSystemPrompt(baseSystemPrompt);
  const generatedSystemPrompt = await buildGeneratedSystemPrompt(
    activePresets,
    resolvedBaseSystemPrompt
  );
  const custom = normalizeAdditionalInstructions(generatedSystemPrompt, customSystemPrompt ?? '');
  const isCustomized = custom.length > 0;
  const systemPrompt = isCustomized
    ? [
        generatedSystemPrompt,
        `${ADDITIONAL_INSTRUCTIONS_HEADING}\n${custom}`,
      ].join('\n\n---\n\n')
    : generatedSystemPrompt;

  return {
    systemPrompt,
    generatedSystemPrompt,
    baseSystemPrompt: resolvedBaseSystemPrompt,
    defaultBaseSystemPrompt,
    customSystemPrompt: custom,
    isCustomized,
  };
}

function resolveBaseSystemPrompt(value: string | null | undefined): string {
  return value === undefined || value === null ? baseInstruction() : value.trim();
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
    .filter((block) => !generatedPreambleBlocks.has(block));

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
    legacyPreamble.startsWith(baseInstruction().split('\n', 1)[0])
  ) {
    return '';
  }
  return trimmed;
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
