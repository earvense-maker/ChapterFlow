import type { CharacterTrait } from '@shared/types';

interface Props {
  value: CharacterTrait[];
  onChange: (value: CharacterTrait[]) => void;
  disabled?: boolean;
  idPrefix: string;
}

const MAX_TRAITS = 4;

export default function CharacterTraitsEditor({
  value,
  onChange,
  disabled = false,
  idPrefix,
}: Props) {
  const update = (index: number, patch: Partial<CharacterTrait>) => {
    onChange(value.map((trait, i) => (i === index ? { ...trait, ...patch } : trait)));
  };

  return (
    <div className="character-traits-editor">
      <div className="character-traits-heading">
        <span>人物の軸</span>
        <button
          type="button"
          onClick={() => onChange([...value, { label: '', text: '' }])}
          disabled={disabled || value.length >= MAX_TRAITS}
        >
          + 軸を追加
        </button>
      </div>
      <p className="field-hint">例: 望み / 恐れ / こだわり / 意地の張り方 / 動機</p>
      {value.map((trait, index) => {
        const labelId = `${idPrefix}-trait-${index}-label`;
        const textId = `${idPrefix}-trait-${index}-text`;
        return (
          <div className="character-trait-row" key={`${idPrefix}-${index}`}>
            <div className="character-trait-label-field">
              <label htmlFor={labelId}>ラベル</label>
              <input
                id={labelId}
                type="text"
                value={trait.label}
                maxLength={12}
                onChange={(event) => update(index, { label: event.target.value })}
                disabled={disabled}
                placeholder="こだわり"
              />
            </div>
            <div className="character-trait-text-field">
              <label htmlFor={textId}>内容</label>
              <textarea
                id={textId}
                value={trait.text}
                maxLength={200}
                onChange={(event) => update(index, { text: event.target.value })}
                disabled={disabled}
                placeholder="この人物らしい判断や反応の軸"
                rows={2}
              />
            </div>
            <button
              type="button"
              className="danger character-trait-remove"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              disabled={disabled}
              aria-label={`${trait.label.trim() || `${index + 1}番目の軸`}を削除`}
            >
              削除
            </button>
          </div>
        );
      })}
    </div>
  );
}
