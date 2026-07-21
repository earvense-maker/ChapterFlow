import { promises as fs } from 'node:fs';
import path from 'node:path';

function comparisonKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function canonicalizePath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const missingParts: string[] = [];
  let existing = resolved;

  while (true) {
    try {
      const physical = await fs.realpath(existing);
      return path.join(physical, ...missingParts.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      missingParts.push(path.basename(existing));
      existing = parent;
    }
  }
}

export function sameCanonicalPath(a: string, b: string): boolean {
  return comparisonKey(a) === comparisonKey(b);
}

export function isCanonicalPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function findSymbolicLink(root: string): Promise<string | null> {
  async function walk(current: string): Promise<string | null> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) return fullPath;
      if (stat.isDirectory()) {
        const nested = await walk(fullPath);
        if (nested) return nested;
      }
    }
    return null;
  }
  return walk(root);
}
