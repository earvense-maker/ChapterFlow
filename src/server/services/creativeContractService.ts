import { createHash } from 'node:crypto';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { normalizeComparableText } from '../utils/characterStateMatching.js';
import * as storage from './storageService.js';
import type { ModelAdapter } from '../adapters/modelAdapter.js';
import type {
  CreativeContract,
  CreativeContractConflictCandidate,
  CreativeContractItem,
  CreativeContractItemInput,
  CreativeContractKind,
  CreativeContractSource,
  CreativeContractStrength,
  Project,
  ProjectId,
} from '../types/index.js';

export const CREATIVE_CONTRACT_LIMITS = {
  hardMax: 8,
  softMax: 12,
  itemMaxChars: 500,
  // NOTE: render後の集約上限。保存時に検査する（設計書 6.1）。
  hardRenderMaxChars: 4_000,
  exceptionExcerptMaxChars: 160,
} as const;

const CONFLICT_DETECT_TIMEOUT_MS = 30_000;
const CONFLICT_DETECT_OUTPUT_LENGTH = 2_000;

export function createEmptyCreativeContract(projectId: ProjectId): CreativeContract {
  const now = nowIso();
  return {
    schemaVersion: 1,
    projectId,
    revision: 0,
    items: [],
    exceptions: [],
    verificationMode: 'strict',
    updatedAt: now,
  };
}

// NOTE: 既存プロジェクトはファイル欠損で従来どおり動く（設計書 9）。欠損は null、
// 壊れたファイルは正規化（可能なら空ストアへ）。
export function normalizeCreativeContract(value: unknown, projectId: ProjectId): CreativeContract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return createEmptyCreativeContract(projectId);
  }
  const record = value as Record<string, unknown>;
  const now = nowIso();
  const items = Array.isArray(record.items)
    ? record.items
        .map((item) => normalizeContractItem(item))
        .filter((item): item is CreativeContractItem => item !== null)
    : [];
  const exceptions = Array.isArray(record.exceptions)
    ? record.exceptions
        .map((item) => normalizeContractException(item))
        .filter((item): item is NonNullable<ReturnType<typeof normalizeContractException>> => item !== null)
    : [];
  return {
    schemaVersion: 1,
    projectId,
    revision: typeof record.revision === 'number' && Number.isFinite(record.revision) ? Math.max(0, Math.floor(record.revision)) : 0,
    items,
    exceptions,
    verificationMode: record.verificationMode === 'fast' ? 'fast' : 'strict',
    updatedAt: asString(record.updatedAt) || now,
  };
}

function normalizeContractItem(value: unknown): CreativeContractItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = asString(record.text);
  if (!text || text.length > CREATIVE_CONTRACT_LIMITS.itemMaxChars) return null;
  const source = normalizeSource(record.source);
  // NOTE: ai-suggested は soft のみ許可（設計書 5.2）。不正な強度は既定へ落とす。
  const strength = source === 'ai-suggested' ? 'soft' : normalizeStrength(record.strength);
  const kind = normalizeKind(record.kind);
  // NOTE: promise / prohibition は原則 hard、preference は soft（設計書 5.2）。
  // 保存済みデータのkindと不整合なstrengthはkindから再補正する。
  const normalizedStrength: CreativeContractStrength =
    kind === 'preference' ? 'soft' : strength === 'soft' ? strength : 'hard';
  return {
    contractId: normalizeContractId(record.contractId),
    kind,
    strength: normalizedStrength,
    text,
    source,
    status: record.status === 'disabled' ? 'disabled' : 'active',
    createdAt: asString(record.createdAt) || nowIso(),
    updatedAt: asString(record.updatedAt) || nowIso(),
  };
}

function normalizeContractException(value: unknown): {
  exceptionId: string;
  contractId: string;
  generationId: string;
  evidenceExcerpt: string;
  reason?: string;
  createdAt: string;
} | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const contractId = asString(record.contractId);
  const generationId = asString(record.generationId);
  if (!contractId || !generationId) return null;
  return {
    exceptionId: normalizeContractId(record.exceptionId),
    contractId,
    generationId,
    evidenceExcerpt: asString(record.evidenceExcerpt).slice(
      0,
      CREATIVE_CONTRACT_LIMITS.exceptionExcerptMaxChars
    ),
    ...(asString(record.reason) ? { reason: asString(record.reason).slice(0, 200) } : {}),
    createdAt: asString(record.createdAt) || nowIso(),
  };
}

export function normalizeContractId(value: unknown): string {
  const text = asString(value);
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : generateTimestampId('ctr');
}

