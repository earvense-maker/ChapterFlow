import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import DataDirSettingsSection from './DataDirSettingsSection';
import type { ModelProviderInfo } from '@shared/types';

interface Props {
  onBack: () => void;
}

export default function AppSettingsPanel({ onBack }: Props) {
  const [dataDirBusy, setDataDirBusy] = useState(false);
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [providerList, defaultModel] = await Promise.all([
          api.getModelProviders(),
          api.getDefaultModelSettings(),
        ]);
        if (cancelled) return;
        const initialProvider =
          providerList.find((item) => item.name === defaultModel.provider) ?? providerList[0];
        setProviders(providerList);
        setProvider(initialProvider?.name ?? '');
        setModelName(
          initialProvider
            ? initialProvider.name === defaultModel.provider
              ? defaultModel.modelName
              : initialProvider.defaultModel
            : ''
        );
        setApiKey('');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '技術設定の読み込みに失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshProviders() {
    const providerList = await api.getModelProviders();
    setProviders(providerList);
  }

  async function saveModelSettings() {
    if (!provider || !modelName.trim()) {
      setError('プロバイダーとモデル名を入力してください。');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await api.updateDefaultModelSettings({ provider, modelName: modelName.trim() });
      setMessage('相談で使うモデル設定を保存しました。');
      window.setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'モデル設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  async function saveApiKey() {
    const trimmed = apiKey.trim();
    if (!provider || !trimmed) {
      setError('保存するAPIキーを入力してください。');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await api.saveCredential(provider, trimmed);
      setApiKey('');
      await refreshProviders();
      setMessage('APIキーを保存しました。');
      window.setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'APIキーの保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  const activeProvider = providers.find((item) => item.name === provider);
  const busy = dataDirBusy || saving;
  const hasProviders = providers.length > 0;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack} disabled={busy}>← 戻る</button>
        <h1>技術設定</h1>
      </header>
      {error && <div className="error-toast">{error}</div>}
      {message && <div className="status-toast">{message}</div>}
      {loading ? (
        <div className="loading">読み込み中…</div>
      ) : (
        <section className="settings-section">
          <h2>相談で使うモデル</h2>
          {!hasProviders && (
            <div className="story-state-alert stale">
              <div>
                <strong>モデルプロバイダーを読み込めませんでした</strong>
                <p>APIキーとモデル設定は、プロバイダー情報を読み込める状態で保存できます。</p>
              </div>
            </div>
          )}
          <label>
            プロバイダー
            <select
              value={provider}
              onChange={(e) => {
                const next = e.target.value;
                setProvider(next);
                setApiKey('');
                const defaultModel = providers.find((item) => item.name === next)?.defaultModel;
                if (defaultModel) setModelName(defaultModel);
              }}
              disabled={busy || !hasProviders}
            >
              {!hasProviders && <option value="">利用可能なプロバイダーがありません</option>}
              {providers.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}{item.hasApiKey === false ? '（キー未設定）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            モデル名
            <input
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={activeProvider?.defaultModel ?? 'gemini-3.5-flash'}
              disabled={busy || !hasProviders}
            />
          </label>
          <div className="summary-card-actions">
            <button className="primary" type="button" onClick={saveModelSettings} disabled={busy || !hasProviders}>
              モデル設定を保存
            </button>
          </div>

          <h2>APIキー</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            {activeProvider?.apiKeyHelp ??
              'APIキーを保存します。作品データとは別に、プロバイダーごとに1つ保存されます。'}
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={activeProvider?.apiKeyPlaceholder ?? 'sk-...'}
            disabled={busy || !hasProviders}
          />
          <div className="summary-card-actions">
            <button className="primary" type="button" onClick={saveApiKey} disabled={busy || !hasProviders || !apiKey.trim()}>
              APIキーを保存
            </button>
          </div>
        </section>
      )}
      <DataDirSettingsSection onBusyChange={setDataDirBusy} />
    </div>
  );
}
