import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TechSettingsTab from '../../src/client/components/TechSettingsTab';
import type { Project } from '../../src/shared/types';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelProviders: vi.fn(),
    getExpressions: vi.fn(),
    updateProject: vi.fn(),
  },
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

const baseProject: Project = {
  schemaVersion: 1,
  projectId: 'project-tech-settings',
  title: 'Tech settings',
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
  activeModelProvider: 'gemini',
  activeModelName: 'gemini-3.6-flash',
  outputLength: 3000,
  streamingEnabled: false,
  activePresetIds: { narration: 'third-close' },
};

describe('TechSettingsTab Gemini sampling settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelProviders.mockResolvedValue([
      {
        name: 'gemini',
        label: 'Gemini',
        defaultModel: 'gemini-3.6-flash',
        apiKeyPlaceholder: 'AIzaSy...',
        apiKeyHelp: 'Gemini help',
        hasApiKey: true,
      },
    ]);
    apiMock.getExpressions.mockResolvedValue({ ngExpressions: [] });
    apiMock.updateProject.mockImplementation(async (_projectId, patch) => ({
      ...baseProject,
      ...patch,
    }));
  });

  it.each([
    { modelName: 'gemini-3.6-flash', disabled: true },
    { modelName: 'gemini-3.5-flash-lite', disabled: true },
    { modelName: 'gemini-3.5-flash', disabled: false },
  ])('sets Temperature disabled=$disabled for $modelName', async ({ modelName, disabled }) => {
    renderSettings({ ...baseProject, activeModelName: modelName });
    await waitFor(() => expect(apiMock.getModelProviders).toHaveBeenCalled());

    expect(getTemperatureSlider()).toHaveProperty('disabled', disabled);
  });

  it('uses the Gemini provider default when the model field is empty', async () => {
    renderSettings({ ...baseProject, activeModelName: 'gemini-3.5-flash' });
    await waitFor(() => expect(apiMock.getModelProviders).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('モデル名'), { target: { value: '' } });

    expect(getTemperatureSlider()).toBeDisabled();
    expect(screen.getByText(/このGeminiモデルではTemperatureが廃止/)).toBeVisible();
  });

  it('keeps project NG expressions separate and links to common NG settings', async () => {
    const onOpenAppSettings = vi.fn();
    render(
      <TechSettingsTab
        projectId={baseProject.projectId}
        project={baseProject}
        onProjectUpdated={() => undefined}
        onError={() => undefined}
        onFlashMessage={() => undefined}
        onOpenAppSettings={onOpenAppSettings}
      />
    );

    expect(await screen.findByRole('heading', { name: 'この作品のNG表現' })).toBeVisible();
    expect(screen.getByText(/共通＋作品固有の新しい順で最大12件/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'アプリ設定を開く' }));
    expect(onOpenAppSettings).toHaveBeenCalledWith('gemini');
  });
});

function renderSettings(project: Project) {
  return render(
    <TechSettingsTab
      projectId={project.projectId}
      project={project}
      onProjectUpdated={() => undefined}
      onError={() => undefined}
      onFlashMessage={() => undefined}
      onOpenAppSettings={() => undefined}
    />
  );
}

function getTemperatureSlider(): HTMLInputElement {
  return screen.getAllByRole('slider')[0] as HTMLInputElement;
}
