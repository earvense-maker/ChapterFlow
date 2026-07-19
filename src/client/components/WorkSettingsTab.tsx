import { useEffect, useRef, useState } from 'react';
import { api } from '../clientApi';
import { useConfirm } from './ConfirmDialog';
import {
  KNOWLEDGE_WARN_CHARS,
  SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS,
  SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS,
} from '@shared/types';
import RefineChatPanel from './RefineChatPanel';
import CharacterTraitsEditor from './CharacterTraitsEditor';
import PresetSelector, { type PresetCategory } from './PresetSelector';
import type {
  Character,
  KnowledgeListItem,
  PresetsFile,
  Project,
  RefineReviewStatus,
  RefineScanResult,
  StoryState,
  StoryStateDiffRecord,
  StyleSamplePreset,
  SystemPromptPreview,
  SystemPromptPreset,
  WorldContent,
} from '@shared/types';

interface Props {
  projectId: string;
  project: Project;
  onError: (msg: string | null) => void;
  onFlashMessage: (msg: string) => void;
  onProjectUpdated: (project: Project) => void;
}

type DetailSettingsTab = 'basic' | 'style' | 'world' | 'characters' | 'story' | 'knowledge';
type WorldArea = keyof WorldContent;

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
const styleTagCategoryOrder = [
  'narration',
  'aftertaste',
  'emotionDisplay',
  'sceneProgression',
  'chapterEnding',
  'painLevel',
] as const;

