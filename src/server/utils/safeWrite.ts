import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withDataDirWrite } from '../services/dataDirLock.js';

const TRANSIENT_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const RENAME_ATTEMPTS = 8;
const RENAME_RETRY_BASE_DELAY_MS = 20;
const RENAME_RETRY_MAX_DELAY_MS = 400;

async function replaceFileWithRetry(tempPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!TRANSIENT_RENAME_ERROR_CODES.has(code ?? '') || attempt === RENAME_ATTEMPTS - 1) {
        throw err;
      }

      // Windows can briefly hold the destination while another reader releases it.
      // Keep the replacement atomic and wait long enough for antivirus/indexing locks too.
      const delayMs = Math.min(
        RENAME_RETRY_BASE_DELAY_MS * 2 ** attempt,
        RENAME_RETRY_MAX_DELAY_MS
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function safeWriteFile(filePath: string, data: string | Buffer): Promise<void> {
  await withDataDirWrite(async () => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    try {
      if (typeof data === 'string') {
        await fs.writeFile(tempPath, data, 'utf-8');
      } else {
        await fs.writeFile(tempPath, data);
      }
      await replaceFileWithRetry(tempPath, filePath);
    } catch (err) {
      try {
        await fs.unlink(tempPath);
      } catch {
        // 一時ファイルが存在しなくても無視
      }
      throw err;
    }
  });
}

export async function safeWriteJson(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  await safeWriteFile(filePath, json);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

export async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await withDataDirWrite(() => fs.mkdir(dirPath, { recursive: true }));
}
