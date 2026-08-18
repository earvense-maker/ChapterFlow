import type { ExperienceMode, SetupPurpose } from '@shared/types';

const SETUP_SESSION_STORAGE_KEY_BASE = 'chapterflow:lastSetupSessionId';
const LEGACY_SETUP_SESSION_STORAGE_KEY_BASE = 'yumeweaving:lastSetupSessionId';

// NOTE: purpose 別に localStorage キーを分ける。roleplay 入口から novel の未commit
// セッションを誤復元しないための境界（設計書 1.5）。
// さらに体験モードは experienceMode もキーに含める。同じ purpose=novel でも、通常作品の
// 相談を妄想増幅器の入口から誤復元してはならない（設計書 4.1）。夢見るモードも同じ理由で
// 分離する（設計書 §10: standard / amplifier / dream ごとに分ける）。
function setupSessionStorageKey(purpose: SetupPurpose, experienceMode: ExperienceMode = 'standard'): string {
  const modeSuffix =
    experienceMode === 'amplifier' ? ':amplifier' : experienceMode === 'dream' ? ':dream' : '';
  return `${SETUP_SESSION_STORAGE_KEY_BASE}:${purpose}${modeSuffix}`;
}

function legacySetupSessionStorageKey(purpose: SetupPurpose): string {
  return purpose === 'roleplay'
    ? `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:roleplay`
    : `${LEGACY_SETUP_SESSION_STORAGE_KEY_BASE}:novel`;
}

export function readStoredSetupSessionId(
  purpose: SetupPurpose = 'novel',
  experienceMode: ExperienceMode = 'standard'
): string | null {
  try {
    const key = setupSessionStorageKey(purpose, experienceMode);
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
  purpose: SetupPurpose = 'novel',
  experienceMode: ExperienceMode = 'standard'
): void {
  try {
    window.localStorage.setItem(setupSessionStorageKey(purpose, experienceMode), sessionId);
  } catch {
    // localStorageが使えない環境では、サーバ側の一覧復帰に任せる
  }
}

export function forgetSetupSession(
  sessionId?: string,
  purpose: SetupPurpose = 'novel',
  experienceMode: ExperienceMode = 'standard'
): void {
  try {
    for (const key of [
      setupSessionStorageKey(purpose, experienceMode),
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
