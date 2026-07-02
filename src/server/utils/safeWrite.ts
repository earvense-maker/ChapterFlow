import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function safeWriteFile(filePath: string, data: string | Buffer): Promise<void> {
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
    await fs.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // 一時ファイルが存在しなくても無視
    }
    throw err;
  }
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
  await fs.mkdir(dirPath, { recursive: true });
}
