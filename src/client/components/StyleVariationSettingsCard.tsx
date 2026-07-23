import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import {
  DEFAULT_STYLE_VARIATION_SETTINGS,
  STYLE_AXES,
  normalizeStyleVariationSettings,
} from '@shared/defaults';
import type {
  Project,
  StyleAxis,
  StyleVariationSettings,
} from '@shared/types';

interface Props {
  project: Project;
  onProjectUpdated: (project: Project) => void;
  onError: (message: string | null) => void;
  onFlashMessage: (message: string) => void;
}

const AXIS_LABELS: Record<StyleAxis, string> = {
  visual: '視覚',
  auditory: '聴覚',
  somatic: '身体',
  introspective: '内省',
  kinetic: '運動',
  dialogic: '対話',
  temporal: '時間',
};

function effectiveSettings(project: Project): StyleVariationSettings {
  return (
    normalizeStyleVariationSettings(project.styleVariation) ?? {
      ...DEFAULT_STYLE_VARIATION_SETTINGS,
      axisWeights: { ...DEFAULT_STYLE_VARIATION_SETTINGS.axisWeights },
      motifExclusions: [],
    }
  );
}

export default function StyleVariationSettingsCard({
  project,
  onProjectUpdated,
  onError,
  onFlashMessage,
}: Props) {
  const [settings, setSettings] = useState<StyleVariationSettings>(() =>
    effectiveSettings(project)
  );
  const [motifText, setMotifText] = useState(() =>
    effectiveSettings(project).motifExclusions.join('\n')
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = effectiveSettings(project);
    setSettings(next);
    setMotifText(next.motifExclusions.join('\n'));
  }, [project.projectId, project.styleVariation]);

  function update(patch: Partial<StyleVariationSettings>) {
    setSettings((current) => ({ ...current, ...patch }));
  }

  function updateAxis(axis: StyleAxis, value: number) {
    setSettings((current) => ({
      ...current,
      axisWeights: { ...current.axisWeights, [axis]: value },
    }));
  }

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const motifExclusions = [
        ...new Set(
          motifText
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ].slice(0, 30);
      const updated = await api.updateProject(project.projectId, {
        styleVariation: { ...settings, motifExclusions },
      });
      onProjectUpdated(updated);
      onFlashMessage('文体変調設定を保存しました');
    } catch (error) {
      onError(error instanceof Error ? error.message : '文体変調設定の保存に失敗しました');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="summary-card detail-settings-panel-card">
      <header className="summary-card-header">
        <h2>文体変調</h2>
        <div className="summary-card-badges">
          <span className={`settings-badge ${settings.enabled ? 'preset' : ''}`}>
            {settings.enabled ? '有効' : '無効'}
          </span>
        </div>
      </header>

      <label className="knowledge-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
          disabled={saving}
        />
        場面ごとに文体へ小さな傾きを加える
      </label>
      <p className="settings-help">
        文体見本・人称・視点・人物の口調を優先したまま、感覚入口やリズムを弱く変えます。
        {!project.styleSample?.trim() && ' 文体見本を登録すると本人性を保ちやすくなります。'}
      </p>

      <label>
        強さ
        <select
          value={settings.intensity}
          onChange={(event) =>
            update({ intensity: event.target.value === 'balanced' ? 'balanced' : 'subtle' })
          }
          disabled={saving || !settings.enabled}
        >
          <option value="subtle">控えめ</option>
          <option value="balanced">標準</option>
        </select>
      </label>

      <label className="knowledge-toggle">
        <input
          type="checkbox"
          checked={settings.surfaceDecayEnabled}
          onChange={(event) => update({ surfaceDecayEnabled: event.target.checked })}
          disabled={saving || !settings.enabled}
        />
        直近の表現を弱く減衰する
      </label>
      <label className="knowledge-toggle">
        <input
          type="checkbox"
          checked={settings.patternDecayEnabled}
          onChange={(event) => update({ patternDecayEnabled: event.target.checked })}
          disabled={saving || !settings.enabled}
        />
        直近の構成パターンを弱く減衰する
      </label>
      {settings.enabled && settings.patternDecayEnabled && (
        <p className="settings-help">
          採用した本文の型を分析するため、採用ごとに追加のモデル呼び出しが1回発生します。
          失敗しても本文の採用・次の生成は止まりません。
        </p>
      )}

      <details className="summary-details">
        <summary>高度な設定</summary>
        <div className="settings-stack">
          {STYLE_AXES.map((axis) => (
            <label key={axis}>
              {AXIS_LABELS[axis]}: {(settings.axisWeights[axis] ?? 0.5).toFixed(1)}
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={settings.axisWeights[axis] ?? 0.5}
                onChange={(event) => updateAxis(axis, Number(event.target.value))}
                disabled={saving || !settings.enabled}
              />
            </label>
          ))}
          <label>
            減衰しない意図的モチーフ・口癖（1行1件）
            <textarea
              rows={4}
              maxLength={3000}
              value={motifText}
              onChange={(event) => setMotifText(event.target.value)}
              placeholder={'月の比喩\n「大丈夫」が口癖'}
              disabled={saving || !settings.enabled}
            />
          </label>
        </div>
      </details>

      <div className="summary-card-actions">
        <button className="primary" type="button" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '文体変調設定を保存'}
        </button>
      </div>
    </section>
  );
}
