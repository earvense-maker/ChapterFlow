import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfirmProvider,
  useConfirm,
} from '../../src/client/components/ConfirmDialog';

function ConfirmHarness() {
  const confirmAction = useConfirm();

  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const confirmed = await confirmAction('この操作を続けますか？', {
            confirmLabel: '続ける',
          });
          document.body.dataset.confirmResult = String(confirmed);
        }}
      >
        確認を開く
      </button>
    </div>
  );
}

function QueuedConfirmHarness() {
  const confirmAction = useConfirm();

  return (
    <button
      type="button"
      onClick={() => {
        void confirmAction('1つ目の確認', { confirmLabel: '続ける' }).then((result) => {
          document.body.dataset.firstConfirmResult = String(result);
        });
        void confirmAction('2つ目の確認', { confirmLabel: '続ける' }).then((result) => {
          document.body.dataset.secondConfirmResult = String(result);
        });
      }}
    >
      連続確認を開く
    </button>
  );
}

describe('ConfirmDialog', () => {
  beforeEach(() => {
    delete document.body.dataset.confirmResult;
    delete document.body.dataset.firstConfirmResult;
    delete document.body.dataset.secondConfirmResult;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('confirms without using the native window.confirm dialog', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(
      <ConfirmProvider>
        <ConfirmHarness />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: '確認を開く' }));

    expect(await screen.findByRole('dialog', { name: '確認' })).toBeVisible();
    expect(screen.getByText('この操作を続けますか？')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '続ける' }));

    await waitFor(() => expect(document.body.dataset.confirmResult).toBe('true'));
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('cancels with Escape and restores focus to the triggering control', async () => {
    render(
      <ConfirmProvider>
        <ConfirmHarness />
      </ConfirmProvider>
    );
    const trigger = screen.getByRole('button', { name: '確認を開く' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: '確認' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => {
      expect(document.body.dataset.confirmResult).toBe('false');
      expect(trigger).toHaveFocus();
    });
  });

  it('does not let a double-click confirm the next queued request', async () => {
    render(
      <ConfirmProvider>
        <QueuedConfirmHarness />
      </ConfirmProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: '連続確認を開く' }));

    const firstConfirmButton = await screen.findByRole('button', { name: '続ける' });
    fireEvent.click(firstConfirmButton);
    fireEvent.click(firstConfirmButton);

    await waitFor(() => expect(document.body.dataset.firstConfirmResult).toBe('true'));
    expect(document.body.dataset.secondConfirmResult).toBeUndefined();
    expect(screen.queryByText('2つ目の確認')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '連続確認を開く' })).not.toHaveFocus();
    expect(document.querySelector('.confirm-dialog-backdrop')).toBeInTheDocument();

    expect(await screen.findByText('2つ目の確認')).toBeVisible();
    expect(document.body.dataset.secondConfirmResult).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: '続ける' }));
    await waitFor(() => expect(document.body.dataset.secondConfirmResult).toBe('true'));
  });
});
