import { generateTimestampId } from '../utils/id.js';
import { nowIso } from '../utils/date.js';
import * as storage from './storageService.js';
import type {
  KnowledgeContentStatus,
  KnowledgeExtension,
  KnowledgeFile,
  KnowledgeIndexFile,
  KnowledgeListItem,
} from '../types/index.js';

export const MAX_KNOWLEDGE_CONTENT_CHARS = 200_000;
export const MAX_KNOWLEDGE_FILENAME_CHARS = 255;
export const MAX_KNOWLEDGE_TITLE_CHARS = 100;

const CONTROL_CHAR = /[\x00-\x1f\x7f]/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const KNOWLEDGE_FILE_RE = /^(kb-[A-Za-z0-9_-]+)\.(md|txt)$/;

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeValidationError';
  }
}

export class KnowledgeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeNotFoundError';
  }
}

export async function listKnowledge(projectId: string): Promise<KnowledgeListItem[]> {
  await assertProjectExists(projectId);
  const index = await readValidatedIndex(projectId);
  const items = await Promise.all(
    sortKnowledgeFiles(index.files).map(async (file) => {
      const { content, contentStatus } = await readContentWithStatus(projectId, file);
      return {
        ...file,
        title: sanitizeTitleForRender(file.title),
        charCount: content.length,
        contentStatus,
      };
    })
  );
  return items;
}

export async function getKnowledgeContent(
  projectId: string,
  knowledgeId: string
): Promise<{ meta: KnowledgeFile; content: string }> {
  await assertProjectExists(projectId);
  const index = await readValidatedIndex(projectId);
  const meta = findKnowledge(index, knowledgeId);
  if (!meta) throw new KnowledgeNotFoundError(`Knowledge not found: ${knowledgeId}`);
  const content = await storage.readKnowledgeContent(projectId, meta.knowledgeId, meta.extension);
  return { meta: { ...meta, title: sanitizeTitleForRender(meta.title) }, content };
}

export async function createKnowledge(
  projectId: string,
  input: { fileName: string; content: string }
): Promise<KnowledgeFile> {
  await assertProjectExists(projectId);
  validateContent(input.content);
  const { fileName, extension, title } = normalizeCreateInput(input.fileName);

  const index = await readValidatedIndex(projectId);
  await cleanupOrphanKnowledgeFiles(projectId, index);

  const now = nowIso();
  const knowledgeId = await generateUniqueKnowledgeId(projectId, index);
  const order = index.files.reduce((max, file) => Math.max(max, file.order), -1) + 1;
  const file: KnowledgeFile = {
    knowledgeId,
    title,
    originalFileName: fileName,
    extension,
    enabled: true,
    order,
    charCount: input.content.length,
    createdAt: now,
    updatedAt: now,
  };

  await storage.writeKnowledgeContent(projectId, knowledgeId, extension, input.content);
  await storage.writeKnowledgeIndex(projectId, { schemaVersion: 1, files: [...index.files, file] });
  return file;
}

export async function updateKnowledge(
  projectId: string,
  knowledgeId: string,
  input: Partial<{ title: string; content: string; enabled: boolean; order: number }>
): Promise<KnowledgeFile> {
  await assertProjectExists(projectId);
  storage.assertSafePathSegment(knowledgeId, 'knowledgeId');
  const index = await readValidatedIndex(projectId);
  const idx = index.files.findIndex((file) => file.knowledgeId === knowledgeId);
  if (idx < 0) throw new KnowledgeNotFoundError(`Knowledge not found: ${knowledgeId}`);

  const current = index.files[idx];
  let next: KnowledgeFile = { ...current };

  if (input.title !== undefined) {
    next.title = normalizeTitle(input.title);
  }
  if (input.enabled !== undefined) {
    next.enabled = input.enabled;
  }
  if (input.order !== undefined) {
    validateOrder(input.order, 'order');
    next.order = input.order;
  }
  if (input.content !== undefined) {
    validateContent(input.content);
    await storage.writeKnowledgeContent(projectId, current.knowledgeId, current.extension, input.content);
    next.charCount = input.content.length;
  }

  next = { ...next, updatedAt: nowIso() };
  const files = [...index.files];
  files[idx] = next;
  const nextFiles =
    input.order === undefined
      ? files
      : moveKnowledgeFileToOrder(files, knowledgeId, input.order, next.updatedAt);
  await storage.writeKnowledgeIndex(projectId, { schemaVersion: 1, files: nextFiles });

  return nextFiles.find((file) => file.knowledgeId === knowledgeId) ?? next;
}

