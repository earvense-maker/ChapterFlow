import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import type { Character, PresetsFile, Project } from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
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

const roleLabelMap: Record<Character['role'], string> = Object.fromEntries(
  roleOptions.map((r) => [r.value, r.label])
) as Record<Character['role'], string>;

// NOTE: プリセットカテゴリ ID → タグに使う短い日本語名。作品像サマリーに
// 「三人称一元 / 現代口語」のように出すため、preset ラベルの方を参照する
// 一方でカテゴリ側は既知キーだけ扱う。
const styleTagCategoryOrder = ['pov', 'style', 'pacing', 'density', 'distance'] as const;

export default function WorkSettingsTab({ projectId, project, onError, onFlashMessage }: Props) {
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [presets, setPresets] = useState<Partial<PresetsFile>>({});
  const [worldText, setWorldText] = useState('');
  const [worldDraft, setWorldDraft] = useState('');
  const [worldExpanded, setWorldExpanded] = useState(false);
  const [worldEditing, setWorldEditing] = useState(false);

  const [characters, setCharacters] = useState<Character[]>([]);
  const [charactersDraft, setCharactersDraft] = useState<Character[]>([]);
  const [charactersEditing, setCharactersEditing] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemPromptDraft, setSystemPromptDraft] = useState('');
  const [generatedSystemPrompt, setGeneratedSystemPrompt] = useState('');
  const [isSystemPromptCustomized, setIsSystemPromptCustomized] = useState(false);
  const [systemPromptEditing, setSystemPromptEditing] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        onError(null);
        const [presetsData, worldData, charsData, presetMeta] = await Promise.all([
          api.getProjectPresets(projectId),
          api.getWorld(projectId),
          api.getCharacters(projectId),
          api.getPresets(),
        ]);
        if (cancelled) return;
        setPresets(presetsData);
        setWorldText(worldData.text);
        setWorldDraft(worldData.text);
        setCharacters(charsData);
        setCharactersDraft(charsData);
        setCategories((presetMeta as { categories: Record<string, PresetCategory> }).categories);

        const promptPreview = await api.previewSystemPrompt(
          projectId,
          presetsData,
          presetsData.customSystemPrompt
        );
        if (cancelled) return;
        setSystemPrompt(promptPreview.systemPrompt);
        setSystemPromptDraft(promptPreview.systemPrompt);
        setGeneratedSystemPrompt(promptPreview.generatedSystemPrompt);
        setIsSystemPromptCustomized(promptPreview.isCustomized);
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

  async function handleSaveWorld() {
    try {
      setLoading(true);
      onError(null);
      await api.updateWorld(projectId, worldDraft);
      setWorldText(worldDraft);
      setWorldEditing(false);
      onFlashMessage('世界設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelWorld() {
    setWorldDraft(worldText);
    setWorldEditing(false);
  }

  async function handleSaveCharacters() {
    try {
      setLoading(true);
      onError(null);
      await api.updateCharacters(projectId, charactersDraft);
      setCharacters(charactersDraft);
      setCharactersEditing(false);
      onFlashMessage('人物設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelCharacters() {
    setCharactersDraft(characters);
    setCharactersEditing(false);
  }

  function updateCharacterDraft(index: number, patch: Partial<Character>) {
    setCharactersDraft((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addCharacterDraft() {
    setCharactersDraft((prev) => [
      ...prev,
      {
        characterId: `char-${Date.now()}`,
        name: '',
        role: 'supporting',
        description: '',
      },
    ]);
  }

  function removeCharacterDraft(index: number) {
    setCharactersDraft((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveSystemPrompt() {
    try {
      setLoading(true);
      onError(null);
      const nextIsCustom = systemPromptDraft.trim() !== generatedSystemPrompt.trim();
      const savedPresets = await api.updateProjectPresets(projectId, {
        ...presets,
        customSystemPrompt: nextIsCustom ? systemPromptDraft : '',
      });
      setPresets(savedPresets);
      setSystemPrompt(systemPromptDraft);
      setIsSystemPromptCustomized(nextIsCustom);
      setSystemPromptEditing(false);
      onFlashMessage('システムプロンプトを保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelSystemPrompt() {
    setSystemPromptDraft(systemPrompt);
    setSystemPromptEditing(false);
  }

  async function handleResetSystemPrompt() {
    try {
      setPreviewLoading(true);
      onError(null);
      const preview = await api.previewSystemPrompt(projectId, presets, null);
      setGeneratedSystemPrompt(preview.generatedSystemPrompt);
      setSystemPromptDraft(preview.generatedSystemPrompt);
      setIsSystemPromptCustomized(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'プロンプトの更新に失敗しました');
    } finally {
      setPreviewLoading(false);
    }
  }

  const worldExcerpt = extractExcerpt(worldText, 120);
  const styleTags = deriveStyleTags(project.activePresetIds, categories);

  if (!categories) return <div className="loading">読み込み中…</div>;

  return (
    <div>
      {/* 文体・視点 */}
      <section className="summary-card">
        <header className="summary-card-header">
          <h2>文体・視点</h2>
          <div className="summary-card-badges">
            {isSystemPromptCustomized ? (
              <span className="settings-badge custom">カスタム</span>
            ) : (
              <span className="settings-badge preset">プリセット由来</span>
            )}
          </div>
        </header>
        {!systemPromptEditing && (
          <>
            {styleTags.length > 0 && !isSystemPromptCustomized && (
              <div className="style-tags">
                {styleTags.map((tag) => (
                  <span key={tag} className="style-tag">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            <details className="summary-details">
              <summary>システムプロンプト全文（{systemPrompt.length} 字）</summary>
              <pre className="summary-prewrap">{systemPrompt}</pre>
            </details>
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setSystemPromptDraft(systemPrompt);
                  setSystemPromptEditing(true);
                }}
              >
                編集
              </button>
            </div>
          </>
        )}
        {systemPromptEditing && (
          <>
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
              value={systemPromptDraft}
              onChange={(e) => setSystemPromptDraft(e.target.value)}
            />
            <div className="summary-card-actions">
              <button onClick={handleCancelSystemPrompt} disabled={loading}>
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveSystemPrompt} disabled={loading}>
                保存
              </button>
            </div>
          </>
        )}
      </section>

      {/* 世界 */}
      <section className="summary-card">
        <header className="summary-card-header">
          <h2>世界</h2>
          <div className="summary-card-badges">
            {!worldText.trim() && <span className="settings-badge warn">未設定 ⚠</span>}
            {worldText.trim() && (
              <span className="settings-meta">{worldText.length} 字</span>
            )}
          </div>
        </header>
        {!worldEditing && (
          <>
            {worldText.trim() ? (
              worldExpanded ? (
                <pre className="summary-prewrap">{worldText}</pre>
              ) : (
                <>
                  <p className="summary-excerpt">{worldExcerpt}</p>
                  {worldText.length > worldExcerpt.length && (
                    <button
                      className="summary-link-button"
                      onClick={() => setWorldExpanded(true)}
                    >
                      全文を見る ▼
                    </button>
                  )}
                </>
              )
            ) : (
              <p className="summary-empty">世界設定が未入力です。舞台や時代、独自ルールを書くと生成が安定します。</p>
            )}
            {worldExpanded && (
              <button
                className="summary-link-button"
                onClick={() => setWorldExpanded(false)}
              >
                折りたたむ ▲
              </button>
            )}
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setWorldDraft(worldText);
                  setWorldEditing(true);
                }}
              >
                編集
              </button>
            </div>
          </>
        )}
        {worldEditing && (
          <>
            <textarea
              value={worldDraft}
              onChange={(e) => setWorldDraft(e.target.value)}
              placeholder="舞台、時代、特殊なルールなどを自由に記述"
              rows={12}
            />
            <div className="summary-card-actions">
              <button onClick={handleCancelWorld} disabled={loading}>
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveWorld} disabled={loading}>
                保存
              </button>
            </div>
          </>
        )}
      </section>

      {/* 人物 */}
      <section className="summary-card">
        <header className="summary-card-header">
          <h2>人物 ({(charactersEditing ? charactersDraft : characters).length}人)</h2>
          <div className="summary-card-badges">
            {characters.length === 0 && <span className="settings-badge warn">未設定 ⚠</span>}
          </div>
        </header>
        {!charactersEditing && (
          <>
            {characters.length === 0 ? (
              <p className="summary-empty">
                人物設定が未入力です。主要人物を登録すると視点や口調が安定します。
              </p>
            ) : (
              <ul className="character-summary-list">
                {characters.map((c) => {
                  const missingDescription = !c.description.trim();
                  const missingSpeech = !(c.speechStyle ?? '').trim();
                  return (
                    <li key={c.characterId} className="character-summary-item">
                      <div className="character-summary-title">
                        <strong>{c.name || '（名前未設定）'}</strong>
                        <span className="character-role-badge">{roleLabelMap[c.role]}</span>
                        {(missingDescription || !c.name.trim()) && (
                          <span className="settings-badge warn">要記入 ⚠</span>
                        )}
                      </div>
                      <dl className="character-summary-fields">
                        <div>
                          <dt>概要</dt>
                          <dd>
                            {c.description.trim() ? (
                              <span className="summary-prewrap-inline">{c.description}</span>
                            ) : (
                              <span className="summary-field-missing">未記入</span>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>口調</dt>
                          <dd>
                            {missingSpeech ? (
                              <span className="summary-field-missing">未記入</span>
                            ) : (
                              <span className="summary-prewrap-inline">{c.speechStyle}</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setCharactersDraft(characters);
                  setCharactersEditing(true);
                }}
              >
                編集
              </button>
            </div>
          </>
        )}
        {charactersEditing && (
          <>
            {charactersDraft.map((c, i) => (
              <div key={c.characterId} className="character-form">
                <div className="character-form-fields">
                  <input
                    type="text"
                    value={c.name}
                    onChange={(e) => updateCharacterDraft(i, { name: e.target.value })}
                    placeholder="名前"
                  />
                  <select
                    value={c.role}
                    onChange={(e) =>
                      updateCharacterDraft(i, { role: e.target.value as Character['role'] })
                    }
                  >
                    {roleOptions.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={c.description}
                    onChange={(e) => updateCharacterDraft(i, { description: e.target.value })}
                    placeholder="概要（年齢・肩書き・性格など、自由記述）"
                  />
                  <textarea
                    value={c.speechStyle || ''}
                    onChange={(e) => updateCharacterDraft(i, { speechStyle: e.target.value })}
                    placeholder="口調（例：丁寧語、時々方言、独り言が多い）"
                  />
                  <button className="danger" onClick={() => removeCharacterDraft(i)}>
                    削除
                  </button>
                </div>
              </div>
            ))}
            <button onClick={addCharacterDraft}>人物を追加</button>
            <div className="summary-card-actions">
              <button onClick={handleCancelCharacters} disabled={loading}>
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveCharacters} disabled={loading}>
                保存
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// NOTE: world 冒頭を要約代わりに使う。段落境界と maxChars で切り詰める。
function extractExcerpt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('\n'));
  if (lastBreak > maxChars * 0.5) return cut.slice(0, lastBreak + 1) + '…';
  return cut + '…';
}

// NOTE: activePresetIds からラベル文字列を引き、「三人称一元 / 現代口語」の
// ようなタグ列を作る。カスタム化されている場合は呼び出し元でスキップする。
function deriveStyleTags(
  activePresetIds: Project['activePresetIds'],
  categories: Record<string, PresetCategory> | null
): string[] {
  if (!categories) return [];
  const tags: string[] = [];
  for (const categoryKey of styleTagCategoryOrder) {
    const category = categories[categoryKey];
    if (!category) continue;
    const presetId = activePresetIds[categoryKey as keyof Project['activePresetIds']];
    if (!presetId) continue;
    const item = Object.values(category.items).find((it) => it.id === presetId);
    if (item) tags.push(item.label);
  }
  return tags;
}
