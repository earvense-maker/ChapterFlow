import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetSetupSession,
  readStoredSetupSessionId,
  rememberSetupSession,
} from '../../src/client/components/setupWorkspace/sessionStorage';

describe('setup session storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps novel and roleplay sessions separate', () => {
    rememberSetupSession('novel-session', 'novel');
    rememberSetupSession('roleplay-session', 'roleplay');

    expect(readStoredSetupSessionId('novel')).toBe('novel-session');
    expect(readStoredSetupSessionId('roleplay')).toBe('roleplay-session');
  });

  it('migrates a legacy session id when it is read', () => {
    window.localStorage.setItem('yumeweaving:lastSetupSessionId:novel', 'legacy-session');

    expect(readStoredSetupSessionId('novel')).toBe('legacy-session');
    expect(window.localStorage.getItem('chapterflow:lastSetupSessionId:novel')).toBe(
      'legacy-session'
    );
    expect(window.localStorage.getItem('yumeweaving:lastSetupSessionId:novel')).toBeNull();
  });

  it('only forgets the expected session id', () => {
    rememberSetupSession('current-session', 'novel');

    forgetSetupSession('different-session', 'novel');
    expect(readStoredSetupSessionId('novel')).toBe('current-session');

    forgetSetupSession('current-session', 'novel');
    expect(readStoredSetupSessionId('novel')).toBeNull();
  });
});
