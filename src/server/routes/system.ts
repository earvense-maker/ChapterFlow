import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import {
  applyDataDirSwitch,
  applyDataDirMove,
  DataDirMoveError,
  getDataDirInfo,
  previewDataDirSwitch,
  previewDataDirMove,
} from '../services/dataDirMoveService.js';
import { readAppSettings, updateAppSettings } from '../services/appSettingsService.js';
import {
  DEFAULT_GENERATION_NOTIFICATION_SETTINGS,
  DEFAULT_NG_AUTO_REWRITE_SETTINGS,
  normalizeGenerationNotificationSettings,
  normalizeNgAutoRewriteSettings,
} from '../types/index.js';
// NOTE: 妄想増幅器のグローバル設定・メモ（設計書 13.4）。オン・オフは app-settings でなく
// global-notebook.json に保存する（設計書 9.2）。
import * as amplifierGlobalService from '../services/amplifierGlobalService.js';
import { retryGlobalInterpretation } from '../services/desireInterpreterService.js';
import {
  AMPLIFIER_DISCLOSURE_VERSION,
  readAppSettings as readAppSettingsForDisclosure,
  updateAppSettings as updateAppSettingsForDisclosure,
} from '../services/appSettingsService.js';

export interface SystemRouterOptions {
  onShutdownRequest?: () => void;
  onRestartRequest?: () => void;
}

let cachedVersion: string | null = null;

