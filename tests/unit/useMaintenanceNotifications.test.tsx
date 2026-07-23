import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationProvider,
  useNotificationCenter,
} from '../../src/client/components/NotificationCenter';
import { useMaintenanceNotifications } from '../../src/client/hooks/useMaintenanceNotifications';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getNotificationSettings: vi.fn(),
    getRefineAutomationSettings: vi.fn(),
    getRefineAutomationRuns: vi.fn(),
  },
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const notificationSettings = {
  soundEnabled: false,
  systemPopupEnabled: false,
  onlyWhenUnfocused: false,
  events: {
    firstOutput: true,
    completed: true,
    failed: true,
    settingsUpdated: true,
    reviewRequired: true,
  },
};

function Harness() {
  const center = useNotificationCenter();
  useMaintenanceNotifications();
  return (
    <>
      <button type="button" onClick={() => center.addMaintenanceWatch('proj-watch')}>
        監視開始
      </button>
      <span data-testid="watch-count">{center.maintenanceWatchProjectIds.size}</span>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMaintenanceNotifications', () => {
  it('notifies a terminal review state and releases its watcher', async () => {
    apiMock.getNotificationSettings.mockResolvedValue(notificationSettings);
    apiMock.getRefineAutomationSettings.mockResolvedValue({
      status: {
        runId: 'run-review',
        phase: 'needsReview',
        appliedPatchIds: [],
        pendingPatchIds: ['patch-1'],
      },
    });
    apiMock.getRefineAutomationRuns.mockResolvedValue([]);

    render(
      <NotificationProvider>
        <Harness />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('監視開始'));

    expect(await screen.findByText('確認が必要な提案があります')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('watch-count')).toHaveTextContent('0'));
  });

  it('keeps awaiting-acceptance projects watched after notifying', async () => {
    apiMock.getNotificationSettings.mockResolvedValue(notificationSettings);
    apiMock.getRefineAutomationSettings.mockResolvedValue({
      status: {
        runId: 'run-awaiting',
        phase: 'awaitingAcceptance',
        appliedPatchIds: [],
        pendingPatchIds: ['patch-1'],
      },
    });
    apiMock.getRefineAutomationRuns.mockResolvedValue([]);

    render(
      <NotificationProvider>
        <Harness />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('監視開始'));

    expect(await screen.findByText('採用後に反映する提案があります')).toBeInTheDocument();
    expect(screen.getByTestId('watch-count')).toHaveTextContent('1');
  });
});
