import path from 'node:path';
import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import { readJsonFile, safeWriteJson } from '../utils/safeWrite.js';
import { CONFIG_DIR } from '../config.js';
import { withDataDirWrite } from './dataDirLock.js';
import * as storage from './storageService.js';
import type {
  ExpressionsFile,
  NgExpression,
  NgExpressionSource,
} from '../types/index.js';

// NOTE: プロンプトに送る「回避してほしい表現」の件数上限。共通NGと作品NGを
// 合わせ、新しい順の上位 12 件だけを送る（プロンプト肥大化を防ぐ）。
export const BAN_LIMIT_TOTAL = 12;
const MAX_NG_EXPRESSIONS = 50;
const MIN_NG_TEXT_LENGTH = 1;
const MAX_NG_TEXT_LENGTH = 30;
// NOTE: 代替案はリライトの1回のプロンプトに丸ごと載せるので、選択肢を増やすより
// 少数を的確に出したほうが効く。3件で打ち止めにする。
const MAX_NG_ALTERNATIVES = 3;
const GLOBAL_EXPRESSIONS_PATH = path.resolve(CONFIG_DIR, 'global-expressions.json');

// NOTE: キューは read → update → write をスコープ単位で直列化する。safeWriteJson
// は破損を防ぐが lost update までは防げないため、同じ作品／global の更新だけを待たせる。
const expressionMutationQueues = new Map<string, Promise<void>>();

export class ExpressionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionValidationError';
  }
}

export class ExpressionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionLimitError';
  }
}

export class GlobalExpressionsCorruptError extends Error {
  readonly code = 'global_expressions_corrupt';

  constructor() {
    super('共通NG設定ファイルを読み取れません。修復またはバックアップから復元してください。');
    this.name = 'GlobalExpressionsCorruptError';
  }
}

export async function getExpressions(projectId: string): Promise<NgExpression[]> {
  const file = await storage.readExpressions(projectId);
  return activeExpressions(file);
}

export async function getGlobalExpressions(): Promise<NgExpression[]> {
  return activeExpressions(await readGlobalExpressionsFile());
}

export interface CreateExpressionInput {
  text: string;
  source?: NgExpressionSource;
  alternatives?: string[];
}

export async function createExpression(
  projectId: string,
  input: CreateExpressionInput
): Promise<{ expression: NgExpression; isExisting: boolean }> {
  return createExpressionInScope(
    `project:${projectId}`,
    () => storage.readExpressions(projectId),
    (file) => storage.writeExpressions(projectId, file),
    input
  );
}

export async function createGlobalExpression(
  input: CreateExpressionInput
): Promise<{ expression: NgExpression; isExisting: boolean }> {
  return createExpressionInScope(
    'global',
    readGlobalExpressionsFile,
    writeGlobalExpressionsFile,
    input
  );
}

export async function updateExpressionAlternatives(
  projectId: string,
  expressionId: string,
  alternatives: string[]
): Promise<NgExpression> {
  return updateAlternativesInScope(
    `project:${projectId}`,
    () => storage.readExpressions(projectId),
    (file) => storage.writeExpressions(projectId, file),
    expressionId,
    alternatives
  );
}

export async function updateGlobalExpressionAlternatives(
  expressionId: string,
  alternatives: string[]
): Promise<NgExpression> {
  return updateAlternativesInScope(
    'global',
    readGlobalExpressionsFile,
    writeGlobalExpressionsFile,
    expressionId,
    alternatives
  );
}

export async function archiveExpression(projectId: string, expressionId: string): Promise<void> {
  await archiveExpressionInScope(
    `project:${projectId}`,
    () => storage.readExpressions(projectId),
    (file) => storage.writeExpressions(projectId, file),
    expressionId
  );
}

export async function archiveGlobalExpression(expressionId: string): Promise<void> {
  await archiveExpressionInScope('global', readGlobalExpressionsFile, writeGlobalExpressionsFile, expressionId);
}

