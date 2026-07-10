import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type {
  ModelProviderInfo,
  NgExpression,
  NgExpressionSource,
  Project,
} from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  onProjectUpdated: (project: Project) => void;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  onOpenAppSettings: (provider?: string) => void;
}

export default function TechSettingsTab({
  projectId,
  project,
  onProjectUpdated,
  onError,
  onFlashMessage,
  onOpenAppSettings,
}: Props) {
  const [outputLength, setOutputLength] = useState(project.outputLength);
  const [streamingEnabled, setStreamingEnabled] = useState(project.streamingEnabled ?? false);
  const [modelName, setModelName] = useState(project.activeModelName);
  const [provider, setProvider] = useState(project.activeModelProvider);
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [frequencyPenalty, setFrequencyPenalty] = useState(
    project.samplingConfig?.frequencyPenalty ?? 0.1
  );
  const [presencePenalty, setPresencePenalty] = useState(
    project.samplingConfig?.presencePenalty ?? 0
  );
  const [temperature, setTemperature] = useState(project.samplingConfig?.temperature ?? 0.7);
  const [ngExpressions, setNgExpressions] = useState<NgExpression[]>([]);
  const [newNgText, setNewNgText] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        onError(null);
        const [providerList, expressionsData] = await Promise.all([
          api.getModelProviders(),
          api.getExpressions(projectId),
        ]);
        if (cancelled) return;
        setProviders(providerList);
        setNgExpressions(expressionsData.ngExpressions);
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : '読み込みに失敗しました');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleSaveBasic() {
    try {
      setLoading(true);
      onError(null);
      const updatedProject = await api.updateProject(projectId, {
        outputLength,
        streamingEnabled,
        activeModelProvider: provider,
        activeModelName:
          modelName.trim() ||
          providers.find((p) => p.name === provider)?.defaultModel ||
          'gemini-3.5-flash',
      });
      onProjectUpdated(updatedProject);
      setModelName(updatedProject.activeModelName);
      setProvider(updatedProject.activeModelProvider);
      onFlashMessage('基本設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveSamplingConfig() {
    try {
      setLoading(true);
      onError(null);
      const updatedProject = await api.updateProject(projectId, {
        samplingConfig: { frequencyPenalty, presencePenalty, temperature },
      });
      onProjectUpdated(updatedProject);
      setFrequencyPenalty(updatedProject.samplingConfig?.frequencyPenalty ?? 0.1);
      setPresencePenalty(updatedProject.samplingConfig?.presencePenalty ?? 0);
      setTemperature(updatedProject.samplingConfig?.temperature ?? 0.7);
      onFlashMessage('サンプリング設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleAddNgExpression(source: NgExpressionSource = 'manual') {
    const text = newNgText.trim();
    if (!text) return;
    try {
      setLoading(true);
      onError(null);
      await api.createExpression(projectId, { text, source });
      const expressionsData = await api.getExpressions(projectId);
      setNgExpressions(expressionsData.ngExpressions);
      setNewNgText('');
      onFlashMessage('NG表現を登録しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleArchiveNgExpression(expressionId: string) {
    try {
      setLoading(true);
      onError(null);
      await api.archiveExpression(projectId, expressionId);
      const expressionsData = await api.getExpressions(projectId);
      setNgExpressions(expressionsData.ngExpressions);
      onFlashMessage('NG表現を削除しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  const activeProvider = providers.find((p) => p.name === provider);

  return (
    <div>
      <section className="settings-section">
        <h2>基本設定</h2>
        <label>
          出力文量（大まかな目安文字数）
          <input
            type="number"
            value={outputLength}
            onChange={(e) => setOutputLength(Number(e.target.value))}
            min={500}
            max={10000}
            step={500}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={streamingEnabled}
            onChange={(e) => setStreamingEnabled(e.target.checked)}
          />
          <span>ストリーミング生成を使う</span>
        </label>
        <label>
          プロバイダー
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value;
              setProvider(next);
              const defaultModel = providers.find((p) => p.name === next)?.defaultModel;
              if (defaultModel) setModelName(defaultModel);
            }}
          >
            {providers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.label}{p.hasApiKey === false ? '（キー未設定）' : ''}
              </option>
            ))}
          </select>
        </label>
        {activeProvider?.hasApiKey === false && (
          <div className="setup-api-key-warning">
            {activeProvider.label} のAPIキーが未設定です。保存するまでこのモデルでは生成できません。
          </div>
        )}
        <label>
          モデル名
          <input
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder={activeProvider?.defaultModel ?? 'gemini-3.5-flash'}
          />
        </label>
        <button className="primary" onClick={handleSaveBasic} disabled={loading}>
          基本設定を保存
        </button>
      </section>

      <section className="settings-section">
        <h2>全作品共通の設定</h2>
        <p className="settings-help">
          APIキーと作品データの保存先はアプリ全体で共有されます。変更はアプリ設定から行います。
        </p>
        <button type="button" onClick={() => onOpenAppSettings(provider)} disabled={loading}>
          アプリ設定を開く
        </button>
      </section>

      <section className="settings-section">
        <h2>サンプリング</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Temperature を上げると発想が広がり、下げると堅実になります。
          目安: 堅く 0.5 / 標準 0.7 / 冒険 1.0〜1.2。
        </p>
        <label>
          Temperature（発想の広がり）
          <input
            type="range"
            min={0}
            max={1.3}
            step={0.05}
            value={temperature}
            onChange={(e) => setTemperature(Number(e.target.value))}
          />
          <span>{temperature.toFixed(2)}</span>
        </label>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '1rem' }}>
          Penalty は語彙の反復を抑えます。上げすぎると文が不自然に。目安 0.1〜0.5。
        </p>
        {provider === 'xai' && (
          <p className="settings-help">
            xAIのGrok推論モデルはPenaltyを受け付けないため、この2項目は送信されません。
          </p>
        )}
        <label>
          Frequency penalty（同じ語の繰り返し抑制）
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={frequencyPenalty}
            onChange={(e) => setFrequencyPenalty(Number(e.target.value))}
            disabled={loading || provider === 'xai'}
          />
          <span>{frequencyPenalty.toFixed(2)}</span>
        </label>
        <label>
          Presence penalty（既出語の再出現抑制）
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={presencePenalty}
            onChange={(e) => setPresencePenalty(Number(e.target.value))}
            disabled={loading || provider === 'xai'}
          />
          <span>{presencePenalty.toFixed(2)}</span>
        </label>
        <button className="primary" onClick={handleSaveSamplingConfig} disabled={loading}>
          サンプリング設定を保存
        </button>
      </section>

      <section className="settings-section">
        <h2>NG表現</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          生成時に避けさせたい言い回しを登録します（1〜30字）。
        </p>
        <div className="ng-expression-form">
          <input
            type="text"
            value={newNgText}
            onChange={(e) => setNewNgText(e.target.value)}
            placeholder="例：息を呑んだ"
            maxLength={30}
            disabled={loading}
          />
          <button
            onClick={() => handleAddNgExpression('manual')}
            disabled={loading || !newNgText.trim()}
          >
            追加
          </button>
        </div>
        {ngExpressions.length >= 45 && (
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>
            NG表現が上限（50件）に近づいています。
          </p>
        )}
        <ul className="ng-expression-list">
          {ngExpressions.map((e) => (
            <li key={e.id} className="ng-expression-item">
              <span>「{e.text}」</span>
              <button
                className="danger"
                onClick={() => handleArchiveNgExpression(e.id)}
                disabled={loading}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
        {ngExpressions.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            登録されたNG表現はありません。
          </p>
        )}
      </section>

    </div>
  );
}
