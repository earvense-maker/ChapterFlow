import { useEffect, useState } from 'react';
import { api } from '../clientApi';

interface Props {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

const defaultPresetSelection: Record<string, string> = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  conversation: 'standard',
  relationshipPacing: 'standard',
};

export default function ProjectForm({ onCreated, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getPresets().then((data) => {
      const typed = data as { categories: Record<string, PresetCategory> };
      setCategories(typed.categories);
      const defaults: Record<string, string> = {};
      for (const [key, cat] of Object.entries(typed.categories)) {
        const defaultId = defaultPresetSelection[key];
        if (defaultId && cat.items[defaultId]) defaults[key] = defaultId;
      }
      setSelection(defaults);
    });
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
      };
      const project = await api.createProject({ title, activePresetIds });
      onCreated(project.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '作成に失敗しました');
      setLoading(false);
    }
  }

  if (!categories) return <div className="loading">プリセット読み込み中…</div>;

  return (
    <div className="project-form">
      <h1>新規作品</h1>
      {error && <div className="error-toast">{error}</div>}
      <form onSubmit={handleSubmit}>
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