// NOTE: 本文生成の検出・局所リライト用。プロンプトへ載せないので BAN_LIMIT_TOTAL の
// ような件数制限は掛けない（制限はプロンプト肥大化を防ぐためのものだった）。登録した
// 語は最後の1件まで検出されるべきなので、作品NGと共通NGの全件を返す。
export async function resolveActiveNgExpressions(projectId: string): Promise<NgExpression[]> {
  const [projectExpressions, globalExpressions] = await Promise.all([
    getExpressions(projectId),
    getGlobalExpressions().catch((err) => {
      if (err instanceof GlobalExpressionsCorruptError) {
        console.warn('Global expressions file is corrupt; falling back to project expressions', {
          projectId,
        });
        return [];
      }
      throw err;
    }),
  ]);

  const seen = new Set<string>();
  const result: NgExpression[] = [];
  for (const expression of [...projectExpressions, ...globalExpressions]) {
    const normalized = normalizeNgText(expression.text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(expression);
  }
  return result;
}

// NOTE: 以前は頻出フレーズを自動で回避リストに入れていたが、固有名詞や
// 一般的な言い回しまで誤って回避対象になる副作用があったため撤去。
// 現在はユーザーが明示的に登録した共通NG・作品NGのみをプロンプトに送る。
//
// NOTE: 本文生成はNG語をプロンプトへ載せなくなったため、この関数の利用先は
// ロールプレイ（短い応答なので注入が効きやすく、局所リライト導線も無い）だけ。
export async function resolveBannedExpressions(projectId: string): Promise<string[]> {
  const [projectExpressions, globalExpressions] = await Promise.all([
    getExpressions(projectId),
    getGlobalExpressions().catch((err) => {
      // NOTE: 共通ファイルの破損は設定画面では明示的に修復を促すが、本文生成まで
      // 止めない。作品NGだけへ縮退し、既存作品を安全に継続できるようにする。
      if (err instanceof GlobalExpressionsCorruptError) {
        console.warn('Global expressions file is corrupt; falling back to project expressions', {
          projectId,
        });
        return [];
      }
      throw err;
    }),
  ]);

  const sorted = [
    ...projectExpressions.map((expression) => ({ expression, scope: 'project' as const })),
    ...globalExpressions.map((expression) => ({ expression, scope: 'global' as const })),
  ].sort((a, b) => {
    const dateOrder = b.expression.createdAt.localeCompare(a.expression.createdAt);
    if (dateOrder !== 0) return dateOrder;
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
    return a.expression.id.localeCompare(b.expression.id);
  });

  const seen = new Set<string>();
  const result: string[] = [];
  for (const { expression } of sorted) {
    const normalized = normalizeNgText(expression.text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= BAN_LIMIT_TOTAL) break;
  }
  return result;
}

async function createExpressionInScope(
  scope: string,
  readFile: () => Promise<ExpressionsFile>,
  writeFile: (file: ExpressionsFile) => Promise<void>,
  input: CreateExpressionInput
): Promise<{ expression: NgExpression; isExisting: boolean }> {
  const rawText = input.text;
  if (/[\r\n]/.test(rawText)) {
    throw new ExpressionValidationError('改行を含む表現は登録できません。');
  }
  const normalized = normalizeNgText(rawText);
  validateNgText(normalized);
  const alternatives = normalizeAlternatives(input.alternatives);

  return withExpressionMutationQueue(scope, async () => {
    const file = await readFile();
    const existing = findActiveByNormalizedText(file, normalized);
    if (existing) {
      return { expression: existing, isExisting: true };
    }

    const activeCount = activeExpressions(file).length;
    if (activeCount >= MAX_NG_EXPRESSIONS) {
      throw new ExpressionLimitError(
        `NG表現は最大${MAX_NG_EXPRESSIONS}件までです。不要な表現を整理してください。`
      );
    }

    const now = nowIso();
    const expression: NgExpression = {
      id: generateTimestampId('ngx'),
      text: normalized,
      ...(alternatives.length > 0 ? { alternatives } : {}),
      source: input.source ?? 'manual',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    file.ngExpressions.push(expression);
    await writeFile(file);
    return { expression, isExisting: false };
  });
}

async function updateAlternativesInScope(
  scope: string,
  readFile: () => Promise<ExpressionsFile>,
  writeFile: (file: ExpressionsFile) => Promise<void>,
  expressionId: string,
  rawAlternatives: string[]
): Promise<NgExpression> {
  const alternatives = normalizeAlternatives(rawAlternatives);

  return withExpressionMutationQueue(scope, async () => {
    const file = await readFile();
    const expression = file.ngExpressions.find(
      (candidate) => candidate.id === expressionId && candidate.status === 'active'
    );
    if (!expression) {
      throw new ExpressionValidationError('対象のNG表現が見つかりません。');
    }
    if (alternatives.length > 0) {
      expression.alternatives = alternatives;
    } else {
      delete expression.alternatives;
    }
    expression.updatedAt = nowIso();
    await writeFile(file);
    return expression;
  });
}

async function archiveExpressionInScope(
  scope: string,
  readFile: () => Promise<ExpressionsFile>,
  writeFile: (file: ExpressionsFile) => Promise<void>,
  expressionId: string
): Promise<void> {
  await withExpressionMutationQueue(scope, async () => {
    const file = await readFile();
    const expression = file.ngExpressions.find((candidate) => candidate.id === expressionId);
    if (!expression || expression.status === 'archived') return;
    expression.status = 'archived';
    expression.updatedAt = nowIso();
    await writeFile(file);
  });
}

async function withExpressionMutationQueue<T>(scope: string, task: () => Promise<T>): Promise<T> {
  const previous = expressionMutationQueues.get(scope) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  expressionMutationQueues.set(scope, next);

  await previous.catch(() => undefined);
  try {
    return await withDataDirWrite(task);
  } finally {
    release();
    if (expressionMutationQueues.get(scope) === next) {
      expressionMutationQueues.delete(scope);
    }
  }
}

async function readGlobalExpressionsFile(): Promise<ExpressionsFile> {
  let data: unknown;
  try {
    data = await readJsonFile<unknown>(GLOBAL_EXPRESSIONS_PATH);
  } catch {
    throw new GlobalExpressionsCorruptError();
  }
  if (data === null) return emptyExpressionsFile();
  if (!isExpressionsFile(data)) throw new GlobalExpressionsCorruptError();
  return data;
}

async function writeGlobalExpressionsFile(file: ExpressionsFile): Promise<void> {
  await safeWriteJson(GLOBAL_EXPRESSIONS_PATH, file);
}

function emptyExpressionsFile(): ExpressionsFile {
  return { schemaVersion: 1, ngExpressions: [] };
}

function isExpressionsFile(value: unknown): value is ExpressionsFile {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.ngExpressions)) return false;
  return value.ngExpressions.every(isNgExpression);
}

