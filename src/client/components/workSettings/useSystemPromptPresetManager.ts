import { useState } from 'react';
import { api } from '../../clientApi';
import type { useConfirm } from '../ConfirmDialog';
import type { SystemPromptPreset } from '@shared/types';

interface Deps {
  systemPromptDraft: string;
  savedSystemPrompt: string;
  onSystemPromptDraftChange: (value: string) => void;
  onError: (message: string | null) => void;
  onFlashMessage: (message: string) => void;
  confirmAction: ReturnType<typeof useConfirm>;
}

// NOTE: 全作品共通のシステムプロンプトプリセット CRUD だけを独立させる。
// 作品への保存と preview 再計算は project presets を持つ WorkSettingsTab に残す。
export function useSystemPromptPresetManager({
  systemPromptDraft,
  savedSystemPrompt,
  onSystemPromptDraftChange,
  onError,
  onFlashMessage,
  confirmAction,
}: Deps) {
  const [systemPromptPresets, setSystemPromptPresets] = useState<SystemPromptPreset[]>([]);
  const [selectedSystemPromptPresetId, setSelectedSystemPromptPresetId] = useState('');
  const [systemPromptPresetNameDraft, setSystemPromptPresetNameDraft] = useState('');
  const [systemPromptPresetLoading, setSystemPromptPresetLoading] = useState(false);
  const [systemPromptPresetLoadError, setSystemPromptPresetLoadError] = useState<string | null>(null);

  function handleSelectSystemPromptPreset(id: string) {
    const preset = systemPromptPresets.find((item) => item.id === id);
    setSelectedSystemPromptPresetId(id);
    setSystemPromptPresetNameDraft(preset?.name ?? '');
  }

  async function handleLoadSystemPromptPreset() {
    const preset = systemPromptPresets.find((item) => item.id === selectedSystemPromptPresetId);
    if (!preset) return;
    if (
      systemPromptDraft !== savedSystemPrompt &&
      systemPromptDraft !== preset.prompt &&
      !(await confirmAction('未保存の編集内容を、選択したプリセットで置き換えますか？', {
        confirmLabel: '置き換える',
      }))
    ) {
      return;
    }
    onSystemPromptDraftChange(preset.prompt);
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
      // NOTE: 409 競合を含む失敗後は、別画面での更新を反映して次の操作を安全にする。
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

  return {
    systemPromptPresets,
    setSystemPromptPresets,
    selectedSystemPromptPresetId,
    systemPromptPresetNameDraft,
    setSystemPromptPresetNameDraft,
    systemPromptPresetLoading,
    systemPromptPresetLoadError,
    setSystemPromptPresetLoadError,
    handleSelectSystemPromptPreset,
    handleLoadSystemPromptPreset,
    handleReloadSystemPromptPresets,
    handleSaveSystemPromptPreset,
    handleDeleteSystemPromptPreset,
  };
}