export async function readCreativeContract(projectId: string): Promise<CreativeContract | null> {
  return storage.readCreativeContract(projectId);
}

export async function readCreativeContractOrEmpty(projectId: string): Promise<CreativeContract> {
  const contract = await storage.readCreativeContract(projectId);
  return contract ? normalizeCreativeContract(contract, projectId) : createEmptyCreativeContract(projectId);
}

export async function writeCreativeContract(contract: CreativeContract): Promise<void> {
  await storage.writeCreativeContract(contract);
}

// NOTE: 更新系の共通保存。revision を進めて書き込む。呼び出し側で project lock を
// 保持していることを期待する（競合検出と保存の分断を防ぐ）。
export async function saveCreativeContractWithNextRevision(
  contract: CreativeContract
): Promise<CreativeContract> {
  const next: CreativeContract = {
    ...contract,
    revision: contract.revision + 1,
    updatedAt: nowIso(),
  };
  await storage.writeCreativeContract(next);
  return next;
}

// NOTE: 保存前の正規化+制約検査。違反は CreativeContractValidationError(400) で拒否する。
// 既存NG表現の文言と同じ内容の重複保存はここでは扱わない（NG表現は別機能の正本）。
export function validateContractItems(
  items: CreativeContractItemInput[],
  options: { enforceRenderLimit?: boolean } = {}
): CreativeContractItem[] {
  const normalized: CreativeContractItem[] = [];
  const seenTexts = new Set<string>();
  let hardCount = 0;
  let softCount = 0;

  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) {
      throw new CreativeContractValidationError('契約項目の形式が不正です。');
    }
    const text = asString(raw.text);
    if (!text) {
      throw new CreativeContractValidationError('契約の文言は空にできません。');
    }
    if (text.length > CREATIVE_CONTRACT_LIMITS.itemMaxChars) {
      throw new CreativeContractValidationError(
        `契約1件は${CREATIVE_CONTRACT_LIMITS.itemMaxChars}文字以内にしてください。`
      );
    }
    const comparable = normalizeComparableText(text);
    if (seenTexts.has(comparable)) {
      throw new CreativeContractValidationError('同じ契約の文言が重複しています。');
    }
    seenTexts.add(comparable);

    const source = normalizeSource(raw.source);
    const kind = normalizeKind(raw.kind);
    const strength: CreativeContractStrength =
      kind === 'preference' ? 'soft' : source === 'ai-suggested' ? 'soft' : 'hard';
    if (strength === 'hard') hardCount += 1;
    else softCount += 1;
    if (hardCount > CREATIVE_CONTRACT_LIMITS.hardMax) {
      throw new CreativeContractValidationError(
        `強く守る約束（hard）は${CREATIVE_CONTRACT_LIMITS.hardMax}件までにしてください。`
      );
    }
    if (softCount > CREATIVE_CONTRACT_LIMITS.softMax) {
      throw new CreativeContractValidationError(
        `好み（soft）は${CREATIVE_CONTRACT_LIMITS.softMax}件までにしてください。`
      );
    }

    const now = nowIso();
    normalized.push({
      contractId: normalizeContractId(raw.contractId),
      kind,
      strength,
      text,
      source,
      status: raw.status === 'disabled' ? 'disabled' : 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  if (options.enforceRenderLimit === true) {
    const hardTexts = normalized
      .filter((item) => item.strength === 'hard' && item.status === 'active')
      .map((item) => item.text);
    const renderChars = renderHardContractText(hardTexts).length;
    if (renderChars > CREATIVE_CONTRACT_LIMITS.hardRenderMaxChars) {
      throw new CreativeContractValidationError(
        `強く守る約束の合計が${CREATIVE_CONTRACT_LIMITS.hardRenderMaxChars.toLocaleString('ja-JP')}文字を超えています。`
      );
    }
  }

  return normalized;
}

// NOTE: hard契約のプロンプト用レンダリング。見出し・引用タグ込みで最大4,000字
// （promptBuilder の CREATIVE_CONTRACT_HARD_SECTION_RESERVE と揃える）。
export function renderHardContractText(texts: string[]): string {
  if (texts.length === 0) return '';
  const header = '【作品の約束（絶対に守る）】';
  const body = texts.map((text) => `- ${text}`).join('\n');
  return `${header}\n${body}`;
}

// NOTE: semantic conflict検査。hard契約が2件以上ある場合だけLLMを呼ぶ。
// モデル呼び出し失敗時は失敗側に倒さず「競合なし」として保存を許可する（保存不能にしない）。
export async function detectHardContractConflicts(input: {
  project: Project;
  adapter: ModelAdapter;
  items: CreativeContractItem[];
}): Promise<CreativeContractConflictCandidate[]> {
  const hardTexts = input.items.filter(
    (item) => item.strength === 'hard' && item.status === 'active'
  );
  if (hardTexts.length < 2) return [];

  const userPrompt = [
    'あなたは物語の設定整合性の検査係です。',
    '以下の「作品の約束」のうち、意味的に互いに両立しない組み合わせを判定してください。',
    '例: 「Aは最後まで生きる」と「最終章でAは死ぬ」は両立しません。',
    '曖昧で判断できない場合は候補に含めないでください。',
    'JSON配列だけを出力してください。',
    '【約束】',
    hardTexts.map((item, index) => `${index + 1}. [${item.contractId}] ${item.text}`).join('\n'),
    '【出力形式】',
    JSON.stringify([{ contractIds: ['存在するcontractId'], reason: '両立しない理由' }]),
  ].join('\n');

  try {
    const result = await input.adapter.generateText({
      debugLabel: 'creativeContract.conflictDetect',
      systemInstructions: 'あなたは設定整合性の検査係です。JSONだけを出力してください。',
      userPrompt,
      outputLength: CONFLICT_DETECT_OUTPUT_LENGTH,
      maxOutputTokens: 4_096,
      temperature: 0.1,
      timeoutMs: CONFLICT_DETECT_TIMEOUT_MS,
      modelName: input.project.activeModelName,
      responseMimeType: 'application/json',
    });
    if (result.finishReason !== 'stop' || !result.text.trim()) return [];
    const parsed = parseConflictCandidates(result.text);
    const byId = new Map(hardTexts.map((item) => [item.contractId, item]));
    return parsed
      .map((candidate) => ({
        contractIds: candidate.contractIds.filter((id) => byId.has(id)),
        reason: asString(candidate.reason).slice(0, 200),
      }))
      .filter((candidate) => candidate.contractIds.length >= 2 && candidate.reason.length > 0);
  } catch {
    console.warn('Hard contract conflict detection failed; allowing save', {
      projectId: input.project.projectId,
    });
    return [];
  }
}

export function computeConflictFingerprint(
  candidates: CreativeContractConflictCandidate[]
): string {
  const canonical = candidates
    .map((candidate) => ({
      contractIds: [...candidate.contractIds].sort(),
      reason: candidate.reason,
    }))
    .sort((a, b) => a.contractIds.join('|').localeCompare(b.contractIds.join('|')));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
}

// NOTE: exceptionの参照整合性を検証する（設計書 5.2）。
// 同じprojectのcontractIdと、採用済みgenerationだけを参照できる。
export async function validateContractExceptions(
  projectId: string,
  contract: CreativeContract
): Promise<void> {
  if (contract.exceptions.length === 0) return;
  const contractIds = new Set(contract.items.map((item) => item.contractId));
  for (const exception of contract.exceptions) {
    if (!contractIds.has(exception.contractId)) {
      throw new CreativeContractValidationError(
        '例外が存在しない契約を参照しています。',
        'exception_unknown_contract'
      );
    }
    const generation = await storage.findGenerationRecord(projectId, exception.generationId);
    if (!generation || generation.status !== 'accepted') {
      throw new CreativeContractValidationError(
        '例外が未採用の本文を参照しています。',
        'exception_unknown_generation'
      );
    }
  }
}

export class CreativeContractValidationError extends Error {
  constructor(
    message: string,
    public readonly code = 'invalid_creative_contract',
    public readonly status = 400
  ) {
    super(message);
    this.name = 'CreativeContractValidationError';
  }
}

function parseConflictCandidates(text: string): Array<{ contractIds: string[]; reason: string }> {
  const trimmed = text.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('[');
  const end = withoutFence.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is { contractIds: unknown; reason: unknown } =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
      )
      .map((item) => ({
        contractIds: Array.isArray(item.contractIds)
          ? item.contractIds.filter((id): id is string => typeof id === 'string')
          : [],
        reason: typeof item.reason === 'string' ? item.reason : '',
      }));
  } catch {
    return [];
  }
}

function normalizeSource(value: unknown): CreativeContractSource {
  return value === 'user' || value === 'manual' || value === 'ai-suggested' ? value : 'user';
}

function normalizeStrength(value: unknown): CreativeContractStrength {
  return value === 'hard' || value === 'soft' ? value : 'hard';
}

function normalizeKind(value: unknown): CreativeContractKind {
  return value === 'promise' || value === 'prohibition' || value === 'preference'
    ? value
    : 'promise';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
