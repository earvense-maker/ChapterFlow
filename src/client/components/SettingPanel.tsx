import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type {
  Character,
  ModelProviderInfo,
  NgExpression,
  NgExpressionSource,
  PresetsFile,
  Project,
} from '@shared/types';

interface Props {
  projectId: string;
  onBack: () => void;
}

type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

const roleOptions: { value: Character['role']; label: string }[] = [
  { value: 'protagonist', label: '主人公' },
  { value: 'deuteragonist', label: '相手役' },
  { value: 'supporting', label: '脇役' },
  { value: 'other', label: 'その他' },
];

export default function SettingPanel({ projectId, onBack }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [presets, setPresets] = useState<Partial<PresetsFile>>({});
  const [worldText, setWorldText] = useState('');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [outputLength, setOutputLength] = useState(3000);
  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [modelName, setModelName] = useState('');
  const [provider, setProvider] = useState('');
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [generatedSystemPrompt, setGeneratedSystemPrompt] = useState('');
  const [isSystemPromptCustomized, setIsSystemPromptCustomized] = useState(false);
  const [frequencyPenalty, setFrequencyPenalty] = useState(0);
  const [presencePenalty, setPresencePenalty] = useState(0);
  const [ngExpressions, setNgExpressions] = useState<NgExpression[]>([]);
  const [newNgText, setNewNgText] = useState('');
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const [projectData, presetsData, worldData, charsData, expressionsData] = await Promise.all([
        api.getProject(projectId),
        api.getProjectPresets(projectId),
        api.getWorld(projectId),
        api.getCharacters(projectId),
        api.getExpressions(projectId),
      ]);
      setProject(projectData);
      setPresets(presetsData);
      setWorldText(worldData.text);
      setCharacters(charsData);
      setOutputLength(projectData.outputLength);
      setStreamingEnabled(projectData.streamingEnabled ?? false);
      setModelName(projectData.activeModelName);
      setProvider(projectData.activeModelProvider);
      setFrequencyPenalty(projectData.samplingConfig?.frequencyPenalty ?? 0);
      setPresencePenalty(projectData.samplingConfig?.presencePenalty ?? 0);
      setNgExpressions(expressionsData.ngExpressions);

      const providerList = await api.getModelProviders();
      setProviders(providerList);

      const promptPreview = await api.previewSystemPrompt(
        projectId,
        presetsData,
        presetsData.customSystemPrompt
      );
      setSystemPrompt(promptPreview.systemPrompt);
      setGeneratedSystemPrompt(promptPreview.generatedSystemPrompt);
      setIsSystemPromptCustomized(promptPreview.isCustomized);

      const presetMeta = await api.getPresets();
      setCategories((presetMeta as { categories: Record<string, PresetCategory> }).categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    load();
  }, [projectId]);

  useEffect(() => {
    if (!project || isSystemPromptCustomized) return;

    let cancelled = false;
    setPreviewLoading(true);
    api.previewSystemPrompt(projectId, presets, null)
      .then((preview) => {
        if (cancelled) return;
        setGeneratedSystemPrompt(preview.generatedSystemPrompt);
        setSystemPrompt(preview.generatedSystemPrompt);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'プロンプトの更新に失敗しました');
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, project, presets, isSystemPromptCustomized]);

  async function handleSavePresets() {
    try {
      setLoading(true);
      setError(null);
      const savedPresets = await api.updateProjectPresets(projectId, systemPromptPresetPatch());
      const updatedProject = await api.updateProject(projectId, {
        outputLength,
        streamingEnabled,
        activeModelProvider: provider,
        activeModelName: modelName.trim() || providers.find((p) => p.name === provider)?.defaultModel || 'gemini-3.5-flash',
      });
      setPresets(savedPresets);
      setProject(updatedProject);
      setModelName(updatedProject.activeModelName);
      setProvider(updatedProject.activeModelProvider);
      setMessage('設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveBasic() {
    try {
      setLoading(true);
      setError(null);
      const updatedProject = await api.updateProject(projectId, {
        outputLength,
        streamingEnabled,
        activeModelProvider: provider,
        activeModelName: modelName.trim() || providers.find((p) => p.name === provider)?.defaultModel || 'gemini-3.5-flash',
      });
      setProject(updatedProject);
      setModelName(updatedProject.activeModelName);
      setProvider(updatedProject.activeModelProvider);
      setMessage('基本設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveSamplingConfig() {
    try {
      setLoading(true);
      setError(null);
      const updatedProject = await api.updateProject(projectId, {
        samplingConfig: buildSamplingConfig(),
      });
      setProject(updatedProject);
      setFrequencyPenalty(updatedProject.samplingConfig?.frequencyPenalty ?? 0);
      setPresencePenalty(updatedProject.samplingConfig?.presencePenalty ?? 0);
      setMessage('反復抑制設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveSystemPrompt() {
    try {
      setLoading(true);
      setError(null);
      const savedPresets = await api.updateProjectPresets(projectId, systemPromptPresetPatch());
      setPresets(savedPresets);
      setMessage('システムプロンプトを保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleResetSystemPrompt() {
    try {
      setPreviewLoading(true);
      setError(null);
      const preview = await api.previewSystemPrompt(projectId, presets, null);
      setGeneratedSystemPrompt(preview.generatedSystemPrompt);
      setSystemPrompt(preview.generatedSystemPrompt);
      setIsSystemPromptCustomized(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'プロンプトの更新に失敗しました');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSaveWorld() {
    try {
      setLoading(true);
      setError(null);
      await api.updateWorld(projectId, worldText);
      setMessage('世界設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveCharacters() {
    try {
      setLoading(true);
      setError(null);
      await api.updateCharacters(projectId, characters);
      setMessage('人物設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveApiKey() {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/models/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      if (!res.ok) throw new Error('APIキーの保存に失敗しました');
      setMessage('APIキーを保存しました');
      setTimeout(() => setMessage(null), 2000);
      setApiKey('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function updateCharacter(index: number, patch: Partial<Character>) {
    setCharacters((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addCharacter() {
    setCharacters((prev) => [
      ...prev,
      {
        characterId: `char-${Date.now()}`,
        name: '',
        role: 'supporting',
        description: '',
      },
    ]);
  }

  function removeCharacter(index: number) {
    setCharacters((prev) => prev.filter((_, i) => i !== index));
  }

  function handleSystemPromptChange(value: string) {
    setSystemPrompt(value);
    setIsSystemPromptCustomized(value.trim() !== generatedSystemPrompt.trim());
  }

  function buildSamplingConfig() {
    return { frequencyPenalty, presencePenalty };
  }

  async function handleAddNgExpression(source: NgExpressionSource = 'manual') {
    const text = newNgText.trim();
    if (!text) return;
    try {
      setLoading(true);
      setError(null);
      await api.createExpression(projectId, { text, source });
      const expressionsData = await api.getExpressions(projectId);
      setNgExpressions(expressionsData.ngExpressions);
      setNewNgText('');
      setMessage('NG表現を登録しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleArchiveNgExpression(expressionId: string) {
    try {
      setLoading(true);
      setError(null);
      await api.archiveExpression(projectId, expressionId);
      const expressionsData = await api.getExpressions(projectId);
      setNgExpressions(expressionsData.ngExpressions);
      setMessage('NG表現を削除しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function systemPromptPresetPatch(): Partial<PresetsFile> {
    return {
      ...presets,
      customSystemPrompt: isSystemPromptCustomized ? systemPrompt : '',
    };
  }

  if (!categories || !project) return <div className="loading">読み込み中…</div>;

  return (
    <div className="settings-panel">
      <header className="reader-header">
        <button onClick={onBack}>← 戻る</button>
        <h1>作品設定: {project.title}</h1>
      </header>

      {error && <div className="error-toast">{error}</div>}
      {message && <div className="status-bar">{message}</div>}

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
                {p.label}
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
            placeholder={currentProvider(providers, provider)?.defaultModel ?? 'gemini-3.5-flash'}
          />
        </label>
        <button className="primary" onClick={handleSaveBasic} disabled={loading}>
          基本設定を保存
        </button>
      </section>

      <section className="settings-section">
        <h2>プリセット</h2>
        {Object.entries(categories).map(([key, category]) => (
          <fieldset key={key}>
            <legend>{category.label}</legend>
            <div className="preset-options">
              {Object.entries(category.items).map(([itemKey, item]) => {
                const selected = presets[presetKey(key)] === item.id;
                return (
                  <label key={itemKey} className="preset-option">
                    <input
                      type="radio"
                      name={key}
                      value={item.id}
                      checked={selected}
                      onChange={() =>
                        setPresets((p) => ({ ...p, [presetKey(key)]: item.id }))
                      }
                    />
                    <span>{item.label}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <button className="primary" onClick={handleSavePresets} disabled={loading}>
          プリセットを保存
        </button>
      </section>

      <section className="settings-section">
        <h2>システムプロンプト</h2>
        <div className="prompt-toolbar">
          <span className="prompt-status">
            {previewLoading
              ? '更新中…'
              : isSystemPromptCustomized
                ? '手入力を使用中'
                : 'プリセットから生成'}
          </span>
          <button onClick={handleResetSystemPrompt} disabled={loading || previewLoading}>
            現在のプリセットから再生成
          </button>
        </div>
        <textarea
          className="system-prompt-editor"
          value={systemPrompt}
          onChange={(e) => handleSystemPromptChange(e.target.value)}
        />
        <button className="primary" onClick={handleSaveSystemPrompt} disabled={loading}>
          システムプロンプトを保存
        </button>
      </section>

      <section className="settings-section">
        <h2>世界設定</h2>
        <textarea
          value={worldText}
          onChange={(e) => setWorldText(e.target.value)}
          placeholder="舞台、時代、特殊なルールなどを自由に記述"
        />
        <button className="primary" onClick={handleSaveWorld} disabled={loading}>
          世界設定を保存
        </button>
      </section>

      <section className="settings-section">
        <h2>人物設定</h2>
        {characters.map((c, i) => (
          <div key={c.characterId} className="character-form">
            <div className="character-form-fields">
              <input
                type="text"
                value={c.name}
                onChange={(e) => updateCharacter(i, { name: e.target.value })}
                placeholder="名前"
              />
              <select
                value={c.role}
                onChange={(e) => updateCharacter(i, { role: e.target.value as Character['role'] })}
              >
                {roleOptions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <textarea
                value={c.description}
                onChange={(e) => updateCharacter(i, { description: e.target.value })}
                placeholder="概要"
              />
              <textarea
                value={c.speechStyle || ''}
                onChange={(e) => updateCharacter(i, { speechStyle: e.target.value })}
                placeholder="口調"
              />
              <button className="danger" onClick={() => removeCharacter(i)}>削除</button>
            </div>
          </div>
        ))}
        <button onClick={addCharacter}>人物を追加</button>
        <button className="primary" onClick={handleSaveCharacters} disabled={loading}>
          人物設定を保存
        </button>
      </section>

      <section className="settings-section">
        <h2>APIキー</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {currentProvider(providers, provider)?.apiKeyHelp ?? 'APIキーを保存します。作品データとは別に保存されます。'}
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={currentProvider(providers, provider)?.apiKeyPlaceholder ?? 'sk-...'}
        />
        <button className="primary" onClick={handleSaveApiKey} disabled={loading}>
          APIキーを保存
        </button>
      </section>

      <section className="settings-section">
        <h2>表現の反復抑制</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          値を上げると同じ語の反復が減ります。上げすぎると文が不自然になります。目安 0.2〜0.5
        </p>
        <label>
          Frequency penalty（同じ語の繰り返し抑制）
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={frequencyPenalty}
            onChange={(e) => setFrequencyPenalty(Number(e.target.value))}
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
          />
          <span>{presencePenalty.toFixed(2)}</span>
        </label>
        <button className="primary" onClick={handleSaveSamplingConfig} disabled={loading}>
          反復抑制設定を保存
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
          <button onClick={() => handleAddNgExpression('manual')} disabled={loading || !newNgText.trim()}>
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
              <button className="danger" onClick={() => handleArchiveNgExpression(e.id)} disabled={loading}>
                削除
              </button>
            </li>
          ))}
        </ul>
        {ngExpressions.length === 0 && (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>登録されたNG表現はありません。</p>
        )}
      </section>
    </div>
  );
}

function presetKey(categoryKey: string): keyof PresetsFile {
  const map: Record<string, keyof PresetsFile> = {
    genre: 'genrePreset',
    style: 'stylePreset',
    pov: 'povPreset',
    distance: 'distancePreset',
    pacing: 'pacingPreset',
    density: 'densityPreset',
    conversation: 'conversationPreset',
    relationshipPacing: 'relationshipPacingPreset',
    constraint: 'constraintPreset',
  };
  return map[categoryKey] ?? (categoryKey as keyof PresetsFile);
}

function currentProvider(
  providers: ModelProviderInfo[],
  provider: string
): ModelProviderInfo | undefined {
  return providers.find((entry) => entry.name === provider);
}