export async function reorderKnowledge(
  projectId: string,
  orderedIds: string[]
): Promise<KnowledgeFile[]> {
  await assertProjectExists(projectId);
  const index = await readValidatedIndex(projectId);
  validateOrderedIds(orderedIds, index.files);
  const now = nowIso();
  const byId = new Map(index.files.map((file) => [file.knowledgeId, file]));
  const files = orderedIds.map((knowledgeId, order) => ({
    ...byId.get(knowledgeId)!,
    order,
    updatedAt: now,
  }));
  await storage.writeKnowledgeIndex(projectId, { schemaVersion: 1, files });
  return files;
}

export async function deleteKnowledge(projectId: string, knowledgeId: string): Promise<void> {
  await assertProjectExists(projectId);
  storage.assertSafePathSegment(knowledgeId, 'knowledgeId');
  const index = await readValidatedIndex(projectId);
  await cleanupOrphanKnowledgeFiles(projectId, index);
  const target = findKnowledge(index, knowledgeId);
  if (!target) throw new KnowledgeNotFoundError(`Knowledge not found: ${knowledgeId}`);

  const files = index.files.filter((file) => file.knowledgeId !== knowledgeId);
  await storage.writeKnowledgeIndex(projectId, { schemaVersion: 1, files });
  await storage.deleteKnowledgeContent(projectId, target.knowledgeId, target.extension);
}

export async function getEnabledKnowledgeTexts(
  projectId: string
): Promise<Array<{ title: string; content: string }>> {
  await assertProjectExists(projectId);
  const index = await readValidatedIndex(projectId);
  const result: Array<{ title: string; content: string }> = [];
  for (const file of sortKnowledgeFiles(index.files).filter((item) => item.enabled)) {
    const { content, contentStatus } = await readContentWithStatus(projectId, file);
    if (contentStatus !== 'ok') continue;
    result.push({ title: sanitizeTitleForRender(file.title), content: content.trim() });
  }
  return result;
}

export async function copyKnowledgeFromProject(sourceProjectId: string, destProjectId: string): Promise<void> {
  const index = await readValidatedIndex(sourceProjectId);
  if (index.files.length === 0) return;

  const copiedFiles: KnowledgeFile[] = [];
  for (const file of sortKnowledgeFiles(index.files)) {
    const { content, contentStatus } = await readContentWithStatus(sourceProjectId, file);
    if (contentStatus === 'missing') continue;
    await storage.writeKnowledgeContent(destProjectId, file.knowledgeId, file.extension, content);
    copiedFiles.push({ ...file, order: copiedFiles.length });
  }
  if (copiedFiles.length > 0) {
    await storage.writeKnowledgeIndex(destProjectId, { schemaVersion: 1, files: copiedFiles });
  }
}

export async function readValidatedIndex(projectId: string): Promise<KnowledgeIndexFile> {
  const index = await storage.readKnowledgeIndex(projectId);
  validateKnowledgeIndex(index);
  return index;
}

export function validateKnowledgeIndex(index: unknown): asserts index is KnowledgeIndexFile {
  if (!isRecord(index)) {
    throw new KnowledgeValidationError('knowledge.json must be an object');
  }
  if (index.schemaVersion !== 1) {
    throw new KnowledgeValidationError('knowledge.json schemaVersion must be 1');
  }
  if (!Array.isArray(index.files)) {
    throw new KnowledgeValidationError('knowledge.json files must be an array');
  }
  const seenIds = new Set<string>();
  for (const [recordIndex, file] of index.files.entries()) {
    validateKnowledgeFile(file, recordIndex);
    if (seenIds.has(file.knowledgeId)) {
      throw new KnowledgeValidationError(`Duplicate knowledgeId in knowledge.json: ${file.knowledgeId}`);
    }
    seenIds.add(file.knowledgeId);
  }
}

