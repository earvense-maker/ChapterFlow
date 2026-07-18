import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
