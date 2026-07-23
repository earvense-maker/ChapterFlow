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

  it('has no generationNotifications until explicitly saved', async () => {
    expect((await readAppSettings()).generationNotifications).toBeUndefined();
  });

  it('persists a saved generationNotifications value across reads', async () => {
    const saved = await updateAppSettings((settings) => ({
      ...settings,
      generationNotifications: {
        soundEnabled: true,
        systemPopupEnabled: false,
        onlyWhenUnfocused: false,
        events: {
          firstOutput: false,
          completed: true,
          failed: true,
          settingsUpdated: false,
          reviewRequired: true,
        },
      },
    }));
    expect(saved.generationNotifications).toEqual({
      soundEnabled: true,
      systemPopupEnabled: false,
      onlyWhenUnfocused: false,
      events: {
        firstOutput: false,
        completed: true,
        failed: true,
        settingsUpdated: false,
        reviewRequired: true,
      },
    });
    expect((await readAppSettings()).generationNotifications).toEqual(saved.generationNotifications);
  });

  it('normalizes a corrupt generationNotifications value to the safe default rather than throwing', async () => {
    const saved = await updateAppSettings((settings) => ({
      ...settings,
      generationNotifications: 'not-an-object' as never,
    }));
    expect(saved.generationNotifications).toEqual({
      soundEnabled: false,
      systemPopupEnabled: false,
      onlyWhenUnfocused: true,
      events: {
        firstOutput: true,
        completed: false,
        failed: true,
        settingsUpdated: true,
        reviewRequired: true,
      },
    });
  });

  it('updating setupModel alone does not drop a previously saved generationNotifications', async () => {
    await updateAppSettings((settings) => ({
      ...settings,
      generationNotifications: {
        soundEnabled: true,
        systemPopupEnabled: true,
        onlyWhenUnfocused: true,
        events: { firstOutput: true, completed: true, failed: true, settingsUpdated: true, reviewRequired: true },
      },
    }));
    const afterModelUpdate = await updateAppSettings((settings) => ({
      ...settings,
      setupModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
    }));
    expect(afterModelUpdate.generationNotifications?.soundEnabled).toBe(true);
    expect(afterModelUpdate.setupModel).toEqual({ provider: 'gemini', modelName: 'gemini-3.6-flash' });
  });

  it('updating generationNotifications alone does not drop a previously saved setupModel', async () => {
    await updateAppSettings((settings) => ({
      ...settings,
      setupModel: { provider: 'gemini', modelName: 'gemini-3.6-flash' },
    }));
    const afterNotificationUpdate = await updateAppSettings((settings) => ({
      ...settings,
      generationNotifications: {
        soundEnabled: true,
        systemPopupEnabled: false,
        onlyWhenUnfocused: true,
        events: { firstOutput: true, completed: false, failed: true, settingsUpdated: true, reviewRequired: true },
      },
    }));
    expect(afterNotificationUpdate.setupModel).toEqual({ provider: 'gemini', modelName: 'gemini-3.6-flash' });
    expect(afterNotificationUpdate.generationNotifications?.soundEnabled).toBe(true);
  });
});
