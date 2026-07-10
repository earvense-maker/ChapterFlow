import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppSettingsPanel from '../../src/client/components/AppSettingsPanel';
import { api } from '../../src/client/clientApi';

vi.mock('../../src/client/clientApi', () => ({
  api: {
    getModelProviders: vi.fn(),
    getDefaultModelSettings: vi.fn(),
    updateDefaultModelSettings: vi.fn(),
    saveCredential: vi.fn(),
    getSystemVersion: vi.fn(),
  },
}));

vi.mock('../../src/client/components/DataDirSettingsSection', () => ({
  default: () => <div data-testid="data-dir-settings" />,
}));

const providers = [
  {
    name: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-3.5-flash',
    apiKeyPlaceholder: 'gemini-key',
    apiKeyHelp: 'Gemini help',
    hasApiKey: false,
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-v4-flash',
    apiKeyPlaceholder: 'deepseek-key',
    apiKeyHelp: 'DeepSeek help',
    hasApiKey: false,
  },
  {
    name: 'xai',
    label: 'xAI',
    defaultModel: 'grok-4.3',
    apiKeyPlaceholder: 'xai-...',
    apiKeyHelp: 'xAI help',
    hasApiKey: false,
  },
];

describe('AppSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getModelProviders).mockResolvedValue(providers);
    vi.mocked(api.getDefaultModelSettings).mockResolvedValue({
      provider: 'gemini',
      modelName: 'gemini-3.5-flash',
    });
    vi.mocked(api.getSystemVersion).mockResolvedValue({ version: '0.1.0', runtime: 'server' });
    vi.mocked(api.saveCredential).mockResolvedValue({ ok: true });
    vi.mocked(api.updateDefaultModelSettings).mockImplementation(async (body) => body);
  });

  it('saves the API key and selected provider as the model for new consultations', async () => {
    render(<AppSettingsPanel onBack={() => undefined} />);

    const providerSelect = await screen.findByLabelText('プロバイダー');
    expect(screen.getByRole('option', { name: 'xAI（キー未設定）' })).toBeInTheDocument();
    fireEvent.change(providerSelect, { target: { value: 'deepseek' } });
    fireEvent.change(screen.getByPlaceholderText('deepseek-key'), {
      target: { value: 'secret-test-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'APIキーを保存して相談で使う' }));

    await waitFor(() => {
      expect(api.saveCredential).toHaveBeenCalledWith('deepseek', 'secret-test-key');
      expect(api.updateDefaultModelSettings).toHaveBeenCalledWith({
        provider: 'deepseek',
        modelName: 'deepseek-v4-flash',
      });
    });
    expect(await screen.findByText(/APIキーを保存し、新しい相談で使うモデルに設定しました/)).toBeVisible();
  });

  it('opens the requested provider and can save its key without changing consultation defaults', async () => {
    render(<AppSettingsPanel initialProvider="deepseek" onBack={() => undefined} />);

    const providerSelect = await screen.findByLabelText('プロバイダー');
    expect(providerSelect).toHaveValue('deepseek');
    fireEvent.change(screen.getByPlaceholderText('deepseek-key'), {
      target: { value: 'deepseek-only-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'APIキーだけ保存' }));

    await waitFor(() => {
      expect(api.saveCredential).toHaveBeenCalledWith('deepseek', 'deepseek-only-key');
    });
    expect(api.updateDefaultModelSettings).not.toHaveBeenCalled();
    expect(await screen.findByText('DeepSeek のAPIキーを保存しました。')).toBeVisible();
  });
});
