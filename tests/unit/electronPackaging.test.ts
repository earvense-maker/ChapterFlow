import { createPackage } from '@electron/asar';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findMissingPackageEntries,
  requiredPackageEntries,
  verifyArchive,
} from '../../scripts/verify-electron-package.mjs';

interface PackageConfig {
  scripts?: Record<string, string>;
  build?: {
    files?: string[];
  };
}

const packageConfig = JSON.parse(
  readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
) as PackageConfig;

describe('Electron packaging configuration', () => {
  let fixtureRoot = '';
  let fixtureArchive = '';

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'chapterflow-asar-'));
    const sourceRoot = path.join(fixtureRoot, 'source');
    const typeDir = path.join(sourceRoot, 'dist', 'shared', 'types');
    await mkdir(typeDir, { recursive: true });
    await writeFile(path.join(typeDir, 'index.js'), 'export {};\n', 'utf8');
    fixtureArchive = path.join(fixtureRoot, 'fixture.asar');
    await createPackage(sourceRoot, fixtureArchive);
  });

  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it('includes every runtime output directory', () => {
    expect(packageConfig.build?.files).toEqual(
      expect.arrayContaining([
        'dist/client/**',
        'dist/electron/**',
        'dist/server/**',
        'dist/shared/**',
      ])
    );
  });

  it('verifies the archive before preparing release assets', () => {
    const command = packageConfig.scripts?.['dist:electron'] ?? '';
    const packageStep = command.indexOf('electron-builder --win');
    const verifyStep = command.indexOf('npm run verify:electron-package');
    const assetsStep = command.indexOf('npm run release:assets');

    expect(packageStep).toBeGreaterThanOrEqual(0);
    expect(verifyStep).toBeGreaterThan(packageStep);
    expect(assetsStep).toBeGreaterThan(verifyStep);
  });

  it('cleans stale build outputs before every build', () => {
    expect(packageConfig.scripts?.['clean:dist']).toBe('node scripts/clean-dist.mjs');
    expect(packageConfig.scripts?.prebuild).toBe('npm run clean:dist');
  });

  it('accepts the split type barrel and rejects the removed legacy path', () => {
    expect(requiredPackageEntries).toContain('dist/shared/types/index.js');
    expect(requiredPackageEntries).not.toContain('dist/shared/types.js');
    expect(() =>
      verifyArchive(fixtureArchive, ['dist/shared/types/index.js'])
    ).not.toThrow();
    expect(() =>
      verifyArchive(fixtureArchive, ['dist/shared/types.js'])
    ).toThrow(/dist\/shared\/types\.js/);
  });

  it('normalizes archive separators before checking entries', () => {
    expect(
      findMissingPackageEntries(
        ['\\dist\\shared\\types\\index.js'],
        ['dist/shared/types/index.js']
      )
    ).toEqual([]);
  });
});
