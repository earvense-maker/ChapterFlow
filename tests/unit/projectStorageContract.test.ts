import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_USER_CONTEXT,
  UnsupportedUserContextError,
  type UserContext,
} from '../../src/server/context/userContext';
import { PROJECT_STORAGE_METHODS } from '../../src/server/storage/projectStorage';
import type { ProjectStorage } from '../../src/server/storage/projectStorage';
import { createFileProjectStorage } from '../../src/server/storage/fileProjectStorage';
import {
  getProjectStorage,
  installProjectStorage,
  resetProjectStorage,
} from '../../src/server/storage/registry';
import {
  bindProjectStorage,
  localProjectStorage,
} from '../../src/server/storage/boundProjectStorage';
import * as storage from '../../src/server/services/storageService';
import * as projectService from '../../src/server/services/projectService';

const WEB_USER_CONTEXT: UserContext = { kind: 'web', userId: 'user-b' };

afterEach(() => {
  resetProjectStorage();
});

describe('ProjectStorage contract', () => {
  it('FileStorage implements every method listed in the contract', () => {
    const fileStorage = createFileProjectStorage();
    for (const method of PROJECT_STORAGE_METHODS) {
      expect(typeof fileStorage[method]).toBe('function');
    }
    expect(Object.keys(fileStorage).sort()).toEqual([...PROJECT_STORAGE_METHODS].sort());
  });

  // NOTE: 設計書 7.1-5 の「ストレージ層でも所有権条件を必須にする」を、契約の全メソッドに
  // 対して検査する。1メソッドでもガードが抜けると、Phase 2 以降に web 利用者のリクエストが
  // ローカルの単一ディレクトリへ届いてしまう。
  it('rejects a non-local user context on every method', async () => {
    const fileStorage = createFileProjectStorage() as unknown as Record<
      string,
      (context: UserContext, ...args: unknown[]) => unknown
    >;

    for (const method of PROJECT_STORAGE_METHODS) {
      await expect(
        Promise.resolve().then(() => fileStorage[method](WEB_USER_CONTEXT))
      ).rejects.toBeInstanceOf(UnsupportedUserContextError);
    }
  });

  it('does not leak the user id through the rejection message', () => {
    const fileStorage = createFileProjectStorage();
    try {
      void fileStorage.listProjectIds(WEB_USER_CONTEXT);
      expect.unreachable('web コンテキストは拒否されるべき');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedUserContextError);
      expect((err as Error).message).not.toContain('user-b');
    }
  });

  it('reads and writes through the same files as the existing storageService', async () => {
    const projectId = `proj-contract-${Date.now()}`;
    const fileStorage = createFileProjectStorage();

    await fileStorage.createProjectContainer(LOCAL_USER_CONTEXT, projectId);
    await fileStorage.writeMemories(LOCAL_USER_CONTEXT, projectId, []);

    expect(await storage.projectExists(projectId)).toBe(true);
    expect(await fileStorage.projectExists(LOCAL_USER_CONTEXT, projectId)).toBe(true);
    expect(await storage.readMemories(projectId)).toEqual([]);

    await fileStorage.deleteProject(LOCAL_USER_CONTEXT, projectId);
    expect(await storage.projectExists(projectId)).toBe(false);
  });
});

describe('project storage registry', () => {
  it('defaults to FileStorage so the Electron boot path is unchanged', async () => {
    const projectId = `proj-registry-${Date.now()}`;
    await getProjectStorage().createProjectContainer(LOCAL_USER_CONTEXT, projectId);
    expect(await storage.projectExists(projectId)).toBe(true);
    await getProjectStorage().deleteProject(LOCAL_USER_CONTEXT, projectId);
  });

  // NOTE: bind した facade が import 時点の実装を握り込むと、Phase 2 で WebStorage を
  // 注入しても既に読み込まれたサービスだけが FileStorage を使い続ける。呼び出し時解決を固定する。
  it('lets an installed storage replace the implementation after binding', async () => {
    const bound = bindProjectStorage(LOCAL_USER_CONTEXT);
    const calls: string[] = [];
    installProjectStorage({
      ...createFileProjectStorage(),
      listProjectIds: async (context) => {
        calls.push(context.userId);
        return ['proj-from-installed-storage'];
      },
    } as ProjectStorage);

    expect(await bound.listProjectIds()).toEqual(['proj-from-installed-storage']);
    expect(calls).toEqual(['local']);
  });

  it('binds the local context for Electron callers', async () => {
    const seen: UserContext[] = [];
    installProjectStorage({
      ...createFileProjectStorage(),
      listProjectIds: async (context) => {
        seen.push(context);
        return [];
      },
    } as ProjectStorage);

    await localProjectStorage().listProjectIds();
    expect(seen).toEqual([LOCAL_USER_CONTEXT]);
  });
});

describe('migrated services', () => {
  // NOTE: 契約を挿しても保存形式と挙動が変わらないことが Phase 0 の完了条件なので、
  // サービス経由の作成が従来どおり storageService から読めることを確認する。
  it('projectService still persists through the file storage', async () => {
    const project = await projectService.createProject({ title: '契約経由の作品' });
    try {
      const stored = await storage.readProject(project.projectId);
      expect(stored?.title).toBe('契約経由の作品');
    } finally {
      await projectService.deleteProject(project.projectId);
    }
  });
});
