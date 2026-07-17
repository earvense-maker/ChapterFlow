import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { DEFAULT_ACTIVE_PRESET_IDS } from '@shared/defaults';
import type { Character, ModelProviderInfo, WorldContent } from '@shared/types';

interface Props {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

const defaultPresetSelection: Record<string, string> = { ...DEFAULT_ACTIVE_PRESET_IDS };

const roleOptions: { value: Character['role']; label: string }[] = [
  { value: 'protagonist', label: '主人公' },
  { value: 'deuteragonist', label: '相手役' },
  { value: 'supporting', label: '脇役' },
  { value: 'other', label: 'その他' },
];

export default function ProjectForm({ onCreated, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [outputLength, setOutputLength] = useState(6000);
  const [streamingEnabled, setStreamingEnabled] = useState(false);
  const [provider, setProvider] = useState('gemini');
  const [modelName, setModelName] = useState('gemini-3.5-flash');
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

        const defaults: Record<string, string> = {};
        for (const [key, cat] of Object.entries(typed.categories)) {
          const defaultId = defaultPresetSelection[key];
          if (defaultId && cat.items[defaultId]) defaults[key] = defaultId;
        }
        setSelection(defaults);

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
      const activePresetIds = {
        genre: selection.genre || 'modern-drama',
        style: selection.style || 'natural-dialogue',
        pov: selection.pov || 'third-person-close',
        pacing: selection.pacing || 'standard',
        density: selection.density || 'balanced',
        conversation: selection.conversation,
        relationshipPacing: selection.relationshipPacing,
        distance: selection.distance,
        constraint: selection.constraint,
        intimacy: selection.intimacy,
      };
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

  if (!categories) return <div className="loading">プリセット読み込み中…</div>;

  return (
    <div className="project-form">
      <h1>新規作品</h1>
      {error && <div className="error-toast">{error}</div>}
      <form onSubmit={handleSubmit}>
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
              placeholder={currentProvider(providers, provider)?.defaultModel ?? 'gemini-3.5-flash'}
            />
          </label>
        </section>

        <section className="settings-section">
          <h2>プリセット</h2>
          {Object.entries(categories).map(([key, category]) => (
            <fieldset key={key}>
              <legend>{category.label}</legend>
              <div className="preset-options">
                {Object.entries(category.items).map(([itemKey, item]) => (
                  <label key={itemKey} className="preset-option">
                    <input
                      type="radio"
                      name={key}
                      value={item.id}
                      checked={selection[key] === item.id}
                      onChange={() => setSelection((s) => ({ ...s, [key]: item.id }))}
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </section>

        <section className="settings-section">
          <h2>システムプロンプト</h2>
          <textarea
            className="system-prompt-editor"
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
            placeholder="空欄ならプリセットから自動生成"
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

        <section className="settings-section">
          <h2>APIキー</h2>
          <p className="settings-help">
            APIキーはPC内に平文で保存されます。生成時は、この作品の設定・本文・入力内容の必要な部分を
            選択したモデルプロバイダーへ送信します。利用量に応じて料金が発生する場合があります。
          </p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            {currentProvider(providers, provider)?.apiKeyHelp ?? 'APIキーを保存します。作品データとは別に保存されます。'}
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={currentProvider(providers, provider)?.apiKeyPlaceholder ?? 'sk-...'}
          />
        </section>

        <div className="form-actions">
          <button type="button" onClick={onCancel}>キャンセル</button>
          <button type="submit" className="primary" disabled={loading}>
            {loading ? '作成中…' : '作品を作成'}
          </button>
        </div>
      </form>
    </div>
  );
}

function currentProvider(
  providers: ModelProviderInfo[],
  provider: string
): ModelProviderInfo | undefined {
  return providers.find((entry) => entry.name === provider);
}
