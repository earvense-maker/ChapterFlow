import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readAppSettings,
  readAppSettingsStrict,
  updateAppSettings,
  writeAppSettings,
} from '../../src/server/services/appSettingsService';

let testDir = '';
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  originalSettingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chapterflow-app-settings-'));
  process.env.CHAPTERFLOW_APP_SETTINGS_PATH = path.join(testDir, 'app-settings.json');
  await writeAppSettings({});
});

afterEach(async () => {
  if (originalSettingsPath === undefined) {
    delete process.env.CHAPTERFLOW_APP_SETTINGS_PATH;
  } else {
    process.env.CHAPTERFLOW_APP_SETTINGS_PATH = originalSettingsPath;
  }
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('appSettingsService', () => {
  it('serializes concurrent read-modify-write updates so neither setting is lost', async () => {
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = updateAppSettings(async (settings) => {
      markFirstEntered();
      await firstGate;
      return { ...settings, dataDir: path.join(testDir, 'data') };
    });
    await firstEntered;

    const second = updateAppSettings((settings) => ({
      ...settings,
      setupModel: { provider: 'openai', modelName: 'gpt-test' },
    }));
    releaseFirst();
    await Promise.all([first, second]);

    expect(await readAppSettings()).toEqual({
      dataDir: path.resolve(testDir, 'data'),
      setupModel: { provider: 'openai', modelName: 'gpt-test' },
    });
  });

  it('reports malformed JSON through the strict reader', async () => {
    const settingsPath = process.env.CHAPTERFLOW_APP_SETTINGS_PATH!;
    await fs.writeFile(settingsPath, '{broken');
    await expect(readAppSettingsStrict()).rejects.toBeInstanceOf(SyntaxError);
    await expect(fs.readFile(settingsPath, 'utf8')).resolves.toBe('{broken');
  });
});
