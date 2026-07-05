import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import RefineChatPanel from './RefineChatPanel';
import type {
  Character,
  PresetsFile,
  Project,
  RefineFindingKind,
  RefineFindingTarget,
  RefineScanResult,
} from '@shared/types';

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

  const [refineScan, setRefineScan] = useState<RefineScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

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

        // NOTE: 前回の scan 結果があれば表示。無ければ null のまま。
        // 起動時に scan は自動実行しない（トークン消費を明示ボタンに限定）。
        const cachedScan = await api.getRefineScan(projectId).catch(() => null);
        if (!cancelled && cachedScan) setRefineScan(cachedScan);
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

  // NOTE: パッチ反映後に world / characters を再取得して UI を最新化。
  // 編集中の draft は上書きしないよう、編集モード時は skip する。
  async function refreshWorldAndCharacters() {
    try {
      const [worldData, charsData] = await Promise.all([
        api.getWorld(projectId),
        api.getCharacters(projectId),
      ]);
      setWorldText(worldData.text);
      if (!worldEditing) setWorldDraft(worldData.text);
      setCharacters(charsData);
      if (!charactersEditing) setCharactersDraft(charsData);
    } catch (err) {
      onError(err instanceof Error ? err.message : '再読み込みに失敗しました');
    }
  }

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

  async function handleScanRefine() {
    try {
      setScanning(true);
      setScanError(null);
      const result = await api.scanRefine(projectId);
      setRefineScan(result);
      if (result.lastError) {
        setScanError(result.lastError);
      } else {
        onFlashMessage('作品設定を再走査しました');
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : '走査に失敗しました');
    } finally {
      setScanning(false);
    }
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
      {/* 作品の芯 */}
      {refineScan?.coreConcept && (
        <section className="summary-card core-concept-card">
          <header className="summary-card-header">
            <h2>作品の芯</h2>
            <span className="settings-meta">
              {formatRelativeTime(refineScan.generatedAt)} 更新
            </span>
          </header>
          <p className="core-concept-text">{refineScan.coreConcept}</p>
        </section>
      )}

      {/* 気づき */}
      <section className="summary-card refine-findings-card">
        <header className="summary-card-header">
          <h2>AI からの気づき</h2>
          <div className="summary-card-badges">
            {refineScan && (
              <span className="settings-meta">
                前回走査: {formatRelativeTime(refineScan.generatedAt)}
              </span>
            )}
            <button
              onClick={handleScanRefine}
              disabled={scanning}
              className="refine-scan-button"
            >
              {scanning ? '走査中…' : refineScan ? '再走査 🔄' : '気づきを走査 🔄'}
            </button>
          </div>
        </header>
        {scanError && <div className="refine-scan-error">{scanError}</div>}
        {!refineScan && !scanning && (
          <p className="summary-empty">
            まだ走査していません。「気づきを走査」を押すと、AI が
            世界設定・人物・システムプロンプト・ストーリー状態を横断して
            矛盾や未定義項目を指摘します。
          </p>
        )}
        {refineScan && refineScan.findings.length === 0 && !refineScan.lastError && (
          <p className="summary-empty">
            気になる点は見つかりませんでした（走査時点）。設定を編集したら
            再走査すると新しい気づきが出るかもしれません。
          </p>
        )}
        {refineScan && refineScan.findings.length > 0 && (
          <ul className="refine-findings-list">
            {refineScan.findings.map((f) => (
              <li key={f.id} className={`refine-finding kind-${f.kind}`}>
                <div className="refine-finding-header">
                  <span className={`refine-finding-badge kind-${f.kind}`}>
                    {kindLabel(f.kind)}
                  </span>
                  <span className="refine-finding-target">
                    {formatFindingTarget(f.target)}
                  </span>
                </div>
                <p className="refine-finding-message">{f.message}</p>
                {f.detail && (
                  <details className="refine-finding-detail">
                    <summary>詳しく</summary>
                    <p>{f.detail}</p>
                  </details>
                )}
                {f.suggestedFix && (
                  <p className="refine-finding-suggestion">
                    <strong>提案:</strong> {f.suggestedFix}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

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

      {/* AI と相談して編集 (Phase 3) */}
      <RefineChatPanel
        projectId={projectId}
        characters={characters}
        onSettingsChanged={refreshWorldAndCharacters}
      />
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

function kindLabel(kind: RefineFindingKind): string {
  switch (kind) {
    case 'contradiction':
      return '⚠ 矛盾';
    case 'undefined':
      return '✎ 未定義';
    case 'suggestion':
      return '＋ 提案';
  }
}

function formatFindingTarget(target: RefineFindingTarget): string {
  switch (target.kind) {
    case 'world':
      return '世界設定';
    case 'systemPrompt':
      return 'システムプロンプト';
    case 'storyState':
      return 'ストーリー状態';
    case 'character':
      return `人物: ${target.characterName}`;
    case 'other':
      return target.label;
  }
}

// NOTE: 「3日前」「5分前」等の相対時刻表示。
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'たった今';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}日前`;
  const month = Math.floor(day / 30);
  return `${month}ヶ月前`;
}