function validateKnowledgeFile(file: unknown, recordIndex: number): asserts file is KnowledgeFile {
  const label = knowledgeLabel(file, recordIndex);
  if (!isRecord(file)) {
    throw new KnowledgeValidationError(`${label}: record must be an object`);
  }
  validateSafeSegmentField(file.knowledgeId, `${label}.knowledgeId`);
  try {
    storage.assertKnowledgeExtension(file.extension);
  } catch {
    throw new KnowledgeValidationError(`${label}.extension must be md or txt`);
  }
  if (typeof file.enabled !== 'boolean') {
    throw new KnowledgeValidationError(`${label}.enabled must be boolean`);
  }
  validateOrder(file.order, `${label}.order`);
  for (const field of ['title', 'originalFileName', 'createdAt', 'updatedAt'] as const) {
    if (typeof file[field] !== 'string') {
      throw new KnowledgeValidationError(`${label}.${field} must be string`);
    }
  }
  if (typeof file.charCount !== 'number' || !Number.isFinite(file.charCount) || file.charCount < 0) {
    throw new KnowledgeValidationError(`${label}.charCount must be a non-negative finite number`);
  }
}

function validateSafeSegmentField(value: unknown, label: string): void {
  if (typeof value !== 'string') {
    throw new KnowledgeValidationError(`${label} must be string`);
  }
  try {
    storage.assertSafePathSegment(value, label);
  } catch {
    throw new KnowledgeValidationError(`${label} is invalid`);
  }
}

function knowledgeLabel(file: unknown, recordIndex: number): string {
  if (isRecord(file) && typeof file.knowledgeId === 'string') {
    return `knowledge ${file.knowledgeId}`;
  }
  return `knowledge[${recordIndex}]`;
}

async function assertProjectExists(projectId: string): Promise<void> {
  const project = await storage.readProject(projectId);
  if (!project) throw new KnowledgeNotFoundError(`Project not found: ${projectId}`);
}

function findKnowledge(index: KnowledgeIndexFile, knowledgeId: string): KnowledgeFile | null {
  storage.assertSafePathSegment(knowledgeId, 'knowledgeId');
  return index.files.find((file) => file.knowledgeId === knowledgeId) ?? null;
}

async function readContentWithStatus(
  projectId: string,
  file: KnowledgeFile
): Promise<{ content: string; contentStatus: KnowledgeContentStatus }> {
  const content = await storage.readTextFile(
    storage.knowledgeContentPath(projectId, file.knowledgeId, file.extension)
  );
  if (content === null) return { content: '', contentStatus: 'missing' };
  if (content.trim().length === 0) return { content, contentStatus: 'empty' };
  return { content, contentStatus: 'ok' };
}

async function cleanupOrphanKnowledgeFiles(
  projectId: string,
  index: KnowledgeIndexFile
): Promise<void> {
  const referenced = new Set(
    index.files.map((file) => `${file.knowledgeId}.${file.extension}`)
  );
  const files = await storage.listKnowledgeContentFiles(projectId);
  await Promise.all(
    files
      .filter((fileName) => !referenced.has(fileName))
      .map(async (fileName) => {
        const match = KNOWLEDGE_FILE_RE.exec(fileName);
        if (!match) return;
        await storage.deleteKnowledgeContent(
          projectId,
          match[1],
          match[2] as KnowledgeExtension
        );
      })
  );
}

function normalizeCreateInput(fileNameValue: unknown): {
  fileName: string;
  extension: KnowledgeExtension;
  title: string;
} {
  if (typeof fileNameValue !== 'string') {
    throw new KnowledgeValidationError('fileName must be a string');
  }
  const fileName = fileNameValue.trim();
  if (!fileName || fileName.length > MAX_KNOWLEDGE_FILENAME_CHARS || CONTROL_CHAR.test(fileName)) {
    throw new KnowledgeValidationError('fileName must be 1-255 characters and contain no control characters');
  }
  const lower = fileName.toLowerCase();
  const extension: KnowledgeExtension = lower.endsWith('.md')
    ? 'md'
    : lower.endsWith('.txt')
      ? 'txt'
      : (() => {
          throw new KnowledgeValidationError('fileName extension must be .md or .txt');
        })();
  const titleEnd = fileName.length - extension.length - 1;
  const title = normalizeTitle(fileName.slice(0, titleEnd) || '無題の資料', {
    fallback: '無題の資料',
    truncate: true,
  });
  return { fileName, extension, title };
}

