import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { DEFAULT_GEMINI_MODEL } from '@shared/defaults';
import DataDirSettingsSection from './DataDirSettingsSection';
import type { ModelProviderInfo, NgExpression } from '@shared/types';

interface Props {
  onBack: () => void;
  initialProvider?: string;
}

export default function AppSettingsPanel({ onBack, initialProvider }: Props) {
  const [dataDirBusy, setDataDirBusy] = useState(false);
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [provider, setProvider] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [globalExpressions, setGlobalExpressions] = useState<NgExpression[]>([]);
  const [newGlobalExpression, setNewGlobalExpression] = useState('');
  const [globalLoading, setGlobalLoading] = useState(true);
  const [globalSaving, setGlobalSaving] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const [providerList, defaultModel, versionInfo] = await Promise.all([
          api.getModelProviders(),
          api.getDefaultModelSettings(),
          api.getSystemVersion().catch(() => null),
        ]);
        if (cancelled) return;
        const selectedProvider =
          providerList.find((item) => item.name === initialProvider) ??
          providerList.find((item) => item.name === defaultModel.provider) ??
          providerList[0];
        setProviders(providerList);
        setProvider(selectedProvider?.name ?? '');
        setModelName(
          selectedProvider
            ? selectedProvider.name === defaultModel.provider
              ? defaultModel.modelName
              : selectedProvider.defaultModel
            : ''
        );
        setApiKey('');
        setAppVersion(versionInfo?.version ?? '');
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'アプリ設定の読み込みに失敗しました');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    async function loadGlobalExpressions() {
      try {
        setGlobalLoading(true);
        setGlobalError(null);
        const data = await api.getGlobalExpressions();
        if (!cancelled) setGlobalExpressions(data.ngExpressions);
      } catch (err) {
        if (!cancelled) {
          setGlobalError(err instanceof Error ? err.message : '共通NG表現の読み込みに失敗しました');
        }
      } finally {
        if (!cancelled) setGlobalLoading(false);
      }
    }
    void load();
    void loadGlobalExpressions();
    return () => {
      cancelled = true;
    };
  }, [initialProvider]);

  async function refreshProviders() {
    const providerList = await api.getModelProviders();
    setProviders(providerList);
  }

  async function reloadGlobalExpressions() {
    const data = await api.getGlobalExpressions();
    setGlobalExpressions(data.ngExpressions);
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
      showMessage('新しい相談で使うモデルを保存しました。');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'モデル設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  async function saveApiKey(useForNewConsultations: boolean) {
    const trimmed = apiKey.trim();
    if (!provider || !trimmed) {
      setError('保存するAPIキーを入力してください。');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await api.saveCredential(provider, trimmed);
      if (useForNewConsultations) {
        try {
          await api.updateDefaultModelSettings({ provider, modelName: modelName.trim() });
        } catch (err) {
          setApiKey('');
          await refreshProviders().catch(() => undefined);
          setError(
            `APIキーは保存しましたが、相談モデルを変更できませんでした: ${
              err instanceof Error ? err.message : 'モデル設定の保存に失敗しました'
            }`
          );
          return;
        }
      }
      setApiKey('');
      try {
        await refreshProviders();
      } catch {
        setProviders((current) =>
          current.map((item) => item.name === provider ? { ...item, hasApiKey: true } : item)
        );
        showMessage('APIキーは保存しましたが、表示の更新に失敗しました。次回表示時に反映されます。');
        return;
      }
      showMessage(useForNewConsultations
        ? `${activeProvider?.label ?? provider} のAPIキーを保存し、新しい相談で使うモデルに設定しました。`
        : `${activeProvider?.label ?? provider} のAPIキーを保存しました。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'APIキーの保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  async function addGlobalExpression() {
    const text = newGlobalExpression.trim();
    if (!text) return;
    try {
      setGlobalSaving(true);
      setGlobalError(null);
      await api.createGlobalExpression({ text, source: 'manual' });
      await reloadGlobalExpressions();
      setNewGlobalExpression('');
      showMessage('共通NG表現を登録しました。');
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : '共通NG表現の登録に失敗しました');
    } finally {
      setGlobalSaving(false);
    }
  }

  async function archiveGlobalExpression(expressionId: string) {
    try {
      setGlobalSaving(true);
      setGlobalError(null);
      await api.archiveGlobalExpression(expressionId);
      await reloadGlobalExpressions();
      showMessage('共通NG表現を削除しました。');
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : '共通NG表現の削除に失敗しました');
    } finally {
      setGlobalSaving(false);
    }
  }

  function showMessage(text: string) {
    setMessage(text);
    window.setTimeout(() => setMessage(null), 5000);
  }

  const activeProvider = providers.find((item) => item.name === provider);
  const busy = dataDirBusy || saving;
  const hasProviders = providers.length > 0;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack} disabled={busy}>← 戻る</button>
        <h1>アプリ設定</h1>
      </header>
      {error && <div className="error-toast">{error}</div>}
      {message && <div className="status-toast">{message}</div>}
      {loading ? (
        <div className="loading">読み込み中…</div>
      ) : (
        <section className="settings-section">
          <h2>新しい相談で使うモデル</h2>
          <p className="settings-help">
            新しく始める相談の初期モデルです。進行中の相談は、相談画面で変更できます。
          </p>
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
              placeholder={activeProvider?.defaultModel ?? DEFAULT_GEMINI_MODEL}
              disabled={busy || !hasProviders}
            />
          </label>
          <div className="summary-card-actions">
            <button className="primary" type="button" onClick={saveModelSettings} disabled={busy || !hasProviders}>
              新しい相談のモデルを保存
            </button>
          </div>

          <h2>APIキー</h2>
          <p className="settings-help">
            APIキーはアプリ全体に保存され、相談とすべての作品で共有されます。
          </p>
          <p className="settings-help">
            APIキーはPC内に平文で保存されます。生成や相談では、入力内容と作品情報の必要な部分を
            選択したモデルプロバイダーへ送信します。利用量に応じて料金が発生する場合があります。
          </p>
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
            <button type="button" onClick={() => saveApiKey(false)} disabled={busy || !hasProviders || !apiKey.trim()}>
              APIキーだけ保存
            </button>
            <button className="primary" type="button" onClick={() => saveApiKey(true)} disabled={busy || !hasProviders || !apiKey.trim() || !modelName.trim()}>
              APIキーを保存して相談で使う
            </button>
          </div>
        </section>
      )}
      <section className="settings-section">
        <h2>共通NG表現</h2>
        <p className="settings-help">
          すべての作品とロールプレイで避けたい表現を登録します。作品だけで避けたい表現は、その作品の設定で登録してください。
        </p>
        <p className="settings-help">
          共通＋作品固有の新しい順で最大12件が生成に使われます。
        </p>
        {globalError && <div className="refine-scan-error">{globalError}</div>}
        {globalLoading ? (
          <div className="loading">共通NG表現を読み込み中…</div>
        ) : (
          <>
            <div className="ng-expression-form">
              <input
                type="text"
                value={newGlobalExpression}
                onChange={(event) => setNewGlobalExpression(event.target.value)}
                placeholder="例：息を呑んだ"
                maxLength={30}
                disabled={dataDirBusy || globalSaving}
              />
              <button
                type="button"
                onClick={addGlobalExpression}
                disabled={dataDirBusy || globalSaving || !newGlobalExpression.trim()}
              >
                追加
              </button>
            </div>
            {globalExpressions.length >= 45 && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>
                共通NG表現が上限（50件）に近づいています。
              </p>
            )}
            <ul className="ng-expression-list">
              {globalExpressions.map((expression) => (
                <li key={expression.id} className="ng-expression-item">
                  <span>「{expression.text}」</span>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => archiveGlobalExpression(expression.id)}
                    disabled={dataDirBusy || globalSaving}
                  >
                    削除
                  </button>
                </li>
              ))}
            </ul>
            {globalExpressions.length === 0 && !globalError && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                登録された共通NG表現はありません。
              </p>
            )}
          </>
        )}
      </section>
      <DataDirSettingsSection onBusyChange={setDataDirBusy} />
      {appVersion && (
        <section className="settings-section">
          <h2>アプリ情報</h2>
          <p className="settings-help">バージョン {appVersion}</p>
        </section>
      )}
    </div>
  );
}
