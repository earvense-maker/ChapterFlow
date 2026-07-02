import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { Character, PresetsFile, Project } from '@shared/types';

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
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const [projectData, presetsData, worldData, charsData] = await Promise.all([
        api.getProject(projectId),
        api.getProjectPresets(projectId),
        api.getWorld(projectId),
        api.getCharacters(projectId),
      ]);
      setProject(projectData);
      setPresets(presetsData);
      setWorldText(worldData.text);
      setCharacters(charsData);
      setOutputLength(projectData.outputLength);

      const presetMeta = await api.getPresets();
      setCategories((presetMeta as { categories: Record<string, PresetCategory> }).categories);
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました');
    }
  }

  useEffect(() => {
    load();
  }, [projectId]);

  async function handleSavePresets() {
    try {
      setLoading(true);
      setError(null);
      await api.updateProjectPresets(projectId, presets);
      await api.updateProject(projectId, { outputLength });
      setMessage('設定を保存しました');
      setTimeout(() => setMessage(null), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
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
        body: JSON.stringify({ provider: 'openai', apiKey }),
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
          出力文量（目安文字数）
          <input
            type="number"
            value={outputLength}
            onChange={(e) => setOutputLength(Number(e.target.value))}
            min={500}
            max={10000}
            step={500}
          />
        </label>
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
          基本設定を保存
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
          OpenAI APIキーを入力してください。作品データとは別に保存されます。
        </p>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
        />
        <button className="primary" onClick={handleSaveApiKey} disabled={loading}>
          APIキーを保存
        </button>
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
