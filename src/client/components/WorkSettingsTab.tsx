import { useEffect, useState } from 'react';
import { api } from '../clientApi';
import { KNOWLEDGE_WARN_CHARS } from '@shared/types';
import RefineChatPanel from './RefineChatPanel';
import type {
  Character,
  KnowledgeListItem,
  PresetsFile,
  Project,
  RefineScanResult,
  StoryState,
  StoryStateDiffRecord,
} from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  onProjectUpdated: (project: Project) => void;
}

type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

type DetailSettingsTab = 'basic' | 'style' | 'world' | 'characters' | 'story' | 'knowledge';

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

export default function WorkSettingsTab({
  projectId,
  project,
  onError,
  onFlashMessage,
  onProjectUpdated,
}: Props) {
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [presets, setPresets] = useState<Partial<PresetsFile>>({});
  const [worldText, setWorldText] = useState('');
  const [worldDraft, setWorldDraft] = useState('');
  const [worldExpanded, setWorldExpanded] = useState(false);
  const [worldEditing, setWorldEditing] = useState(false);
  const [projectDetails, setProjectDetails] = useState({
    title: project.title,
    coreConcept: project.coreConcept ?? '',
    styleSample: project.styleSample ?? '',
  });
  const [projectDetailsDraft, setProjectDetailsDraft] = useState(projectDetails);
  const [projectDetailsEditing, setProjectDetailsEditing] = useState(false);
  const [detailSettingsTab, setDetailSettingsTab] = useState<DetailSettingsTab>('basic');

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
  const [storyState, setStoryState] = useState<StoryState | null>(null);
  const [storyStateDraft, setStoryStateDraft] = useState('');
  const [storyStateEditing, setStoryStateEditing] = useState(false);
  const [storyStateDiffs, setStoryStateDiffs] = useState<StoryStateDiffRecord[]>([]);
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeListItem[]>([]);
  const [knowledgeExpandedId, setKnowledgeExpandedId] = useState<string | null>(null);
  const [knowledgeEditing, setKnowledgeEditing] = useState(false);
  const [knowledgeTitleDraft, setKnowledgeTitleDraft] = useState('');
  const [knowledgeContentDraft, setKnowledgeContentDraft] = useState('');
  const [knowledgeUploading, setKnowledgeUploading] = useState(false);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        onError(null);
        const [
          presetsData,
          worldData,
          charsData,
          presetMeta,
          storyData,
          diffData,
          knowledgeData,
        ] = await Promise.all([
          api.getProjectPresets(projectId),
          api.getWorld(projectId),
          api.getCharacters(projectId),
          api.getPresets(),
          api.getStoryState(projectId),
          api.getStoryStateDiffs(projectId),
          api.getKnowledge(projectId),
        ]);
        if (cancelled) return;
        setPresets(presetsData);
        setWorldText(worldData.text);
        setWorldDraft(worldData.text);
        setCharacters(charsData);
        setCharactersDraft(charsData);
        setCategories((presetMeta as { categories: Record<string, PresetCategory> }).categories);
        setStoryState(storyData);
        setStoryStateDraft(JSON.stringify(storyData, null, 2));
        setStoryStateDiffs(diffData);
        setKnowledgeItems(knowledgeData);

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
        if (!cancelled && cachedScan) {
          setRefineScan(cachedScan);
          // NOTE: キャッシュ済み結果に lastError が入っていれば、それも UI に見せる。
          if (cachedScan.lastError) setScanError(cachedScan.lastError);
        }

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

  async function refreshKnowledge() {
    try {
      setKnowledgeItems(await api.getKnowledge(projectId));
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の再読み込みに失敗しました');
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

  async function handleSaveProjectDetails() {
    try {
      setLoading(true);
      onError(null);
      const updated = await api.updateProject(projectId, projectDetailsDraft);
      const next = {
        title: updated.title,
        coreConcept: updated.coreConcept ?? '',
        styleSample: updated.styleSample ?? '',
      };
      setProjectDetails(next);
      setProjectDetailsDraft(next);
      setProjectDetailsEditing(false);
      onProjectUpdated(updated);
      onFlashMessage('詳細設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelProjectDetails() {
    setProjectDetailsDraft(projectDetails);
    setProjectDetailsEditing(false);
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

  async function handleSaveStoryState() {
    try {
      setLoading(true);
      onError(null);
      const parsed = JSON.parse(storyStateDraft) as StoryState;
      const saved = await api.updateStoryState(projectId, parsed);
      setStoryState(saved);
      setStoryStateDraft(JSON.stringify(saved, null, 2));
      setStoryStateEditing(false);
      onFlashMessage('物語状態を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleRevertStoryDiff(diffId: string) {
    try {
      setLoading(true);
      onError(null);
      const result = await api.revertStoryStateDiff(projectId, diffId);
      const diffs = await api.getStoryStateDiffs(projectId);
      setStoryState(result.storyState);
      setStoryStateDraft(JSON.stringify(result.storyState, null, 2));
      setStoryStateDiffs(diffs);
      onFlashMessage('自動更新を取り消しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '取り消しに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleKnowledgeFiles(files: FileList | File[]) {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    try {
      setKnowledgeUploading(true);
      onError(null);
      let imported = 0;
      for (const file of selected) {
        const content = await decodeKnowledgeFile(file);
        await api.createKnowledge(projectId, { fileName: file.name, content });
        imported += 1;
      }
      await refreshKnowledge();
      onFlashMessage(`資料を${imported}件追加しました`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の追加に失敗しました');
      await refreshKnowledge();
    } finally {
      setKnowledgeUploading(false);
    }
  }

  async function handleToggleKnowledge(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      await api.updateKnowledge(projectId, item.knowledgeId, { enabled: !item.enabled });
      await refreshKnowledge();
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の更新に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleMoveKnowledge(index: number, delta: -1 | 1) {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= knowledgeItems.length) return;
    const next = [...knowledgeItems];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    try {
      setLoading(true);
      onError(null);
      await api.reorderKnowledge(projectId, next.map((item) => item.knowledgeId));
      await refreshKnowledge();
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の並べ替えに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleExpandKnowledge(item: KnowledgeListItem) {
    if (knowledgeExpandedId === item.knowledgeId) {
      setKnowledgeExpandedId(null);
      setKnowledgeEditing(false);
      return;
    }
    try {
      setLoading(true);
      onError(null);
      const result = await api.getKnowledgeContent(projectId, item.knowledgeId);
      setKnowledgeExpandedId(item.knowledgeId);
      setKnowledgeTitleDraft(result.meta.title);
      setKnowledgeContentDraft(result.content);
      setKnowledgeEditing(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料本文の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveKnowledge(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      await api.updateKnowledge(projectId, item.knowledgeId, {
        title: knowledgeTitleDraft,
        content: knowledgeContentDraft,
      });
      await refreshKnowledge();
      setKnowledgeEditing(false);
      onFlashMessage('資料を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelKnowledgeEdit(item: KnowledgeListItem) {
    try {
      setLoading(true);
      onError(null);
      const result = await api.getKnowledgeContent(projectId, item.knowledgeId);
      setKnowledgeTitleDraft(result.meta.title);
      setKnowledgeContentDraft(result.content);
      setKnowledgeEditing(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料本文の再読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteKnowledge(item: KnowledgeListItem) {
    if (!window.confirm(`資料「${item.title}」を削除しますか？`)) return;
    try {
      setLoading(true);
      onError(null);
      await api.deleteKnowledge(projectId, item.knowledgeId);
      if (knowledgeExpandedId === item.knowledgeId) {
        setKnowledgeExpandedId(null);
        setKnowledgeEditing(false);
      }
      await refreshKnowledge();
      onFlashMessage('資料を削除しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の削除に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  const worldExcerpt = extractExcerpt(worldText, 120);
  const styleTags = deriveStyleTags(project.activePresetIds, categories);
  const enabledKnowledgeChars = knowledgeItems
    .filter((item) => item.enabled && item.contentStatus === 'ok')
    .reduce((sum, item) => sum + item.charCount, 0);
  const brokenEnabledKnowledgeCount = knowledgeItems.filter(
    (item) => item.enabled && item.contentStatus !== 'ok'
  ).length;

  if (!categories) return <div className="loading">読み込み中…</div>;

  return (
    <div>
      {/* AI と相談して編集 */}
      <RefineChatPanel
        projectId={projectId}
        characters={characters}
        refineScan={refineScan}
        scanning={scanning}
        scanError={scanError}
        onScanRefine={handleScanRefine}
        onSettingsChanged={refreshWorldAndCharacters}
      />

      <section className="summary-card detail-settings-card">
        <header className="summary-card-header">
          <h2>詳細設定</h2>
          <div className="summary-card-badges">
            {projectDetails.coreConcept.trim() && <span className="settings-badge preset">核あり</span>}
            {projectDetails.styleSample.trim() && <span className="settings-badge preset">見本あり</span>}
            {!worldText.trim() && <span className="settings-badge warn">世界未設定 ⚠</span>}
            <span className="settings-meta">人物 {characters.length}人</span>
            <span className="settings-meta">資料 {knowledgeItems.length}件</span>
          </div>
        </header>
        <div className="detail-settings-tabs" role="tablist" aria-label="詳細設定">
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'basic'}
            className={detailSettingsTab === 'basic' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('basic')}
          >
            基本
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'style'}
            className={detailSettingsTab === 'style' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('style')}
          >
            文体・視点
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'world'}
            className={detailSettingsTab === 'world' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('world')}
          >
            世界
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'characters'}
            className={detailSettingsTab === 'characters' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('characters')}
          >
            人物
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'knowledge'}
            className={detailSettingsTab === 'knowledge' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('knowledge')}
          >
            資料 {knowledgeItems.length > 0 ? knowledgeItems.length : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={detailSettingsTab === 'story'}
            className={detailSettingsTab === 'story' ? 'active' : ''}
            onClick={() => setDetailSettingsTab('story')}
          >
            物語状態
          </button>
        </div>
        {detailSettingsTab === 'basic' && (
          <div className="detail-settings-panel" role="tabpanel">
        {!projectDetailsEditing && (
          <>
            <dl className="character-summary-fields">
              <div>
                <dt>作品タイトル</dt>
                <dd>{projectDetails.title}</dd>
              </div>
              <div>
                <dt>作品の核</dt>
                <dd>{projectDetails.coreConcept || <span className="summary-field-missing">未記入</span>}</dd>
              </div>
              <div>
                <dt>文体見本</dt>
                <dd>
                  {projectDetails.styleSample ? (
                    <span className="summary-prewrap-inline">{extractExcerpt(projectDetails.styleSample, 180)}</span>
                  ) : (
                    <span className="summary-field-missing">未記入</span>
                  )}
                </dd>
              </div>
            </dl>
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setProjectDetailsDraft(projectDetails);
                  setProjectDetailsEditing(true);
                }}
              >
                編集
              </button>
            </div>
          </>
        )}
        {projectDetailsEditing && (
          <>
            <label>
              作品タイトル
              <input
                type="text"
                value={projectDetailsDraft.title}
                onChange={(e) =>
                  setProjectDetailsDraft((current) => ({ ...current, title: e.target.value }))
                }
                maxLength={100}
              />
            </label>
            <textarea
              value={projectDetailsDraft.coreConcept}
              onChange={(e) =>
                setProjectDetailsDraft((current) => ({ ...current, coreConcept: e.target.value }))
              }
              placeholder="作品の核"
              rows={3}
            />
            <textarea
              value={projectDetailsDraft.styleSample}
              onChange={(e) =>
                setProjectDetailsDraft((current) => ({ ...current, styleSample: e.target.value }))
              }
              placeholder="文体見本"
              rows={8}
            />
            <div className="summary-card-actions">
              <button onClick={handleCancelProjectDetails} disabled={loading}>
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveProjectDetails} disabled={loading || !projectDetailsDraft.title.trim()}>
                保存
              </button>
            </div>
          </>
        )}
          </div>
        )}
      </section>

      {detailSettingsTab === 'style' && (
      <section className="summary-card detail-settings-panel-card">
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
      )}

      {detailSettingsTab === 'world' && (
      <section className="summary-card detail-settings-panel-card">
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
      )}

      {detailSettingsTab === 'characters' && (
      <section className="summary-card detail-settings-panel-card">
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
                        {(c.aliases?.length || c.want || c.fear || c.secrets) && (
                          <div>
                            <dt>詳細</dt>
                            <dd>
                              <span className="summary-prewrap-inline">
                                {[
                                  c.aliases?.length ? `呼び名: ${c.aliases.join(' / ')}` : '',
                                  c.want ? `欲求: ${c.want}` : '',
                                  c.fear ? `恐れ: ${c.fear}` : '',
                                  c.secrets ? `秘密: ${c.secrets}` : '',
                                ].filter(Boolean).join('\n')}
                              </span>
                            </dd>
                          </div>
                        )}
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
                  <input
                    type="text"
                    value={(c.aliases ?? []).join(', ')}
                    onChange={(e) =>
                      updateCharacterDraft(i, {
                        aliases: e.target.value
                          .split(',')
                          .map((item) => item.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder="呼び名（カンマ区切り）"
                  />
                  <textarea
                    value={c.want || ''}
                    onChange={(e) => updateCharacterDraft(i, { want: e.target.value })}
                    placeholder="欲求"
                  />
                  <textarea
                    value={c.fear || ''}
                    onChange={(e) => updateCharacterDraft(i, { fear: e.target.value })}
                    placeholder="恐れ"
                  />
                  <textarea
                    value={c.secrets || ''}
                    onChange={(e) => updateCharacterDraft(i, { secrets: e.target.value })}
                    placeholder="秘密"
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
      )}

      {detailSettingsTab === 'knowledge' && (
      <section className="summary-card detail-settings-panel-card">
        <header className="summary-card-header">
          <h2>資料</h2>
          <div className="summary-card-badges">
            <span className="settings-meta">有効 {enabledKnowledgeChars.toLocaleString()} 字</span>
            {enabledKnowledgeChars > KNOWLEDGE_WARN_CHARS && (
              <span className="settings-badge warn">多め ⚠</span>
            )}
            {brokenEnabledKnowledgeCount > 0 && (
              <span className="settings-badge warn">本文なし {brokenEnabledKnowledgeCount}件</span>
            )}
          </div>
        </header>

        <div
          className="knowledge-drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void handleKnowledgeFiles(e.dataTransfer.files);
          }}
        >
          <label className="knowledge-file-button">
            資料を追加
            <input
              type="file"
              accept=".md,.txt"
              multiple
              onChange={(e) => {
                if (e.target.files) void handleKnowledgeFiles(e.target.files);
                e.currentTarget.value = '';
              }}
              disabled={knowledgeUploading || loading}
            />
          </label>
          <span className="settings-meta">md / txt をここにドロップできます</span>
        </div>

        {enabledKnowledgeChars > KNOWLEDGE_WARN_CHARS && (
          <p className="knowledge-warning">
            資料が多く、モデルによってはコンテキストを圧迫します。注入は止めません。
          </p>
        )}

        {knowledgeItems.length === 0 ? (
          <p className="summary-empty">資料はまだありません。用語集や年表などを追加すると、以後の生成で毎回参照されます。</p>
        ) : (
          <ul className="knowledge-list">
            {knowledgeItems.map((item, index) => {
              const expanded = knowledgeExpandedId === item.knowledgeId;
              return (
                <li key={item.knowledgeId} className="knowledge-item">
                  <div className="knowledge-row">
                    <button
                      type="button"
                      className="knowledge-title-button"
                      onClick={() => handleExpandKnowledge(item)}
                    >
                      <strong>{item.title}</strong>
                      <span className="settings-meta">
                        {item.charCount.toLocaleString()} 字 / .{item.extension}
                      </span>
                    </button>
                    <div className="knowledge-row-actions">
                      {item.contentStatus !== 'ok' && (
                        <span className="settings-badge warn">
                          {item.contentStatus === 'missing' ? '本文なし' : '空'}
                        </span>
                      )}
                      {item.charCount > 5000 && <span className="settings-badge warn">5千字超</span>}
                      <label className="knowledge-toggle">
                        <input
                          type="checkbox"
                          checked={item.enabled}
                          onChange={() => handleToggleKnowledge(item)}
                          disabled={loading}
                        />
                        有効
                      </label>
                      <button
                        type="button"
                        onClick={() => handleMoveKnowledge(index, -1)}
                        disabled={loading || index === 0}
                        aria-label={`${item.title}を上へ`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMoveKnowledge(index, 1)}
                        disabled={loading || index === knowledgeItems.length - 1}
                        aria-label={`${item.title}を下へ`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDeleteKnowledge(item)}
                        disabled={loading}
                      >
                        削除
                      </button>
                    </div>
                  </div>

                  {expanded && (
                    <div className="knowledge-editor">
                      {!knowledgeEditing ? (
                        <>
                          <pre className="summary-prewrap">
                            {knowledgeContentDraft || '（本文が空です）'}
                          </pre>
                          <div className="summary-card-actions">
                            <button
                              type="button"
                              onClick={() => setKnowledgeEditing(true)}
                              disabled={loading}
                            >
                              編集
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <label>
                            タイトル
                            <input
                              type="text"
                              value={knowledgeTitleDraft}
                              maxLength={100}
                              onChange={(e) => setKnowledgeTitleDraft(e.target.value)}
                            />
                          </label>
                          <textarea
                            value={knowledgeContentDraft}
                            onChange={(e) => setKnowledgeContentDraft(e.target.value)}
                            rows={14}
                          />
                          <div className="summary-card-actions">
                            <button
                              type="button"
                              onClick={() => handleCancelKnowledgeEdit(item)}
                              disabled={loading}
                            >
                              キャンセル
                            </button>
                            <button
                              type="button"
                              className="primary"
                              onClick={() => handleSaveKnowledge(item)}
                              disabled={loading || !knowledgeTitleDraft.trim()}
                            >
                              保存
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {detailSettingsTab === 'story' && (
      <section className="summary-card detail-settings-panel-card">
        <header className="summary-card-header">
          <h2>物語状態</h2>
          <div className="summary-card-badges">
            {storyState?.clock && (
              <span className="settings-meta">
                {storyState.clock.day}日目{storyState.clock.timeOfDay ? `・${storyState.clock.timeOfDay}` : ''}
              </span>
            )}
            {storyState && <span className="settings-meta">{storyState.updatedAt.slice(0, 10)}</span>}
          </div>
        </header>
        {storyState && !storyStateEditing && (
          <>
            <dl className="character-summary-fields">
              <div>
                <dt>現在の状況</dt>
                <dd>
                  {storyState.currentSituation.length > 0
                    ? storyState.currentSituation.join('\n')
                    : <span className="summary-field-missing">未記入</span>}
                </dd>
              </div>
              <div>
                <dt>重要イベント</dt>
                <dd>{storyState.importantEvents.filter((event) => event.status !== 'archived').length}件</dd>
              </div>
              <div>
                <dt>未解決</dt>
                <dd>{storyState.openThreads.filter((thread) => thread.status === 'active').length}件</dd>
              </div>
              <div>
                <dt>未確定</dt>
                <dd>{(storyState.authorUndecided ?? []).filter((item) => item.status === 'active').length}件</dd>
              </div>
            </dl>
            <details className="summary-details">
              <summary>状態JSON</summary>
              <pre className="summary-prewrap">{JSON.stringify(storyState, null, 2)}</pre>
            </details>
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setStoryStateDraft(JSON.stringify(storyState, null, 2));
                  setStoryStateEditing(true);
                }}
              >
                編集
              </button>
            </div>
          </>
        )}
        {storyStateEditing && (
          <>
            <textarea
              value={storyStateDraft}
              onChange={(e) => setStoryStateDraft(e.target.value)}
              rows={18}
              className="system-prompt-editor"
            />
            <div className="summary-card-actions">
              <button
                onClick={() => {
                  setStoryStateDraft(storyState ? JSON.stringify(storyState, null, 2) : '');
                  setStoryStateEditing(false);
                }}
                disabled={loading}
              >
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveStoryState} disabled={loading}>
                保存
              </button>
            </div>
          </>
        )}
        {storyStateDiffs.length > 0 && (
          <div className="story-diff-list">
            <h3>自動更新の履歴</h3>
            <ul className="setup-commit-edit-list">
              {storyStateDiffs.map((diff) => {
                const latestRevertible = storyStateDiffs.find((item) => !item.reverted);
                const canRevert =
                  latestRevertible?.diffId === diff.diffId && Boolean(diff.beforeState);
                return (
                  <li key={diff.diffId} className="setup-commit-edit-row">
                    <div>
                      <strong>{formatStoryDiffSummary(diff)}</strong>
                      <div className="settings-meta">
                        {formatRelativeTime(diff.appliedAt)}
                        {diff.reverted ? ' / 取り消し済み' : ''}
                      </div>
                    </div>
                    {canRevert && (
                      <div className="setup-commit-row-actions">
                        <button
                          type="button"
                          onClick={() => handleRevertStoryDiff(diff.diffId)}
                          disabled={loading}
                        >
                          この更新を取り消す
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>
      )}

    </div>
  );
}

async function decodeKnowledgeFile(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.md') && !lower.endsWith('.txt')) {
    throw new Error(`${file.name}: md / txt のみ追加できます`);
  }
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    const decoded = new TextDecoder('shift_jis').decode(buffer);
    const chars = [...decoded];
    const replacementCount = chars.filter((char) => char === '\uFFFD').length;
    const ratio = chars.length === 0 ? 0 : replacementCount / chars.length;
    if (ratio > 0.005) {
      throw new Error(`${file.name}: 文字コードを判定できませんでした`);
    }
    return decoded;
  }
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

function formatStoryDiffSummary(diff: StoryStateDiffRecord): string {
  const parts = [
    diff.summary.addedEvents.length ? `イベント+${diff.summary.addedEvents.length}` : '',
    diff.summary.updatedEvents.length ? `イベント更新${diff.summary.updatedEvents.length}` : '',
    diff.summary.addedThreads.length ? `未解決+${diff.summary.addedThreads.length}` : '',
    diff.summary.resolvedThreads.length ? `解決${diff.summary.resolvedThreads.length}` : '',
    diff.summary.updatedCharacters.length ? `人物${diff.summary.updatedCharacters.length}名` : '',
    diff.summary.clockChanged ? '時間更新' : '',
  ].filter(Boolean);
  return parts.join(' / ') || `自動更新 ${diff.generationId}`;
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