function validateContent(value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new KnowledgeValidationError('content must be a string');
  }
  if (value.length > MAX_KNOWLEDGE_CONTENT_CHARS) {
    throw new KnowledgeValidationError('1ファイルの上限は20万字です');
  }
}

function normalizeTitle(
  value: unknown,
  options: { fallback?: string; truncate?: boolean } = {}
): string {
  if (typeof value !== 'string') {
    throw new KnowledgeValidationError('title must be a string');
  }
  const normalized = sanitizeTitleForRender(value).trim();
  const title = normalized || options.fallback || '';
  if (!title) {
    throw new KnowledgeValidationError('title must be a non-empty string');
  }
  if (title.length > MAX_KNOWLEDGE_TITLE_CHARS) {
    if (options.truncate) return title.slice(0, MAX_KNOWLEDGE_TITLE_CHARS);
    throw new KnowledgeValidationError(`title must be at most ${MAX_KNOWLEDGE_TITLE_CHARS} characters`);
  }
  return title;
}

function sanitizeTitleForRender(value: string): string {
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function validateOrder(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new KnowledgeValidationError(`${label} must be a non-negative integer`);
  }
}

function validateOrderedIds(orderedIds: unknown, files: KnowledgeFile[]): asserts orderedIds is string[] {
  if (!Array.isArray(orderedIds) || !orderedIds.every((id) => typeof id === 'string')) {
    throw new KnowledgeValidationError('orderedIds must be a string array');
  }
  if (orderedIds.length !== files.length) {
    throw new KnowledgeValidationError('orderedIds must include every knowledgeId exactly once');
  }
  const existing = new Set(files.map((file) => file.knowledgeId));
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw new KnowledgeValidationError(`Duplicate knowledgeId in orderedIds: ${id}`);
    }
    if (!existing.has(id)) {
      throw new KnowledgeValidationError(`Unknown knowledgeId in orderedIds: ${id}`);
    }
    seen.add(id);
  }
}

function sortKnowledgeFiles(files: KnowledgeFile[]): KnowledgeFile[] {
  return [...files].sort(
    (a, b) =>
      a.order - b.order ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.knowledgeId.localeCompare(b.knowledgeId)
  );
}

function moveKnowledgeFileToOrder(
  files: KnowledgeFile[],
  knowledgeId: string,
  requestedOrder: number,
  updatedAt: string
): KnowledgeFile[] {
  const sorted = sortKnowledgeFiles(files);
  const target = sorted.find((file) => file.knowledgeId === knowledgeId);
  if (!target) throw new KnowledgeNotFoundError(`Knowledge not found: ${knowledgeId}`);

  const withoutTarget = sorted.filter((file) => file.knowledgeId !== knowledgeId);
  const nextOrder = Math.min(requestedOrder, withoutTarget.length);
  withoutTarget.splice(nextOrder, 0, target);

  return withoutTarget.map((file, order) => ({
    ...file,
    order,
    updatedAt:
      file.knowledgeId === knowledgeId || file.order !== order ? updatedAt : file.updatedAt,
  }));
}

async function generateUniqueKnowledgeId(
  projectId: string,
  index: KnowledgeIndexFile
): Promise<string> {
  const existing = new Set(index.files.map((file) => file.knowledgeId));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = generateTimestampId('kb');
    if (existing.has(id)) continue;
    const mdExists = await storage.knowledgeContentExists(projectId, id, 'md');
    const txtExists = await storage.knowledgeContentExists(projectId, id, 'txt');
    if (!mdExists && !txtExists) return id;
  }
  throw new KnowledgeValidationError('Failed to generate a unique knowledgeId');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
