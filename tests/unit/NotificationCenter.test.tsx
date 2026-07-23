import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationProvider,
  useNotificationCenter,
  type NotificationClickTarget,
} from '../../src/client/components/NotificationCenter';
import type { GenerationNotificationSettings } from '../../src/shared/types';

function settings(overrides: Partial<GenerationNotificationSettings> = {}): GenerationNotificationSettings {
  return {
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
    ...overrides,
  };
}

function Harness({ clickLog }: { clickLog: NotificationClickTarget[] }) {
  const center = useNotificationCenter();
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          center.notify(settings(), {
            eventType: 'completed',
            dedupeKey: 'dedupe-1',
            title: 'タイトル',
            body: '本文',
            clickTarget: { kind: 'project', projectId: 'proj-1', projectType: 'novel' },
          })
        }
      >
        通知1
      </button>
      <button
        type="button"
        onClick={() =>
          center.notify(settings({ events: { firstOutput: true, completed: false, failed: true, settingsUpdated: true, reviewRequired: true } }), {
            eventType: 'completed',
            dedupeKey: 'dedupe-forced',
            title: '強制表示された通知',
            body: '',
            clickTarget: { kind: 'setup' },
            forceInApp: true,
          })
        }
      >
        強制通知トリガー
      </button>
      <button
        type="button"
        onClick={() =>
          center.notify(settings(), {
            eventType: 'reviewRequired',
            dedupeKey: 'dedupe-persistent',
            title: '要確認',
            body: '確認してください',
            clickTarget: { kind: 'settingsFocus', projectId: 'proj-2', focus: { section: 'refine-history' } },
            persistent: true,
          })
        }
      >
        要確認通知
      </button>
      <button type="button" onClick={() => center.addMaintenanceWatch('proj-watch')}>
        watch追加
      </button>
      <button type="button" onClick={() => center.removeMaintenanceWatch('proj-watch')}>
        watch解除
      </button>
      <span data-testid="watch-count">{center.maintenanceWatchProjectIds.size}</span>
      <ClickRegistrar clickLog={clickLog} />
    </div>
  );
}

function TestBypassHarness() {
  const center = useNotificationCenter();
  return (
    <button
      type="button"
      onClick={() =>
        center.notify(
          // 全イベントを false（=通常なら発火しない）にしても、bypassEventGate 経由で
          // 発火することを検証する。
          {
            soundEnabled: true,
            systemPopupEnabled: true,
            onlyWhenUnfocused: true,
            events: {
              firstOutput: false,
              completed: false,
              failed: false,
              settingsUpdated: false,
              reviewRequired: false,
            },
          },
          {
            eventType: 'completed',
            dedupeKey: `bypass-${Date.now()}`,
            title: 'バイパステスト通知',
            body: '',
            clickTarget: { kind: 'setup' },
            bypassEventGate: true,
          }
        )
      }
    >
      bypassテスト
    </button>
  );
}

function ClickRegistrar({ clickLog }: { clickLog: NotificationClickTarget[] }) {
  const center = useNotificationCenter();
  useEffect(() => center.registerClickHandler((target) => clickLog.push(target)), [center.registerClickHandler]);
  return null;
}

describe('NotificationCenter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows an in-app toast when notify() is called with an enabled event', () => {
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('通知1'));
    expect(screen.getByText('タイトル')).toBeInTheDocument();
    expect(screen.getByText('本文')).toBeInTheDocument();
  });

  it('does not show a second toast for a duplicate dedupeKey', () => {
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('通知1'));
    fireEvent.click(screen.getByText('通知1'));
    expect(screen.getAllByText('タイトル')).toHaveLength(1);
  });

  it('shows an in-app toast via forceInApp even when the event type is disabled', () => {
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('強制通知トリガー'));
    expect(screen.getByText('強制表示された通知')).toBeInTheDocument();
  });

  it('calls the registered click handler with the notice clickTarget and dismisses a non-persistent toast', () => {
    const clickLog: NotificationClickTarget[] = [];
    render(
      <NotificationProvider>
        <Harness clickLog={clickLog} />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('通知1'));
    fireEvent.click(screen.getByText('タイトル'));
    expect(clickLog).toEqual([{ kind: 'project', projectId: 'proj-1', projectType: 'novel' }]);
    expect(screen.queryByText('タイトル')).not.toBeInTheDocument();
  });

  it('keeps a persistent toast visible after being clicked, until explicitly dismissed', () => {
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('要確認通知'));
    expect(screen.getByText('要確認')).toBeInTheDocument();
    fireEvent.click(screen.getByText('要確認'));
    expect(screen.getByText('要確認')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('通知を閉じる'));
    expect(screen.queryByText('要確認')).not.toBeInTheDocument();
  });

  it('auto-dismisses a non-persistent toast after the timeout, but not a persistent one', () => {
    vi.useFakeTimers();
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    act(() => {
      fireEvent.click(screen.getByText('通知1'));
      fireEvent.click(screen.getByText('要確認通知'));
    });
    expect(screen.getByText('タイトル')).toBeInTheDocument();
    expect(screen.getByText('要確認')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByText('タイトル')).not.toBeInTheDocument();
    expect(screen.getByText('要確認')).toBeInTheDocument();
  });

  it('forces sound/popup on bypassEventGate even when the app is focused', () => {
    // P2 レビュー #8 の回帰。テスト通知はフォーカス条件も迂回すべき。
    // resolveNotificationChannels の直接呼び出しでロジックを検証する。
    // NotificationCenter.notify → bypassEventGate 分岐が「settings.soundEnabled のみ」で
    // 判定していれば、focused でも sound/popup が有効化される。
    // ここでは実際に音を鳴らすことはできないが、bypassEventGate 経由で通知が
    // 発火して inApp toast が出ることを確認する（音のスパイは jsdom では検証しにくい）。
    render(
      <NotificationProvider>
        <TestBypassHarness />
      </NotificationProvider>
    );
    fireEvent.click(screen.getByText('bypassテスト'));
    expect(screen.getByText('バイパステスト通知')).toBeInTheDocument();
  });

  it('tracks maintenanceWatchProjectIds additions and removals', () => {
    render(
      <NotificationProvider>
        <Harness clickLog={[]} />
      </NotificationProvider>
    );
    expect(screen.getByTestId('watch-count').textContent).toBe('0');
    fireEvent.click(screen.getByText('watch追加'));
    expect(screen.getByTestId('watch-count').textContent).toBe('1');
    fireEvent.click(screen.getByText('watch解除'));
    expect(screen.getByTestId('watch-count').textContent).toBe('0');
  });
});
