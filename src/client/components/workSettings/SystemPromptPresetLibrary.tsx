import {
  SYSTEM_PROMPT_PRESET_NAME_MAX_CHARS,
  type SystemPromptPreset,
} from '@shared/types';

interface Props {
  presets: SystemPromptPreset[];
  selectedPresetId: string;
  nameDraft: string;
  loading: boolean;
  loadError: string | null;
  parentLoading: boolean;
  hasPromptContent: boolean;
  onSelect: (id: string) => void;
  onNameChange: (value: string) => void;
  onLoad: () => void;
  onReload: () => void;
  onSave: () => void;
  onDelete: () => void;
}

export default function SystemPromptPresetLibrary({
  presets,
  selectedPresetId,
  nameDraft,
  loading,
  loadError,
  parentLoading,
  hasPromptContent,
  onSelect,
  onNameChange,
  onLoad,
  onReload,
  onSave,
  onDelete,
}: Props) {
  const disabled = parentLoading || loading || Boolean(loadError);

  return (
    <div className="system-prompt-preset-library">
      <p className="settings-help">
        追加指示を全作品共通のプリセットとして保存・読み込みできます。読み込み後は、下の「保存」で作品に反映してください。
      </p>
      {loadError && (
        <div className="system-prompt-preset-error">
          <span>プリセット一覧を読み込めませんでした。</span>
          <button type="button" onClick={onReload} disabled={loading}>
            再試行
          </button>
        </div>
      )}
      <div className="system-prompt-preset-row">
        <select
          aria-label="システムプロンプトのプリセット"
          value={selectedPresetId}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">保存済みプリセットを選択</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onLoad}
          disabled={disabled || !selectedPresetId}
        >
          読み込む
        </button>
        <button
          type="button"
          className="danger"
          onClick={onDelete}
          disabled={disabled || !selectedPresetId}
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
          value={nameDraft}
          disabled={disabled}
          onChange={(event) => onNameChange(event.target.value)}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={disabled || !nameDraft.trim() || !hasPromptContent}
        >
          現在の内容をプリセット保存
        </button>
      </div>
    </div>
  );
}
