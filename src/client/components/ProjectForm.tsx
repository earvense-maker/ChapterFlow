import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { DEFAULT_ACTIVE_PRESET_IDS, DEFAULT_GEMINI_MODEL } from '@shared/defaults';
import PresetSelector, { type PresetCategory } from './PresetSelector';
import type { ActivePresets, Character, ModelProviderInfo, WorldContent } from '@shared/types';

interface Props {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

const roleOptions: { value: Character['role']; label: string }[] = [
  { value: 'protagonist', label: '主人公' },
  { value: 'deuteragonist', label: '相手役' },
  { value: 'supporting', label: '脇役' },
  { value: 'other', label: 'その他' },
];

export default function ProjectForm({ onCreated, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [selection, setSelection] = useState<ActivePresets>({ ...DEFAULT_ACTIVE_PRESET_IDS });
  const [outputLength, setOutputLength] = useState(6000);
  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [provider, setProvider] = useState('gemini');
  const [modelName, setModelName] = useState(DEFAULT_GEMINI_MODEL);
  const [providers, setProviders] = useState<ModelProviderInfo[]>([]);
  const [customSystemPrompt, setCustomSystemPrompt] = useState('');
  const [world, setWorld] = useState<WorldContent>({ foundation: '', initialSituation: '' });
  const [characters, setCharacters] = useState<Character[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [presetData, providerList] = await Promise.all([
          api.getPresets(),
          api.getModelProviders(),
        ]);
        const typed = presetData as { categories: Record<string, PresetCategory> };
        setCategories(typed.categories);
        setProviders(providerList);

        setSelection({ ...DEFAULT_ACTIVE_PRESET_IDS });

        const defaultProvider = providerList.find((p) => p.name === 'gemini') ?? providerList[0];
        if (defaultProvider) {
          setProvider(defaultProvider.name);
          setModelName(defaultProvider.defaultModel);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '初期設定の読み込みに失敗しました');
      }
    }

    load();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      setLoading(true);
      setError(null);
      const activePresetIds = { ...DEFAULT_ACTIVE_PRESET_IDS, ...selection };
      if (apiKey.trim()) {
        await api.saveCredential(provider, apiKey.trim());
      }

      const project = await api.createProject({
        title,
        outputLength,
        streamingEnabled,
        activeModelProvider: provider,
        activeModelName: modelName.trim() || providers.find((p) => p.name === provider)?.defaultModel,
        activePresetIds,
        world,
        characters,
        customSystemPrompt,
      });
      onCreated(project.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作成に失敗しました');
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

  if (!categories) return <div className="loading">作風設定を読み込み中…</div>;

  return (
    <div className="project-form">
      <header className="setup-header">
        <div>
          <h1>設定を直接入力</h1>
          <p>作品の設定を入力して、そのまま作成します。</p>
        </div>
        <div className="setup-header-actions">
          <button type="button" onClick={onCancel} disabled={loading}>戻る</button>
          <button
            type="submit"
            form="direct-project-form"
            className="primary"
            disabled={loading}
          >
            {loading ? '作成中…' : '作品を作成'}
          </button>
        </div>
      </header>
      <main className="project-form-content">
        {error && <div className="error-toast">{error}</div>}
        <form id="direct-project-form" onSubmit={handleSubmit}>
        <section className="settings-section">
          <h2>基本設定</h2>
          <label>
            タイトル
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="無題の作品"
              autoFocus
            />
          </label>
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
              placeholder={currentProvider(providers, provider)?.defaultModel ?? DEFAULT_GEMINI_MODEL}
            />
          </label>
          <div className="project-api-key-field">
            <label>
              APIキー
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={currentProvider(providers, provider)?.apiKeyPlaceholder ?? 'sk-...'}
              />
            </label>
            <p className="settings-help">
              APIキーはPC内に平文で保存されます。生成時は、この作品の設定・本文・入力内容の必要な部分を
              選択したモデルプロバイダーへ送信します。利用量に応じて料金が発生する場合があります。
            </p>
            <p className="project-api-key-help">
              {currentProvider(providers, provider)?.apiKeyHelp ?? 'APIキーを保存します。作品データとは別に保存されます。'}
            </p>
          </div>
        </section>

        <details className="settings-section settings-section-collapsible">
          <summary>
            <span>作風設定</span>
            <span className="settings-section-summary-meta">選択内容を確認・変更</span>
          </summary>
          <div className="settings-section-collapsible-body">
            <PresetSelector
              categories={categories}
              value={selection}
              onChange={setSelection}
              disabled={loading}
              namePrefix="create-preset"
            />
          </div>
        </details>

        <section className="settings-section">
          <h2>作品固有の追加指示</h2>
          <p className="settings-help">
            選択した作風設定は常に適用されます。ここには、その後ろに追加する作品固有の指示だけを入力してください。
          </p>
          <textarea
            className="system-prompt-editor"
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
            placeholder="作風設定に加えて守ってほしい、作品固有の指示を入力"
          />
        </section>

        <section className="settings-section">
          <h2>世界の土台</h2>
          <textarea
            value={world.foundation}
            onChange={(e) => setWorld((current) => ({ ...current, foundation: e.target.value }))}
            placeholder="魔法法則・地理・文化・宇宙観など、物語進行で変わらない土台"
          />
          <h2>開始時点の状況</h2>
          <textarea
            value={world.initialSituation}
            onChange={(e) =>
              setWorld((current) => ({ ...current, initialSituation: e.target.value }))
            }
            placeholder="勢力関係・人物の所属や所在・季節・直近の出来事など、進行で変わりうる状況"
          />
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
                <button type="button" className="danger" onClick={() => removeCharacter(i)}>
                  削除
                </button>
              </div>
            </div>
          ))}
          <button type="button" onClick={addCharacter}>人物を追加</button>
        </section>

        <div className="form-actions">
          <button type="button" onClick={onCancel} disabled={loading}>キャンセル</button>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? '作成中…' : '作品を作成'}
          </button>
        </div>
      </form>
      </main>
    </div>
  );
}

function currentProvider(
  providers: ModelProviderInfo[],
  provider: string
): ModelProviderInfo | undefined {
  return providers.find((entry) => entry.name === provider);
}
