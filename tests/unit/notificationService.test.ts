import { describe, expect, it } from 'vitest';
import { resolveNotificationChannels } from '../../src/client/services/notificationService';
import type { GenerationNotificationSettings } from '../../src/shared/types';

function settings(overrides: Partial<GenerationNotificationSettings> = {}): GenerationNotificationSettings {
  return {
    soundEnabled: true,
    systemPopupEnabled: true,
    onlyWhenUnfocused: true,
    events: {
      firstOutput: true,
      completed: true,
      failed: true,
      settingsUpdated: true,
      reviewRequired: true,
    },
    ...overrides,
  };
}

describe('notificationService.resolveNotificationChannels', () => {
  it('returns nothing when the event type itself is disabled', () => {
    const result = resolveNotificationChannels(
      settings({ events: { firstOutput: false, completed: true, failed: true, settingsUpdated: true, reviewRequired: true } }),
      'firstOutput',
      { visible: true, focused: true }
    );
    expect(result).toEqual({ sound: false, popup: false, inApp: false });
  });

  it('always shows in-app when the event type is enabled, regardless of focus', () => {
    const focused = resolveNotificationChannels(settings(), 'completed', { visible: true, focused: true });
    const unfocused = resolveNotificationChannels(settings(), 'completed', { visible: false, focused: false });
    expect(focused.inApp).toBe(true);
    expect(unfocused.inApp).toBe(true);
  });

  it('suppresses sound/popup while focused when onlyWhenUnfocused is true', () => {
    const result = resolveNotificationChannels(settings({ onlyWhenUnfocused: true }), 'completed', {
      visible: true,
      focused: true,
    });
    expect(result.sound).toBe(false);
    expect(result.popup).toBe(false);
  });

  it('allows sound/popup when unfocused and onlyWhenUnfocused is true', () => {
    const result = resolveNotificationChannels(settings({ onlyWhenUnfocused: true }), 'completed', {
      visible: false,
      focused: false,
    });
    expect(result.sound).toBe(true);
    expect(result.popup).toBe(true);
  });

  it('allows sound/popup when only visibility is not "visible", even if hasFocus is true', () => {
    const result = resolveNotificationChannels(settings({ onlyWhenUnfocused: true }), 'completed', {
      visible: false,
      focused: true,
    });
    expect(result.sound).toBe(true);
    expect(result.popup).toBe(true);
  });

  it('allows sound/popup while focused when onlyWhenUnfocused is false', () => {
    const result = resolveNotificationChannels(settings({ onlyWhenUnfocused: false }), 'completed', {
      visible: true,
      focused: true,
    });
    expect(result.sound).toBe(true);
    expect(result.popup).toBe(true);
  });

  it('never enables sound when soundEnabled is false, even when unfocused', () => {
    const result = resolveNotificationChannels(settings({ soundEnabled: false }), 'completed', {
      visible: false,
      focused: false,
    });
    expect(result.sound).toBe(false);
    expect(result.popup).toBe(true);
  });

  it('never enables popup when systemPopupEnabled is false, even when unfocused', () => {
    const result = resolveNotificationChannels(settings({ systemPopupEnabled: false }), 'completed', {
      visible: false,
      focused: false,
    });
    expect(result.popup).toBe(false);
    expect(result.sound).toBe(true);
  });
});
