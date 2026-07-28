// NOTE: 公開Web版では user_id を認証済みセッションからのみ取得する（設計書 7.1）。
// Electron 版は利用者が1人なので固定コンテキストを使うが、型を最初から共通にしておくと、
// Phase 1 で Web の UserContext を通し始めても保存層の呼び出し形を変えずに済む。

export type UserContextKind = 'local' | 'web';

export interface UserContext {
  readonly kind: UserContextKind;
  readonly userId: string;
}

export const LOCAL_USER_ID = 'local';

// NOTE: Electron 版のアダプター境界で補う固定コンテキスト（設計書 4.2）。
// 画面と保存パスを変えないために、Electron 側へユーザーIDの概念を逆流させない。
export const LOCAL_USER_CONTEXT: UserContext = Object.freeze({
  kind: 'local',
  userId: LOCAL_USER_ID,
});

export function isLocalUserContext(context: UserContext): boolean {
  return context.kind === 'local' && context.userId === LOCAL_USER_ID;
}

export class UnsupportedUserContextError extends Error {
  readonly contextKind: UserContextKind;

  // NOTE: userId はメッセージへ入れない。公開版では認証事業者の識別子が入り得るため、
  // 例外経由でログへ流出させない（設計書 5.1 の運用ログ方針）。
  constructor(operation: string, contextKind: UserContextKind) {
    super(`この保存実装は ${contextKind} コンテキストを扱えません: ${operation}`);
    this.name = 'UnsupportedUserContextError';
    this.contextKind = contextKind;
  }
}

export function assertLocalUserContext(context: UserContext, operation: string): void {
  if (!isLocalUserContext(context)) {
    throw new UnsupportedUserContextError(operation, context.kind);
  }
}
