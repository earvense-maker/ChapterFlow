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

  router.get('/system/data-dir', async (_req, res, next) => {
    try {
      res.json(await getDataDirInfo());
    } catch (err) {
      next(err);
    }
  });

  router.post('/system/data-dir/preview', async (req, res, next) => {
    try {
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
