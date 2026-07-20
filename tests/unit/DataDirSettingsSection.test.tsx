import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataDirSettingsSection from '../../src/client/components/DataDirSettingsSection';
import { api } from '../../src/client/clientApi';

const { confirmAction } = vi.hoisted(() => ({
  confirmAction: vi.fn(),
}));

vi.mock('../../src/client/clientApi', () => ({
  api: {
    getDataDirInfo: vi.fn(),
    getSystemVersion: vi.fn(),
    previewDataDirMove: vi.fn(),
    applyDataDirMove: vi.fn(),
    previewDataDirSwitch: vi.fn(),
    applyDataDirSwitch: vi.fn(),
    selectDataDirFolder: vi.fn(),
  },
}));

vi.mock('../../src/client/components/ConfirmDialog', () => ({
  useConfirm: () => confirmAction,
}));

describe('DataDirSettingsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getDataDirInfo).mockResolvedValue({
      current: 'C:\\Users\\test\\Documents\\ChapterFlow',
      defaultPath: 'C:\\Users\\test\\Documents\\ChapterFlow',
      isUsingDefault: true,
      pendingCleanup: null,
      previousDataDir: 'D:\\Previous\\ChapterFlow',
    });
    vi.mocked(api.getSystemVersion).mockResolvedValue({
      version: '0.1.0',
      runtime: 'electron',
    });
    vi.mocked(api.selectDataDirFolder).mockResolvedValue({
      path: 'D:\\Existing\\ChapterFlow',
    });
    vi.mocked(api.previewDataDirSwitch).mockResolvedValue({
      resolvedPath: 'D:\\Existing\\ChapterFlow',
      projectCount: 1,
      projects: [
        {
          projectId: 'project-existing',
          title: '既存作品',
          updatedAt: '2026-07-20T02:00:00.000Z',
        },
      ],
      unreadableProjectIds: [],
      hasCredentials: true,
    });
    vi.mocked(api.applyDataDirSwitch).mockResolvedValue({
      ok: true,
      dataDir: 'D:\\Existing\\ChapterFlow',
      previousDataDir: 'C:\\Users\\test\\Documents\\ChapterFlow',
      restartScheduled: true,
    });
    confirmAction.mockResolvedValue(true);
  });

  it('keeps switching separate from moving and previews existing projects before applying', async () => {
    const { container, unmount } = render(<DataDirSettingsSection />);

    expect(await screen.findByRole('button', { name: 'この場所へ移動する' })).toBeVisible();
    fireEvent.click(screen.getByText('既存の保存先に切り替える（詳細）'));
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    const switchUi = within(details as HTMLElement);

    fireEvent.click(switchUi.getByRole('button', { name: '参照…' }));

    await waitFor(() => {
      expect(api.selectDataDirFolder).toHaveBeenCalledWith(
        'D:\\Previous\\ChapterFlow',
        'switch'
      );
      expect(api.previewDataDirSwitch).toHaveBeenCalledWith('D:\\Existing\\ChapterFlow');
    });
    expect(await switchUi.findByText('既存作品')).toBeVisible();
    expect(switchUi.getByText('選択先に保存済みの設定を使用します')).toBeVisible();

    fireEvent.click(switchUi.getByRole('button', { name: 'この保存先へ切り替える' }));

    await waitFor(() => {
      expect(confirmAction).toHaveBeenCalledWith(
        expect.stringContaining('現在のデータはコピーも削除もされません'),
        { confirmLabel: '切り替えて再起動' }
      );
      expect(api.applyDataDirSwitch).toHaveBeenCalledWith('D:\\Existing\\ChapterFlow');
    });
    unmount();
  });
});
