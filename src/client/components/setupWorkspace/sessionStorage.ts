import type { SetupPurpose } from '@shared/types';

const SETUP_SESSION_STORAGE_KEY_BASE = 'chapterflow:lastSetupSessionId';
const LEGACY_SETUP_SESSION_STORAGE_KEY_BASE = 'yumeweaving:lastSetupSessionId';

// NOTE: purpose 別に localStorage キーを分ける。roleplay 入口から novel の未commit
// セッションを誤復元しないための境界（設計書 1.5）。
function setupSessionStorageKey(purpose: SetupPurpose): string {
  return purpose === 'roleplay'
    ? `${SETUP_SESSION_STORAGE_KEY_BASE}:roleplay`
    : `${SETUP_SESSION_STORAGE_KEY_BASE}:novel`;
}

function legacySetupSessionStorageKey(purpose: SetupPurpose): string {
  return purpose === 'roleplay'
    ? `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:roleplay`
    : `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:novel`;
}

export function readStoredSetupSessionId(purpose: SetupPurpose = 'novel'): string | null {
  try {
    const key = setupSessionStorageKey(purpose);
    const current = window.localStorage.getItem(key);
    if (current) return current;

    const legacyKey = legacySetupSessionStorageKey(purpose);
    const legacy = window.localStorage.getItem(legacyKey);
    if (legacy) {
      window.localStorage.setItem(key, legacy);
      window.localStorage.removeItem(legacyKey);
    }
    return legacy;
  } catch {
    return null;
  }
}

export function rememberSetupSession(
  sessionId: string,
  purpose: SetupPurpose = 'novel'
): void {
  try {
    window.localStorage.setItem(setupSessionStorageKey(purpose), sessionId);
  } catch {
    // localStorageが使えない環境では、サーバ側の一覧復帰に任せる
  }
}

export function forgetSetupSession(
  sessionId?: string,
  purpose: SetupPurpose = 'novel'
): void {
  try {
    for (const key of [
      setupSessionStorageKey(purpose),
      legacySetupSessionStorageKey(purpose),
    ]) {
      const current = window.localStorage.getItem(key);
      if (!sessionId || current === sessionId) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // localStorageが使えない環境では何もしない
  }
}
