import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectForm from '../../src/client/components/ProjectForm';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getPresets: vi.fn(),
    getModelProviders: vi.fn(),
    saveCredential: vi.fn(),
    createProject: vi.fn(),
  },
}));

vi.mock('../../src/client/clientApi', () => ({ api: apiMock }));

describe('ProjectForm layout', () => {
  beforeEach(() => {
    apiMock.getPresets.mockReset().mockResolvedValue({
      categories: {
        narration: {
          label: '語り',
          items: {
            'third-close': {
              id: 'third-close',
              label: '三人称・視点人物に寄り添う',
              text: '視点人物の認識と感情に寄り添う。',
            },
          },
        },
      },
    });
    apiMock.getModelProviders.mockReset().mockResolvedValue([
      {
        name: 'gemini',
        label: 'Gemini',
        defaultModel: 'gemini-test',
        apiKeyHelp: 'Gemini APIキー',
        apiKeyPlaceholder: 'AIza...',
        models: [],
      },
    ]);
    apiMock.saveCredential.mockReset().mockResolvedValue(undefined);
    apiMock.createProject.mockReset().mockResolvedValue({ projectId: 'proj-created' });
  });

  it('uses a setup-style header, collapses presets, and places the API key after model name', async () => {
    const { container } = render(
      <ProjectForm onCreated={vi.fn()} onCancel={vi.fn()} />
    );

    expect(await screen.findByRole('heading', { name: '設定を直接入力' })).toBeVisible();
    const header = screen.getByRole('banner');
    expect(header).toHaveClass('setup-header');
    expect(screen.getAllByRole('button', { name: '作品を作成' })).toHaveLength(2);

    const presets = container.querySelector('details.settings-section-collapsible');
    expect(presets).toBeInstanceOf(HTMLDetailsElement);
    expect((presets as HTMLDetailsElement).open).toBe(false);
    fireEvent.click(screen.getByText('プリセット'));
    expect((presets as HTMLDetailsElement).open).toBe(true);

    const modelInput = screen.getByLabelText('モデル名');
    const apiKeyInput = screen.getByLabelText('APIキー');
    expect(
      modelInput.compareDocumentPosition(apiKeyInput) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(apiKeyInput).toHaveAttribute('placeholder', 'AIza...');
  });

  it('disables cancellation while project creation is in flight', async () => {
    let completeCreation: (value: { projectId: string }) => void;
    apiMock.createProject.mockImplementation(
      () =>
        new Promise<{ projectId: string }>((resolve) => {
          completeCreation = resolve;
        })
    );
    const onCreated = vi.fn();
    const onCancel = vi.fn();
    render(<ProjectForm onCreated={onCreated} onCancel={onCancel} />);

    await screen.findByRole('heading', { name: '設定を直接入力' });
    fireEvent.click(screen.getAllByRole('button', { name: '作品を作成' })[0]);

    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    await waitFor(() => expect(cancel).toBeDisabled());
    fireEvent.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();

    completeCreation!({ projectId: 'proj-created' });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('proj-created'));
  });
});