export function createSystemRouter(options: SystemRouterOptions = {}): Router {
  const router = Router();

  router.get('/system/version', async (_req, res, next) => {
    try {
      res.json({
        version: await readPackageVersion(),
        runtime: process.versions.electron ? 'electron' : 'server',
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/system/notification-settings', async (_req, res, next) => {
    try {
      const settings = await readAppSettings();
      res.json(settings.generationNotifications ?? DEFAULT_GENERATION_NOTIFICATION_SETTINGS);
    } catch (err) {
      next(err);
    }
  });

  router.put('/system/notification-settings', async (req, res, next) => {
    try {
      const normalized = normalizeGenerationNotificationSettings(req.body);
      await updateAppSettings((settings) => ({ ...settings, generationNotifications: normalized }));
      res.json(normalized);
    } catch (err) {
      next(err);
    }
  });

  router.get('/system/ng-auto-rewrite', async (_req, res, next) => {
    try {
      const settings = await readAppSettings();
      res.json(settings.ngAutoRewrite ?? DEFAULT_NG_AUTO_REWRITE_SETTINGS);
    } catch (err) {
      next(err);
    }
  });

  router.put('/system/ng-auto-rewrite', async (req, res, next) => {
    try {
      const normalized = normalizeNgAutoRewriteSettings(req.body);
      await updateAppSettings((settings) => ({ ...settings, ngAutoRewrite: normalized }));
      res.json(normalized);
    } catch (err) {
      next(err);
    }
  });

  // --- 妄想増幅器（設計書 13.4） ---

  router.get('/system/amplifier-disclosure', async (_req, res, next) => {
    try {
      const settings = await readAppSettingsForDisclosure();
      res.json({
        version: AMPLIFIER_DISCLOSURE_VERSION,
        acknowledged: (settings.amplifierDisclosureVersion ?? 0) >= AMPLIFIER_DISCLOSURE_VERSION,
      });
    } catch (err) {
      next(err);
    }
  });

  router.put('/system/amplifier-disclosure', async (_req, res, next) => {
    try {
      await updateAppSettingsForDisclosure((settings) => ({
        ...settings,
        amplifierDisclosureVersion: AMPLIFIER_DISCLOSURE_VERSION,
      }));
      res.json({ version: AMPLIFIER_DISCLOSURE_VERSION, acknowledged: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/system/amplifier-settings', async (_req, res, next) => {
    try {
      res.json(await amplifierGlobalService.getAmplifierSettings());
    } catch (err) {
      next(err);
    }
  });

  router.put('/system/amplifier-settings', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as { globalLearningEnabled?: unknown };
      if (
        body.globalLearningEnabled !== undefined &&
        typeof body.globalLearningEnabled !== 'boolean'
      ) {
        return res.status(400).json({ error: 'globalLearningEnabled must be a boolean', code: 'invalid_settings' });
      }
      res.json(
        await amplifierGlobalService.updateAmplifierSettings({
          globalLearningEnabled: body.globalLearningEnabled as boolean | undefined,
        })
      );
    } catch (err) {
      next(err);
    }
  });

  router.get('/system/amplifier-preferences', async (_req, res, next) => {
    try {
      res.json(await amplifierGlobalService.getGlobalPreferences());
    } catch (err) {
      next(err);
    }
  });

  router.put('/system/amplifier-preferences', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        addCorrections?: unknown;
        withdrawCorrectionIds?: unknown;
        deleteMemoIds?: unknown;
        globalBoundary?: unknown;
      };
      res.json(
        await amplifierGlobalService.updateGlobalPreferences({
          addCorrections: body.addCorrections as never,
          withdrawCorrectionIds: Array.isArray(body.withdrawCorrectionIds)
            ? (body.withdrawCorrectionIds as string[])
            : undefined,
          deleteMemoIds: Array.isArray(body.deleteMemoIds)
            ? (body.deleteMemoIds as string[])
            : undefined,
          globalBoundary:
            body.globalBoundary === undefined ? undefined : typeof body.globalBoundary === 'string' ? body.globalBoundary : null,
        })
      );
    } catch (err) {
      if (err instanceof amplifierGlobalService.AmplifierGlobalError) {
        return res
          .status(err.status)
          .json({ error: err.message, code: err.code, retryable: err.retryable });
      }
      next(err);
    }
  });

  router.delete('/system/amplifier-preferences', async (_req, res, next) => {
    try {
      res.json(await amplifierGlobalService.wipeGlobalPreferences());
    } catch (err) {
      next(err);
    }
  });

  router.post('/system/amplifier-preferences/retry', async (_req, res, next) => {
    try {
      await retryGlobalInterpretation();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/system/data-dir', async (_req, res, next) => {
    try {
      res.json(await getDataDirInfo());
    } catch (err) {
      next(err);
    }
  });

  router.post('/system/data-dir/preview', async (req, res, next) => {
    try {
      if (!process.versions.electron) {
        return res.status(409).json({ error: '保存先の移動は Electron 版のアプリでのみ使えます' });
      }
      const { targetPath } = req.body as { targetPath?: string };
      res.json(await previewDataDirMove(targetPath ?? ''));
    } catch (err) {
      if (err instanceof DataDirMoveError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  router.post('/system/data-dir/apply', async (req, res, next) => {
    try {
      if (!process.versions.electron) {
        return res.status(409).json({ error: '保存先の移動は Electron 版のアプリでのみ使えます' });
      }
      const { targetPath } = req.body as { targetPath?: string };
      const result = await applyDataDirMove(targetPath ?? '');
      res.json(result);
      setTimeout(() => requestRestart(options), 250);
    } catch (err) {
      if (err instanceof DataDirMoveError) {
        return res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.retryable ? { retryable: true } : {}),
        });
      }
      next(err);
    }
  });

  router.post('/system/data-dir/switch-preview', async (req, res, next) => {
    try {
      if (!process.versions.electron) {
        return res.status(409).json({ error: '保存先の切り替えは Electron 版のアプリでのみ使えます' });
      }
      const { targetPath } = req.body as { targetPath?: string };
      res.json(await previewDataDirSwitch(targetPath ?? ''));
    } catch (err) {
      if (err instanceof DataDirMoveError) {
        return res.status(err.status).json({ error: err.message });
      }
      next(err);
    }
  });

  router.post('/system/data-dir/switch', async (req, res, next) => {
    try {
      if (!process.versions.electron) {
        return res.status(409).json({ error: '保存先の切り替えは Electron 版のアプリでのみ使えます' });
      }
      const { targetPath } = req.body as { targetPath?: string };
      const result = await applyDataDirSwitch(targetPath ?? '');
      res.json(result);
      setTimeout(() => requestRestart(options), 250);
    } catch (err) {
      if (err instanceof DataDirMoveError) {
        return res.status(err.status).json({
          error: err.message,
          ...(err.code ? { code: err.code } : {}),
          ...(err.retryable ? { retryable: true } : {}),
        });
      }
      next(err);
    }
  });

  router.post('/system/data-dir/select-folder', async (req, res, next) => {
    try {
      if (!process.versions.electron) {
        return res.status(409).json({ error: 'フォルダ参照は Electron 版のアプリでのみ使えます' });
      }
      const { currentPath, purpose } = req.body as {
        currentPath?: string;
        purpose?: 'move' | 'switch';
      };
      res.json({ path: await selectDataDirFolder(currentPath, purpose) });
    } catch (err) {
      next(err);
    }
  });

  // NOTE: UI の「終了」ボタンから呼ばれる。dev モードは
  // concurrently -> npm -> dev-server.mjs -> tsx watch -> server という多段起動なので、
  // server だけを exit すると tsx watch が再起動として扱う。Electron では main
  // プロセス側に終了を渡し、未指定時は従来どおり親へ SIGTERM を投げる。
  router.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => {
      if (options.onShutdownRequest) {
        options.onShutdownRequest();
        return;
      }
      try {
        if (process.ppid) process.kill(process.ppid, 'SIGTERM');
      } catch {
        // 親が既に居ないケースは無視
      }
      process.exit(0);
    }, 150);
  });

  return router;
}

function requestRestart(options: SystemRouterOptions): void {
  if (options.onRestartRequest) {
    options.onRestartRequest();
    return;
  }
  process.exit(0);
}

async function readPackageVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const packageJsonPath = path.resolve(PROJECT_ROOT, 'package.json');
  const raw = await fs.readFile(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  return cachedVersion;
}

async function selectDataDirFolder(
  currentPath?: string,
  purpose: 'move' | 'switch' = 'move'
): Promise<string | null> {
  const { BrowserWindow, dialog } = await import('electron');
  const options = {
    title: purpose === 'switch'
      ? '既存の ChapterFlow 保存先を選択'
      : '新しい保存先フォルダを選択',
    defaultPath: currentPath || undefined,
    properties: purpose === 'switch'
      ? ['openDirectory'] as Array<'openDirectory'>
      : ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = focusedWindow
    ? await dialog.showOpenDialog(focusedWindow, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : result.filePaths[0] ?? null;
}
