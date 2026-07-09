import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type {
  ExpressionsFile,
  NgExpression,
  NgExpressionSource,
} from '../types/index.js';

// NOTE: プロンプトに送る「回避してほしい表現」の件数上限。ユーザー登録が
// 12 件を超えている場合は、新しい順に上位 12 件だけ送る（プロンプト肥大化を防ぐ）。
export const BAN_LIMIT_TOTAL = 12;
const MAX_NG_EXPRESSIONS = 50;
const MIN_NG_TEXT_LENGTH = 1;
const MAX_NG_TEXT_LENGTH = 30;

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

export async function getExpressions(projectId: string): Promise<NgExpression[]> {
  const file = await storage.readExpressions(projectId);
  return file.ngExpressions.filter((e) => e.status === 'active');
}

export interface CreateExpressionInput {
  text: string;
  source?: NgExpressionSource;
}

export async function createExpression(
  projectId: string,
  input: CreateExpressionInput
): Promise<{ expression: NgExpression; isExisting: boolean }> {
  const rawText = input.text;
  if (/[\r\n]/.test(rawText)) {
    throw new ExpressionValidationError('改行を含む表現は登録できません。');
  }
  const normalized = normalizeNgText(rawText);
  validateNgText(normalized);

  const file = await storage.readExpressions(projectId);
  const existing = findActiveByNormalizedText(file, normalized);
  if (existing) {
    return { expression: existing, isExisting: true };
  }

  const activeCount = file.ngExpressions.filter((e) => e.status === 'active').length;
  if (activeCount >= MAX_NG_EXPRESSIONS) {
    throw new ExpressionLimitError(
      `NG表現は最大${MAX_NG_EXPRESSIONS}件までです。不要な表現を整理してください。`
    );
  }

  const now = nowIso();
  const expression: NgExpression = {
    id: generateTimestampId('ngx'),
    text: normalized,
    source: input.source ?? 'manual',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };

  file.ngExpressions.push(expression);
  await storage.writeExpressions(projectId, file);
  return { expression, isExisting: false };
}

export async function archiveExpression(projectId: string, expressionId: string): Promise<void> {
  const file = await storage.readExpressions(projectId);
  const expression = file.ngExpressions.find((e) => e.id === expressionId);
  if (!expression) return;
  if (expression.status === 'archived') return;
  expression.status = 'archived';
  expression.updatedAt = nowIso();
  await storage.writeExpressions(projectId, file);
}

// NOTE: 以前は頻出フレーズを自動で回避リストに入れていたが、固有名詞や
// 一般的な言い回しまで誤って回避対象になる副作用があったため撤去。
// 現在はユーザーが明示的に登録した NG 表現のみをプロンプトに送る。
export async function resolveBannedExpressions(projectId: string): Promise<string[]> {
  const ngExpressions = await getExpressions(projectId);

  return ngExpressions
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((e) => normalizeNgText(e.text))
    .slice(0, BAN_LIMIT_TOTAL);
}

function normalizeNgText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
    (e) => e.status === 'active' && normalizeNgText(e.text) === normalized
  );
}