export default function WorkSettingsTab({
  projectId,
  project,
  onError,
  onFlashMessage,
  onProjectUpdated,
}: Props) {
  const confirmAction = useConfirm();
  const [categories, setCategories] = useState<Record<string, PresetCategory> | null>(null);
  const [presets, setPresets] = useState<Partial<PresetsFile>>({});
  const [world, setWorld] = useState<WorldContent>({ foundation: '', initialSituation: '' });
  const [worldSubTab, setWorldSubTab] = useState<WorldArea>('initialSituation');
  const [foundationDraft, setFoundationDraft] = useState('');
  const [foundationEditing, setFoundationEditing] = useState(false);
  const [foundationExpanded, setFoundationExpanded] = useState(false);
  const [initialSituationDraft, setInitialSituationDraft] = useState('');
  const [initialSituationEditing, setInitialSituationEditing] = useState(false);
  const [initialSituationExpanded, setInitialSituationExpanded] = useState(false);
  const worldRefreshRequestId = useRef(0);
  const [projectDetails, setProjectDetails] = useState({
    title: project.title,
    coreConcept: project.coreConcept ?? '',
  });
  const [projectDetailsDraft, setProjectDetailsDraft] = useState(projectDetails);
  const [projectDetailsEditing, setProjectDetailsEditing] = useState(false);
  const [detailSettingsTab, setDetailSettingsTab] = useState<DetailSettingsTab>('basic');

  const [styleSample, setStyleSample] = useState(project.styleSample ?? '');
  const [styleSampleDraft, setStyleSampleDraft] = useState(project.styleSample ?? '');
  const [styleSampleEditing, setStyleSampleEditing] = useState(false);
  const [styleSamplePresets, setStyleSamplePresets] = useState<StyleSamplePreset[]>([]);
  const [selectedStyleSamplePresetId, setSelectedStyleSamplePresetId] = useState('');

  const [characters, setCharacters] = useState<Character[]>([]);
  const [charactersDraft, setCharactersDraft] = useState<Character[]>([]);
  const [charactersEditing, setCharactersEditing] = useState(false);

  const [systemPrompt, setSystemPrompt] = useState('');
  const [systemPromptDraft, setSystemPromptDraft] = useState('');
  const [baseSystemPromptDraft, setBaseSystemPromptDraft] = useState('');
  const [defaultBaseSystemPrompt, setDefaultBaseSystemPrompt] = useState('');
  const [generatedSystemPrompt, setGeneratedSystemPrompt] = useState('');
  const [isSystemPromptCustomized, setIsSystemPromptCustomized] = useState(false);
  const [systemPromptEditing, setSystemPromptEditing] = useState(false);
  const [systemPromptPresets, setSystemPromptPresets] = useState<SystemPromptPreset[]>([]);
  const [selectedSystemPromptPresetId, setSelectedSystemPromptPresetId] = useState('');
  const [systemPromptPresetNameDraft, setSystemPromptPresetNameDraft] = useState('');
  const [systemPromptPresetLoading, setSystemPromptPresetLoading] = useState(false);
  const [systemPromptPresetLoadError, setSystemPromptPresetLoadError] = useState<string | null>(null);

  const [refineScan, setRefineScan] = useState<RefineScanResult | null>(null);
  const [refineReviewStatus, setRefineReviewStatus] = useState<RefineReviewStatus | null>(null);
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
    worldRefreshRequestId.current += 1;

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
        setWorld(worldData);
        setFoundationDraft(worldData.foundation);
        setInitialSituationDraft(worldData.initialSituation);
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
        const previewBaseSystemPrompt =
          promptPreview.baseSystemPrompt ?? promptPreview.generatedSystemPrompt ?? '';
        const previewDefaultBaseSystemPrompt =
          promptPreview.defaultBaseSystemPrompt ?? previewBaseSystemPrompt;
        setPresets({
          ...presetsData,
          baseSystemPrompt: previewBaseSystemPrompt,
          customSystemPrompt: promptPreview.customSystemPrompt,
        });
        setSystemPrompt(promptPreview.systemPrompt);
        setSystemPromptDraft(promptPreview.customSystemPrompt);
        setBaseSystemPromptDraft(previewBaseSystemPrompt);
        setDefaultBaseSystemPrompt(previewDefaultBaseSystemPrompt);
        setGeneratedSystemPrompt(promptPreview.generatedSystemPrompt);
        setIsSystemPromptCustomized(promptPreview.isCustomized);

        // NOTE: 前回の scan 結果があれば表示。無ければ null のまま。
        // 起動時に scan は自動実行しない（トークン消費を明示ボタンに限定）。
        const [cachedScan, reviewStatus] = await Promise.all([
          api.getRefineScan(projectId).catch(() => null),
          api.getRefineReviewStatus(projectId).catch(() => null),
        ]);
        if (!cancelled && cachedScan) {
          setRefineScan(cachedScan);
          // NOTE: キャッシュ済み結果に lastError が入っていれば、それも UI に見せる。
          if (cachedScan.lastError) setScanError(cachedScan.lastError);
        }
        if (!cancelled) setRefineReviewStatus(reviewStatus);

        // NOTE: 見本ギャラリー。取得失敗時は空配列のまま（select 非表示にする）。
        try {
          const samples = await api.getStyleSamples();
          if (!cancelled) setStyleSamplePresets(samples);
        } catch {
          if (!cancelled) setStyleSamplePresets([]);
        }

        try {
          const promptPresets = await api.getSystemPromptPresets();
          if (!cancelled) {
            setSystemPromptPresets(promptPresets);
            setSystemPromptPresetLoadError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setSystemPromptPresets([]);
            setSystemPromptPresetLoadError(
              err instanceof Error ? err.message : 'プリセット一覧の読み込みに失敗しました'
            );
          }
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
    const requestId = ++worldRefreshRequestId.current;
    try {
      const [worldData, charsData] = await Promise.all([
        api.getWorld(projectId),
        api.getCharacters(projectId),
      ]);
      if (requestId === worldRefreshRequestId.current) {
        setWorld(worldData);
        if (!foundationEditing) setFoundationDraft(worldData.foundation);
        if (!initialSituationEditing) setInitialSituationDraft(worldData.initialSituation);
      }
      setCharacters(charsData);
      if (!charactersEditing) setCharactersDraft(charsData);
    } catch (err) {
      onError(err instanceof Error ? err.message : '再読み込みに失敗しました');
    }
  }

  async function refreshRefineReviewStatus() {
    try {
      setRefineReviewStatus(await api.getRefineReviewStatus(projectId));
    } catch {
      // NOTE: status が取れなくても既存の scan 表示や設定編集は妨げない。
      setRefineReviewStatus(null);
    }
  }

  async function refreshKnowledge() {
    try {
      setKnowledgeItems(await api.getKnowledge(projectId));
    } catch (err) {
      onError(err instanceof Error ? err.message : '資料の再読み込みに失敗しました');
    }
  }

  async function handleSaveWorldArea(area: WorldArea) {
    try {
      setLoading(true);
      onError(null);
      const value = area === 'foundation' ? foundationDraft : initialSituationDraft;
      const next = await api.updateWorldArea(projectId, area, value);
      worldRefreshRequestId.current += 1;
      setWorld(next);
      if (area === 'foundation') setFoundationEditing(false);
      else setInitialSituationEditing(false);
      void refreshRefineReviewStatus();
      onFlashMessage(`${area === 'foundation' ? '世界の土台' : '開始時点の状況'}を保存しました`);
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelWorldArea(area: WorldArea) {
    if (area === 'foundation') {
      setFoundationDraft(world.foundation);
      setFoundationEditing(false);
    } else {
      setInitialSituationDraft(world.initialSituation);
      setInitialSituationEditing(false);
    }
  }

  async function handleSaveCharacters() {
    try {
      setLoading(true);
      onError(null);
      const savedCharacters = await api.updateCharacters(projectId, charactersDraft);
      setCharacters(savedCharacters);
      setCharactersDraft(savedCharacters);
      setCharactersEditing(false);
      void refreshRefineReviewStatus();
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
      };
      setProjectDetails(next);
      setProjectDetailsDraft(next);
      setProjectDetailsEditing(false);
      onProjectUpdated(updated);
      void refreshRefineReviewStatus();
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

  async function handleSaveStyleSample() {
    try {
      setLoading(true);
      onError(null);
      const updated = await api.updateProject(projectId, { styleSample: styleSampleDraft });
      const next = updated.styleSample ?? '';
      setStyleSample(next);
      setStyleSampleDraft(next);
      setStyleSampleEditing(false);
      setSelectedStyleSamplePresetId('');
      onProjectUpdated(updated);
      onFlashMessage('文体見本を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelStyleSample() {
    setStyleSampleDraft(styleSample);
    setStyleSampleEditing(false);
    setSelectedStyleSamplePresetId('');
  }

  async function handleApplyStyleSamplePreset() {
    const preset = styleSamplePresets.find((p) => p.id === selectedStyleSamplePresetId);
    if (!preset) return;
    const hasContent = styleSampleDraft.trim().length > 0;
    if (
      hasContent &&
      !(await confirmAction('現在の見本を選んだ見本で置き換えます。よろしいですか？', {
        confirmLabel: '置き換える',
      }))
    ) {
      return;
    }
    setStyleSampleDraft(preset.text);
    // NOTE: 反映後は select を初期状態へ戻し、フラッシュで採用済みを明示する。
    // 同じ見本を続けて2回押しても効かなかったように見えるのを防ぐ意図もある。
    setSelectedStyleSamplePresetId('');
    onFlashMessage(`「${preset.label}」を下書きに反映しました。忘れず保存してください。`);
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
      const baseSystemPrompt = baseSystemPromptDraft.trim();
      const customSystemPrompt = systemPromptDraft.trim() ? systemPromptDraft : '';
      const savedPresets = await api.updateProjectPresets(projectId, {
        ...presets,
        baseSystemPrompt,
        customSystemPrompt,
      });
      // NOTE: 保存 API の返却値は正規化済みの正とし、プレビュー失敗後の別設定保存でも
      // 古い customSystemPrompt を再送して上書きしないよう、先にローカル状態へ反映する。
      setPresets(savedPresets);
      let preview: SystemPromptPreview;
      try {
        preview = await api.previewSystemPrompt(
          projectId,
          savedPresets,
          savedPresets.customSystemPrompt ?? ''
        );
      } catch (err) {
        onError(
          err instanceof Error
            ? `システムプロンプトは保存されましたが、プレビューの更新に失敗しました: ${err.message}`
            : 'システムプロンプトは保存されましたが、プレビューの更新に失敗しました'
        );
        return;
      }
      const previewBaseSystemPrompt =
        preview.baseSystemPrompt ?? preview.generatedSystemPrompt ?? '';
      const previewDefaultBaseSystemPrompt =
        preview.defaultBaseSystemPrompt ?? previewBaseSystemPrompt;
      setPresets({
        ...savedPresets,
        baseSystemPrompt: previewBaseSystemPrompt,
        customSystemPrompt: preview.customSystemPrompt,
      });
      setSystemPrompt(preview.systemPrompt);
      setSystemPromptDraft(preview.customSystemPrompt);
      setBaseSystemPromptDraft(previewBaseSystemPrompt);
      setDefaultBaseSystemPrompt(previewDefaultBaseSystemPrompt);
      setGeneratedSystemPrompt(preview.generatedSystemPrompt);
      setIsSystemPromptCustomized(preview.isCustomized);
      setSystemPromptEditing(false);
      void refreshRefineReviewStatus();
      onFlashMessage('システムプロンプトを保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleCancelSystemPrompt() {
    setSystemPromptDraft(presets.customSystemPrompt ?? '');
    setBaseSystemPromptDraft(presets.baseSystemPrompt ?? defaultBaseSystemPrompt);
    setSystemPromptEditing(false);
  }

  async function handleLoadSystemPromptPreset() {
    const preset = systemPromptPresets.find((item) => item.id === selectedSystemPromptPresetId);
    if (!preset) return;
    if (
      systemPromptDraft !== (presets.customSystemPrompt ?? '') &&
      systemPromptDraft !== preset.prompt &&
      !(await confirmAction('未保存の編集内容を、選択したプリセットで置き換えますか？', {
        confirmLabel: '置き換える',
      }))
    ) {
      return;
    }
    setSystemPromptDraft(preset.prompt);
    setSystemPromptPresetNameDraft(preset.name);
    onFlashMessage(`プリセット「${preset.name}」を読み込みました。作品へ反映するには保存してください`);
  }

  async function handleReloadSystemPromptPresets() {
    try {
      setSystemPromptPresetLoading(true);
      onError(null);
      setSystemPromptPresets(await api.getSystemPromptPresets());
      setSystemPromptPresetLoadError(null);
      setSelectedSystemPromptPresetId('');
      setSystemPromptPresetNameDraft('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'プリセット一覧の読み込みに失敗しました';
      setSystemPromptPresetLoadError(message);
      onError(message);
    } finally {
      setSystemPromptPresetLoading(false);
    }
  }

  async function handleSaveSystemPromptPreset() {
    const name = systemPromptPresetNameDraft.trim();
    if (!name || !systemPromptDraft.trim()) return;

    const existing = systemPromptPresets.find(
      (item) => item.name.toLocaleLowerCase('ja-JP') === name.toLocaleLowerCase('ja-JP')
    );
    if (
      existing &&
      !(await confirmAction(`プリセット「${existing.name}」を現在の内容で上書きしますか？`, {
        confirmLabel: '上書き',
      }))
    ) {
      return;
    }

    try {
      setSystemPromptPresetLoading(true);
      onError(null);
      const saved = existing
        ? await api.updateSystemPromptPreset(existing.id, {
            name,
            prompt: systemPromptDraft,
            expectedUpdatedAt: existing.updatedAt,
          })
        : await api.createSystemPromptPreset({ name, prompt: systemPromptDraft });
      setSystemPromptPresets((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
      setSelectedSystemPromptPresetId(saved.id);
      setSystemPromptPresetNameDraft(saved.name);
      onFlashMessage(`プリセット「${saved.name}」を保存しました`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'プリセットの保存に失敗しました';
      onError(message);
      // NOTE: 409競合を含む失敗後は、別画面での更新を反映して次の操作を安全にする。
      try {
        setSystemPromptPresets(await api.getSystemPromptPresets());
        setSelectedSystemPromptPresetId('');
        setSystemPromptPresetNameDraft('');
        setSystemPromptPresetLoadError(null);
      } catch (reloadErr) {
        setSystemPromptPresetLoadError(
          reloadErr instanceof Error ? reloadErr.message : 'プリセット一覧の再読み込みに失敗しました'
        );
      }
    } finally {
      setSystemPromptPresetLoading(false);
    }
  }

  async function handleDeleteSystemPromptPreset() {
    const preset = systemPromptPresets.find((item) => item.id === selectedSystemPromptPresetId);
    if (
      !preset ||
      !(await confirmAction(`プリセット「${preset.name}」を削除しますか？`, {
        confirmLabel: '削除',
        danger: true,
      }))
    ) return;

    try {
      setSystemPromptPresetLoading(true);
      onError(null);
      await api.deleteSystemPromptPreset(preset.id);
      setSystemPromptPresets((items) => items.filter((item) => item.id !== preset.id));
      setSelectedSystemPromptPresetId('');
      setSystemPromptPresetNameDraft('');
      onFlashMessage(`プリセット「${preset.name}」を削除しました`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'プリセットの削除に失敗しました');
    } finally {
      setSystemPromptPresetLoading(false);
    }
  }

  async function handleScanRefine() {
    try {
      setScanning(true);
      setScanError(null);
      const result = await api.scanRefine(projectId);
      setRefineScan(result);
      await refreshRefineReviewStatus();
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

  async function handlePresetChange(nextActivePresetIds: Project['activePresetIds']) {
    try {
      setLoading(true);
      onError(null);
      // NOTE: updateProject は部分更新をマージするため、UI で「指定しない」に戻した値は
      // 空値を明示して正規化時に削除させる。JSON では undefined が落ちるので使わない。
      const activePresetIds = {
        ...nextActivePresetIds,
        ...clearRemovedPresetValues(project.activePresetIds, nextActivePresetIds),
      };
      const savedProject = await api.updateProject(projectId, {
        activePresetIds,
      });
      onProjectUpdated(savedProject);
      const preview = await api.previewSystemPrompt(
        projectId,
        presets,
        presets.customSystemPrompt
      );
      const previewBaseSystemPrompt =
        preview.baseSystemPrompt ?? preview.generatedSystemPrompt ?? '';
      const previewDefaultBaseSystemPrompt =
        preview.defaultBaseSystemPrompt ?? previewBaseSystemPrompt;
      setSystemPrompt(preview.systemPrompt);
      setBaseSystemPromptDraft(previewBaseSystemPrompt);
      setDefaultBaseSystemPrompt(previewDefaultBaseSystemPrompt);
      setGeneratedSystemPrompt(preview.generatedSystemPrompt);
      setIsSystemPromptCustomized(preview.isCustomized);
      setPresets({
        ...presets,
        baseSystemPrompt: previewBaseSystemPrompt,
        customSystemPrompt: preview.customSystemPrompt,
      });
      if (!systemPromptEditing) setSystemPromptDraft(preview.customSystemPrompt);
      void refreshRefineReviewStatus();
      onFlashMessage('作風設定を保存しました');
    } catch (err) {
      onError(err instanceof Error ? err.message : '保存に失敗しました');
    } finally {
      setLoading(false);
    }
  }

  function handleResetSystemPrompt() {
    onError(null);
    setSystemPromptDraft('');
  }

  function handleResetBaseSystemPrompt() {
    onError(null);
    setBaseSystemPromptDraft(defaultBaseSystemPrompt);
  }

  async function handleSaveStoryState() {
    try {
      onError(null);
      let parsed: StoryState;
      try {
        parsed = JSON.parse(storyStateDraft) as StoryState;
      } catch (parseErr) {
        onError(parseErr instanceof Error ? `JSON構文エラー: ${parseErr.message}` : 'JSON構文エラー');
        return;
      }
      // NOTE: JSON生編集の事故予防。主要配列が減っていたら明示 confirm。
      // 増加や維持は素通し、減少幅と種別を並べて表示する。
      const reduction = storyState ? summarizeStoryStateReduction(storyState, parsed) : [];
      if (reduction.length > 0) {
        const message = [
          '以下の項目が減っています。保存すると復元は差分履歴からのみ可能です。',
          '',
          ...reduction.map((line) => `・${line}`),
          '',
          '本当に保存しますか？',
        ].join('\n');
        if (!(await confirmAction(message, { confirmLabel: '保存', danger: true }))) return;
      }
      setLoading(true);
      const saved = await api.updateStoryState(projectId, parsed);
      setStoryState(saved);
      setStoryStateDraft(JSON.stringify(saved, null, 2));
      setStoryStateEditing(false);
      void refreshRefineReviewStatus();
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
      void refreshRefineReviewStatus();
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
    if (
      !(await confirmAction(`資料「${item.title}」を削除しますか？`, {
        confirmLabel: '削除',
        danger: true,
      }))
    ) return;
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

  const worldIsEmpty = !world.foundation.trim() && !world.initialSituation.trim();
  const activeWorldText = world[worldSubTab];
  const activeWorldDraft =
    worldSubTab === 'foundation' ? foundationDraft : initialSituationDraft;
  const activeWorldEditing =
    worldSubTab === 'foundation' ? foundationEditing : initialSituationEditing;
  const activeWorldExpanded =
    worldSubTab === 'foundation' ? foundationExpanded : initialSituationExpanded;
  const styleTags = deriveStyleTags(project.activePresetIds, categories);
  const isSystemPromptDraftCustomized = systemPromptDraft.trim().length > 0;
  const isBaseSystemPromptDraftCustomized =
    baseSystemPromptDraft.trim() !== defaultBaseSystemPrompt.trim();
  const isBaseSystemPromptCustomized =
    (presets.baseSystemPrompt ?? defaultBaseSystemPrompt).trim() !==
    defaultBaseSystemPrompt.trim();
  const enabledKnowledgeChars = knowledgeItems
    .filter((item) => item.enabled && item.contentStatus === 'ok')
    .reduce((sum, item) => sum + item.charCount, 0);
  const brokenEnabledKnowledgeCount = knowledgeItems.filter(
    (item) => item.enabled && item.contentStatus !== 'ok'
  ).length;
  const refineNudgeMessage = refineReviewStatus?.needsReview
    ? buildRefineNudgeMessage(refineReviewStatus)
    : null;
  const initialStateLabel =
    project.projectType === 'roleplay' ? '会話開始時点の状態' : '初期状態（物語開始時点）';

  if (!categories) return <div className="loading">読み込み中…</div>;

  return (
    <div>
      {/* AI と相談して編集 */}
      {refineNudgeMessage && (
        <div className="refine-review-nudge" role="status">
          {refineNudgeMessage}
        </div>
      )}
      <RefineChatPanel
        projectId={projectId}
        characters={characters}
        refineScan={refineScan}
        scanning={scanning}
        scanError={scanError}
        onScanRefine={handleScanRefine}
        onSettingsChanged={() => {
          void refreshWorldAndCharacters();
          void refreshRefineReviewStatus();
        }}
      />

      <section className="summary-card detail-settings-card">
        <header className="summary-card-header">
          <h2>詳細設定</h2>
          <div className="summary-card-badges">
            {projectDetails.coreConcept.trim() && <span className="settings-badge preset">核あり</span>}
            {styleSample.trim() && <span className="settings-badge preset">見本あり</span>}
            {worldIsEmpty && <span className="settings-badge warn">世界未設定 ⚠</span>}
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
            作風設定
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
            <div className="detail-settings-panel-header">
              <h3>基本情報</h3>
              {!projectDetailsEditing && (
                <CardEditButton
                  onClick={() => {
                    setProjectDetailsDraft(projectDetails);
                    setProjectDetailsEditing(true);
                  }}
                />
              )}
            </div>
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
            </dl>
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
          <h2>作風設定</h2>
          <div className="summary-card-badges">
            {isBaseSystemPromptCustomized && (
              <span className="settings-badge custom">基本編集済み</span>
            )}
            {isSystemPromptCustomized ? (
              <span className="settings-badge custom">追加指示あり</span>
            ) : !isBaseSystemPromptCustomized ? (
              <span className="settings-badge preset">作風設定由来</span>
            ) : null}
          </div>
          {!systemPromptEditing && (
            <CardEditButton
              onClick={() => {
                setSystemPromptDraft(presets.customSystemPrompt ?? '');
                setBaseSystemPromptDraft(
                  presets.baseSystemPrompt ?? defaultBaseSystemPrompt
                );
                setSystemPromptEditing(true);
              }}
            />
          )}
        </header>
        {!systemPromptEditing && (
          <>
            {styleTags.length > 0 && (
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
            <details className="summary-details">
              <summary>作風設定（全7カテゴリ）</summary>
              <PresetSelector
                categories={categories}
                value={project.activePresetIds}
                onChange={handlePresetChange}
                disabled={loading}
                namePrefix="work-preset"
              />
            </details>
          </>
        )}
        {systemPromptEditing && (
          <>
            <p className="settings-help">
              基本プロンプトはこの作品の生成で常に適用されます。選択中の作風設定はその後ろに、作品固有の追加指示はさらに後ろに加わります。
            </p>
            <div className="prompt-toolbar">
              <strong>
                常に適用される基本プロンプト（{baseSystemPromptDraft.length} 字）
              </strong>
              <span className="prompt-status">
                {isBaseSystemPromptDraftCustomized ? '編集済み' : '初期値'}
              </span>
              <button
                type="button"
                onClick={handleResetBaseSystemPrompt}
                disabled={loading || !isBaseSystemPromptDraftCustomized}
              >
                初期値に戻す
              </button>
            </div>
            <textarea
              className="system-prompt-editor"
              aria-label="常に適用される基本プロンプト"
              maxLength={SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS}
              value={baseSystemPromptDraft}
              onChange={(event) => setBaseSystemPromptDraft(event.target.value)}
            />
            <details className="summary-details">
              <summary>
                保存済みの基本プロンプトと選択設定（{generatedSystemPrompt.length} 字）
              </summary>
              <pre className="summary-prewrap">{generatedSystemPrompt}</pre>
            </details>
            <div className="system-prompt-preset-library">
              <p className="settings-help">
                追加指示を全作品共通のプリセットとして保存・読み込みできます。読み込み後は、下の「保存」で作品に反映してください。
              </p>
              {systemPromptPresetLoadError && (
                <div className="system-prompt-preset-error">
                  <span>プリセット一覧を読み込めませんでした。</span>
                  <button
                    type="button"
                    onClick={handleReloadSystemPromptPresets}
                    disabled={systemPromptPresetLoading}
                  >
                    再試行
                  </button>
                </div>
              )}
              <div className="system-prompt-preset-row">
                <select
                  aria-label="システムプロンプトのプリセット"
                  value={selectedSystemPromptPresetId}
                  disabled={loading || systemPromptPresetLoading || Boolean(systemPromptPresetLoadError)}
                  onChange={(event) => {
                    const id = event.target.value;
                    const preset = systemPromptPresets.find((item) => item.id === id);
                    setSelectedSystemPromptPresetId(id);
                    setSystemPromptPresetNameDraft(preset?.name ?? '');
                  }}
                >
                  <option value="">保存済みプリセットを選択</option>
                  {systemPromptPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleLoadSystemPromptPreset}
                  disabled={
                    loading ||
                    systemPromptPresetLoading ||
                    Boolean(systemPromptPresetLoadError) ||
                    !selectedSystemPromptPresetId
                  }
                >
                  読み込む
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={handleDeleteSystemPromptPreset}
                  disabled={
                    loading ||
                    systemPromptPresetLoading ||
                    Boolean(systemPromptPresetLoadError) ||
                    !selectedSystemPromptPresetId
                  }
                >
                  削除
                </button>
              </div>
              <div className="system-prompt-preset-row">
                <input
                  type="text"
                  aria-label="保存するプリセット名"
                  placeholder="プリセット名"
                  maxLength={SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS}
                  value={systemPromptPresetNameDraft}
                  disabled={loading || systemPromptPresetLoading || Boolean(systemPromptPresetLoadError)}
                  onChange={(event) => setSystemPromptPresetNameDraft(event.target.value)}
                />
                <button
                  type="button"
                  onClick={handleSaveSystemPromptPreset}
                  disabled={
                    loading ||
                    systemPromptPresetLoading ||
                    Boolean(systemPromptPresetLoadError) ||
                    !systemPromptPresetNameDraft.trim() ||
                    !systemPromptDraft.trim()
                  }
                >
                  現在の内容をプリセット保存
                </button>
              </div>
            </div>
            <div className="prompt-toolbar">
              <strong>作品固有の追加指示</strong>
              <span className="prompt-status">
                {isSystemPromptDraftCustomized ? '追加指示あり' : '追加指示なし'}
              </span>
              <button onClick={handleResetSystemPrompt} disabled={loading}>
                追加指示をクリア
              </button>
            </div>
            <textarea
              className="system-prompt-editor"
              aria-label="システムプロンプトの追加指示"
              maxLength={SYSTEM_PROMPT_PRESET_PROMPT_MAX_CHARS}
              placeholder="作風設定に加えて守ってほしい、作品固有の指示を入力"
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

      {detailSettingsTab === 'style' && (
      <section className="summary-card detail-settings-panel-card">
        <header className="summary-card-header">
          <h2>文体見本</h2>
          <div className="summary-card-badges">
            {styleSample.trim() ? (
              <span className="settings-badge preset">見本あり</span>
            ) : (
              <span className="settings-meta">未設定</span>
            )}
          </div>
          {!styleSampleEditing && (
            <CardEditButton
              onClick={() => {
                setStyleSampleDraft(styleSample);
                setSelectedStyleSamplePresetId('');
                setStyleSampleEditing(true);
              }}
            />
          )}
        </header>
        <p className="settings-help">
          文体・リズム・描写密度のサンプル本文です。生成時は本文の一部として参照され、作風設定より見本の質感が優先されます（人称・視点は上書きされません）。
        </p>
        {!styleSampleEditing && (
          <>
            {styleSample.trim() ? (
              <p className="summary-excerpt">{extractExcerpt(styleSample, 260)}</p>
            ) : (
              <p className="summary-empty">見本は未設定です。ギャラリーから選ぶか、直接入力できます。</p>
            )}
          </>
        )}
        {styleSampleEditing && (
          <>
            {styleSamplePresets.length > 0 && (
              <div className="style-sample-gallery">
                <label>
                  見本ギャラリーから選ぶ
                  <select
                    value={selectedStyleSamplePresetId}
                    onChange={(e) => setSelectedStyleSamplePresetId(e.target.value)}
                    disabled={loading}
                  >
                    <option value="">（選択してください）</option>
                    {styleSamplePresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedStyleSamplePresetId && (() => {
                  const preset = styleSamplePresets.find((p) => p.id === selectedStyleSamplePresetId);
                  if (!preset) return null;
                  return (
                    <div className="style-sample-preview">
                      <p className="settings-help">{preset.description}</p>
                      <pre className="summary-prewrap">{preset.text}</pre>
                      <button
                        type="button"
                        className="primary"
                        onClick={handleApplyStyleSamplePreset}
                        disabled={loading}
                      >
                        この見本を採用
                      </button>
                    </div>
                  );
                })()}
              </div>
            )}
            <textarea
              value={styleSampleDraft}
              onChange={(e) => setStyleSampleDraft(e.target.value)}
              placeholder="文体見本（1000字まで）"
              rows={10}
              maxLength={1000}
            />
            <div className="summary-card-actions">
              <button onClick={handleCancelStyleSample} disabled={loading}>
                キャンセル
              </button>
              <button className="primary" onClick={handleSaveStyleSample} disabled={loading}>
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
            {worldIsEmpty && <span className="settings-badge warn">未設定 ⚠</span>}
            {!worldIsEmpty && (
              <span className="settings-meta">
                {world.foundation.length + world.initialSituation.length} 字
              </span>
            )}
          </div>
          {!activeWorldEditing && (
            <CardEditButton
              onClick={() => {
                if (worldSubTab === 'foundation') {
                  setFoundationDraft(world.foundation);
                  setFoundationEditing(true);
                } else {
                  setInitialSituationDraft(world.initialSituation);
                  setInitialSituationEditing(true);
                }
              }}
            />
          )}
        </header>
        <div className="detail-settings-tabs" role="tablist" aria-label="世界設定の領域">
          <button
            type="button"
            role="tab"
            aria-selected={worldSubTab === 'foundation'}
            className={worldSubTab === 'foundation' ? 'active' : ''}
            onClick={() => setWorldSubTab('foundation')}
          >
            世界の土台
            {!world.foundation.trim() && !worldIsEmpty && (
              <span className="settings-badge">未記入</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={worldSubTab === 'initialSituation'}
            className={worldSubTab === 'initialSituation' ? 'active' : ''}
            onClick={() => setWorldSubTab('initialSituation')}
          >
            開始時点の状況
            {!world.initialSituation.trim() && !worldIsEmpty && (
              <span className="settings-badge">未記入</span>
            )}
          </button>
        </div>
        {!activeWorldEditing && (
          <>
            {activeWorldText.trim() ? (
              activeWorldExpanded ? (
                <pre className="summary-prewrap">{activeWorldText}</pre>
              ) : (
                <>
                  <p className="summary-excerpt">{extractExcerpt(activeWorldText, 120)}</p>
                  {activeWorldText.length > extractExcerpt(activeWorldText, 120).length && (
                    <button
                      className="summary-link-button"
                      onClick={() =>
                        worldSubTab === 'foundation'
                          ? setFoundationExpanded(true)
                          : setInitialSituationExpanded(true)
                      }
                    >
                      全文を見る ▼
                    </button>
                  )}
                </>
              )
            ) : (
              <p className="summary-empty">
                {worldSubTab === 'foundation'
                  ? '物語進行で変わらない世界の土台が未入力です。'
                  : '物語や会話の開始時点の状況が未入力です。'}
              </p>
            )}
            {activeWorldExpanded && (
              <button
                className="summary-link-button"
                onClick={() =>
                  worldSubTab === 'foundation'
                    ? setFoundationExpanded(false)
                    : setInitialSituationExpanded(false)
                }
              >
                折りたたむ ▲
              </button>
            )}
          </>
        )}
        {activeWorldEditing && (
          <>
            <textarea
              value={activeWorldDraft}
              onChange={(e) =>
                worldSubTab === 'foundation'
                  ? setFoundationDraft(e.target.value)
                  : setInitialSituationDraft(e.target.value)
              }
              placeholder={
                worldSubTab === 'foundation'
                  ? '魔法法則・地理・文化・宇宙観など、物語進行で変わらない土台。ここに書いた内容は物語が進んでも古びない前提で扱われる'
                  : '勢力関係・人物の所属や所在・季節・直近の出来事など、物語進行で変わりうる開始時点の状況。本文が進むと古くなりやすい'
              }
              rows={12}
            />
            <div className="summary-card-actions">
              <button onClick={() => handleCancelWorldArea(worldSubTab)} disabled={loading}>
                キャンセル
              </button>
              <button
                className="primary"
                onClick={() => handleSaveWorldArea(worldSubTab)}
                disabled={loading}
              >
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
          {!charactersEditing && (
            <CardEditButton
              onClick={() => {
                setCharactersDraft(characters);
                setCharactersEditing(true);
              }}
            />
          )}
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
                        {(c.aliases?.length || c.traits?.length || c.secrets || c.currentState) && (
                          <div>
                            <dt>詳細</dt>
                            <dd>
                              <span className="summary-prewrap-inline">
                                {[
                                  c.aliases?.length ? `呼び名: ${c.aliases.join(' / ')}` : '',
                                  ...(c.traits ?? []).map((trait) => `${trait.label}: ${trait.text}`),
                                  c.secrets ? `見せない面: ${c.secrets}` : '',
                                  c.currentState ? `${initialStateLabel}: ${c.currentState}` : '',
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
                    value={c.secrets || ''}
                    onChange={(e) => updateCharacterDraft(i, { secrets: e.target.value })}
                    placeholder="見せない面（秘密、建前、外では見せない一面など）"
                  />
                  <CharacterTraitsEditor
                    idPrefix={`work-character-${c.characterId}`}
                    value={c.traits ?? []}
                    onChange={(traits) => updateCharacterDraft(i, { traits })}
                    disabled={loading}
                  />
                  <label className="character-initial-state-field">
                    {initialStateLabel}
                    <textarea
                      value={c.currentState || ''}
                      onChange={(e) => updateCharacterDraft(i, { currentState: e.target.value })}
                      placeholder="進行中の現在状態は「物語の状態」側で管理される"
                    />
                  </label>
                  {/* NOTE: ロールプレイモード用フィールド。novel でも保存可能で、
                      用途変更（Phase 2 の相互昇格）に備えて情報を残す。 */}
                  <textarea
                    value={c.greeting || ''}
                    onChange={(e) => updateCharacterDraft(i, { greeting: e.target.value })}
                    placeholder="ロールプレイ用：会話開始時の挨拶（1〜3文、最大500字）"
                    maxLength={500}
                  />
                  <textarea
                    value={(c.dialogueExamples ?? []).join('\n')}
                    onChange={(e) =>
                      updateCharacterDraft(i, {
                        dialogueExamples: e.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line.length > 0)
                          .slice(0, 5),
                      })
                    }
                    placeholder="ロールプレイ用：口調のセリフ例（1行1件、最大5件、各200字）"
                    rows={3}
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
          {storyState && !storyStateEditing && (
            <CardEditButton
              onClick={() => {
                setStoryStateDraft(JSON.stringify(storyState, null, 2));
                setStoryStateEditing(true);
              }}
              label="JSON編集"
            />
          )}
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
          </>
        )}
        {storyStateEditing && (
          <>
            <div className="warning-banner" role="alert">
              <strong>⚠ JSON生編集モード</strong>
              <p>
                これは物語状態の生データを直接編集する画面です。構造を壊すと保存できず、
                項目を消すと差分履歴からしか復元できません。編集は必要最小限にしてください。
              </p>
            </div>
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

// NOTE: 各カードのヘッダー右上に置く「編集」ボタン。summary-card-badges の隣に並ぶ。
// カード末尾の目立たない編集ボタンを廃止して、視線の起点であるヘッダーに集約する。
function CardEditButton({
  onClick,
  disabled,
  label = '編集',
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button type="button" className="summary-card-edit" onClick={onClick} disabled={disabled}>
      ✎ {label}
    </button>
  );
}

// NOTE: 物語状態の主要な active 配列について、before → after で「減った件数」を
// ラベル付きで列挙する。increase / no-change は返さない。JSON 生編集時の事故予防
// ダイアログで、何が失われるかをユーザーに具体的に見せるために使う。
function summarizeStoryStateReduction(before: StoryState, after: StoryState): string[] {
  const activeCount = <T extends { status?: string }>(items: T[] | undefined): number =>
    (items ?? []).filter((item) => (item.status ?? 'active') !== 'archived').length;

  const rows: Array<{ label: string; before: number; after: number }> = [
    { label: '現在の状況', before: (before.currentSituation ?? []).length, after: (after.currentSituation ?? []).length },
    { label: '重要イベント', before: activeCount(before.importantEvents), after: activeCount(after.importantEvents) },
    { label: '未解決の糸', before: activeCount(before.openThreads), after: activeCount(after.openThreads) },
    { label: '未確定事項', before: activeCount(before.authorUndecided), after: activeCount(after.authorUndecided) },
    { label: 'キャラ状態', before: (before.characterStates ?? []).length, after: (after.characterStates ?? []).length },
  ];

  return rows
    .filter((row) => row.after < row.before)
    .map((row) => `${row.label}: ${row.before}件 → ${row.after}件（-${row.before - row.after}件）`);
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
    const selected = activePresetIds[categoryKey];
    const presetIds = Array.isArray(selected) ? selected : selected ? [selected] : [];
    for (const presetId of presetIds) {
      const item = Object.values(category.items).find((it) => it.id === presetId);
      if (item) tags.push(item.label);
    }
  }
  return tags;
}

function clearRemovedPresetValues(
  current: Project['activePresetIds'],
  next: Project['activePresetIds']
): Partial<Project['activePresetIds']> {
  const cleared: Record<string, string | string[]> = {};
  if (current.aftertaste && !next.aftertaste) cleared.aftertaste = [];
  for (const key of [
    'emotionDisplay',
    'sceneProgression',
    'chapterEnding',
    'painLevel',
    'intimacy',
  ] as const) {
    if (current[key] && !next[key]) cleared[key] = '';
  }
  return cleared as Partial<Project['activePresetIds']>;
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

function buildRefineNudgeMessage(status: RefineReviewStatus): string {
  if (status.reasons.includes('settings_changed')) {
    return '設定が前回のレビューから変更されています。設定と物語の整合性を確認しますか？';
  }
  if (status.reasons.includes('story_state_edited')) {
    return '物語の状態が手動で変更されています。設定と現状のずれを確認しますか？';
  }
  if (status.reasons.includes('history_truncated')) {
    return '前回のレビュー時点の履歴が保持上限を超えています。設定と現状のずれを確認しますか？';
  }
  return '前回のレビューから本文が進んでいます。設定と現状のずれを確認しますか？';
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
