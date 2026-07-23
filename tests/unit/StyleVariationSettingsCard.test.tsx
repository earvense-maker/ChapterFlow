import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StyleVariationSettingsCard from '../../src/client/components/StyleVariationSettingsCard';
import { api } from '../../src/client/clientApi';
import type { Project } from '../../src/shared/types';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    updateProject: vi.fn(),
  },
}));

const project: Project = {
  schemaVersion: 1,
  projectId: 'proj-style-settings',
  title: '文体設定',
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z',
  activeModelProvider: 'gemini',
  activeModelName: 'gemini-test',
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: { narration: 'third-close' },
};

describe('StyleVariationSettingsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts disabled for a legacy project and saves normalized user choices', async () => {
    vi.mocked(api.updateProject).mockImplementation(async (_projectId, updates) => ({
      ...project,
      ...updates,
    }));
    const onProjectUpdated = vi.fn();
    const onFlashMessage = vi.fn();

    render(
      <StyleVariationSettingsCard
        project={project}
        onProjectUpdated={onProjectUpdated}
        onError={vi.fn()}
        onFlashMessage={onFlashMessage}
      />
    );

    const enabled = screen.getByRole('checkbox', {
      name: '場面ごとに文体へ小さな傾きを加える',
    });
    expect(enabled).not.toBeChecked();
    expect(screen.getByText(/文体見本を登録すると本人性を保ちやすくなります/)).toBeVisible();

    fireEvent.click(enabled);
    fireEvent.change(screen.getByLabelText('強さ'), { target: { value: 'balanced' } });
    fireEvent.click(screen.getByText('高度な設定'));
    fireEvent.change(screen.getByLabelText('減衰しない意図的モチーフ・口癖（1行1件）'), {
      target: { value: '月\n月\n「大丈夫」' },
    });
    fireEvent.click(screen.getByRole('button', { name: '文体変調設定を保存' }));

    await waitFor(() => {
      expect(api.updateProject).toHaveBeenCalledWith(
        'proj-style-settings',
        expect.objectContaining({
          styleVariation: expect.objectContaining({
            enabled: true,
            intensity: 'balanced',
            motifExclusions: ['月', '「大丈夫」'],
          }),
        })
      );
    });
    expect(onProjectUpdated).toHaveBeenCalled();
    expect(onFlashMessage).toHaveBeenCalledWith('文体変調設定を保存しました');
  });
});
