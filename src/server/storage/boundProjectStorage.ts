import { LOCAL_USER_CONTEXT, type UserContext } from '../context/userContext.js';
import { getProjectStorage } from './registry.js';
import {
  PROJECT_STORAGE_METHODS,
  type ProjectStorage,
  type WithoutUserContext,
} from './projectStorage.js';

/** `UserContext` を束縛済みの保存層。呼び出し側の記述は従来の `storage.foo(...)` と同じ形になる。 */
export type BoundProjectStorage = WithoutUserContext<ProjectStorage>;

/**
 * NOTE: 実装の解決を呼び出し時まで遅らせている。モジュール先頭で
 * `const storage = bindProjectStorage(ctx)` と書いても、後から
 * `installProjectStorage` で差し替えた実装がそのまま反映される。
 */
export function bindProjectStorage(context: UserContext): BoundProjectStorage {
  const bound: Partial<Record<keyof ProjectStorage, unknown>> = {};
  for (const method of PROJECT_STORAGE_METHODS) {
    bound[method] = (...args: unknown[]) => {
      const operation = getProjectStorage()[method] as (
        context: UserContext,
        ...args: unknown[]
      ) => unknown;
      return operation(context, ...args);
    };
  }
  return bound as BoundProjectStorage;
}

/**
 * Electron 版の固定コンテキストで束縛した保存層。
 *
 * NOTE(web-phase1): 設計書 Phase 1 の「`UserContext` をWeb APIの入口からストレージ層まで
 * 必須で渡す」を実施するまでの暫定的な結び目。この関数の呼び出し箇所が、
 * リクエスト由来のコンテキストへ差し替える必要がある場所そのものなので、
 * `localProjectStorage(` を grep すれば残作業が一覧できる状態を保つこと。
 */
export function localProjectStorage(): BoundProjectStorage {
  return bindProjectStorage(LOCAL_USER_CONTEXT);
}