function isNgExpression(value: unknown): value is NgExpression {
  if (!isRecord(value)) return false;
  // NOTE: alternatives は後から足したフィールドなので、無い既存ファイルも有効として通す。
  if (
    value.alternatives !== undefined &&
    !(Array.isArray(value.alternatives) && value.alternatives.every((item) => typeof item === 'string'))
  ) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.text === 'string' &&
    (value.source === 'manual' || value.source === 'report' || value.source === 'selection') &&
    (value.status === 'active' || value.status === 'archived') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

function activeExpressions(file: ExpressionsFile): NgExpression[] {
  return file.ngExpressions.filter((expression) => expression.status === 'active');
}

function normalizeNgText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeAlternatives(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (/[\r\n]/.test(item)) {
      throw new ExpressionValidationError('改行を含む代替案は登録できません。');
    }
    const normalized = normalizeNgText(item);
    if (!normalized) continue;
    if (normalized.length > MAX_NG_TEXT_LENGTH) {
      throw new ExpressionValidationError(
        `代替案は${MAX_NG_TEXT_LENGTH}字以内で登録してください。`
      );
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= MAX_NG_ALTERNATIVES) break;
  }
  return result;
}

function validateNgText(text: string): void {
  if (text.length < MIN_NG_TEXT_LENGTH || text.length > MAX_NG_TEXT_LENGTH) {
    throw new ExpressionValidationError(
      `NG表現は${MIN_NG_TEXT_LENGTH}〜${MAX_NG_TEXT_LENGTH}字で登録してください。`
    );
  }
}

function findActiveByNormalizedText(
  file: ExpressionsFile,
  normalized: string
): NgExpression | undefined {
  return file.ngExpressions.find(
    (expression) => expression.status === 'active' && normalizeNgText(expression.text) === normalized
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
