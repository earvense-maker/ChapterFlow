import { describe, expect, it, vi } from 'vitest';
import { launchDetachedBrowser } from '../../open-app-window.js';

describe('open-app-window', () => {
  it('launches the app-mode browser detached and lets the parent exit naturally', () => {
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    launchDetachedBrowser(
      'browser.exe',
      'http://localhost:5173',
      undefined,
      spawn as never
    );

    expect(spawn).toHaveBeenCalledWith(
      'browser.exe',
      ['--app=http://localhost:5173', '--window-size=1180,860'],
      { detached: true, stdio: 'ignore' }
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
