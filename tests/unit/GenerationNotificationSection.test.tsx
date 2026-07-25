import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GenerationNotificationSection from '../../src/client/components/GenerationNotificationSection';
import { DEFAULT_GENERATION_NOTIFICATION_SETTINGS } from '../../src/shared/defaults';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getNotificationSettings: vi.fn(),
    updateNotificationSettings: vi.fn(),
  },
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

describe('GenerationNotificationSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getNotificationSettings.mockResolvedValue(DEFAULT_GENERATION_NOTIFICATION_SETTINGS);
    apiMock.updateNotificationSettings.mockImplementation(async (next) => next);
  });

  it('persists the picked notification sound', async () => {
    const onFlashMessage = vi.fn();
    render(<GenerationNotificationSection onError={() => undefined} onFlashMessage={onFlashMessage} />);

    const select = (await screen.findByLabelText('通知音の種類')) as HTMLSelectElement;
    expect(select.value).toBe('chime');
    fireEvent.change(select, { target: { value: 'marimba' } });

    await waitFor(() => {
      expect(apiMock.updateNotificationSettings).toHaveBeenCalledWith(
        expect.objectContaining({ soundId: 'marimba' })
      );
    });
    expect(onFlashMessage).toHaveBeenCalledWith('生成通知の設定を保存しました。');
  });

  it('keeps the sound toggle independent from the picked sound', async () => {
    render(<GenerationNotificationSection onError={() => undefined} onFlashMessage={() => undefined} />);

    const toggle = await screen.findByLabelText('通知音を鳴らす');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(apiMock.updateNotificationSettings).toHaveBeenCalledWith(
        expect.objectContaining({ soundEnabled: true, soundId: 'chime' })
      );
    });
  });

  it('reports a read failure through onError instead of throwing', async () => {
    apiMock.getNotificationSettings.mockRejectedValue(new Error('読み込み失敗'));
    const onError = vi.fn();
    render(<GenerationNotificationSection onError={onError} onFlashMessage={() => undefined} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith('読み込み失敗'));
    // NOTE: 失敗したまま「読み込み中…」が残ると復帰手段が分からないので、節内の表示まで固定する。
    expect(await screen.findByText(/通知設定を読み込めませんでした/)).toBeVisible();
    expect(screen.queryByText('読み込み中…')).toBeNull();
  });
});
