import type { ActivePresets } from '@shared/types';

export type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

interface Props {
  categories: Record<string, PresetCategory>;
  value: ActivePresets;
  onChange: (value: ActivePresets) => void;
  disabled?: boolean;
  namePrefix?: string;
}

const groups = [
  { label: '境界設定', keys: ['painLevel', 'intimacy'] },
  { label: '語りと構成', keys: ['narration', 'sceneProgression', 'chapterEnding'] },
  { label: '読み味', keys: ['aftertaste', 'emotionDisplay'] },
] as const;

const descriptions: Partial<Record<keyof ActivePresets, string>> = {
  intimacy:
    '性的な場面をどう扱うかを選びます。指定しない場合、プロンプトには何も追加されません。',
  painLevel:
    '登場人物にどこまで辛いことが起きてよいかを選びます。安心して読みたいか、容赦ない展開を望むかの契約です。',
};

export default function PresetSelector({
  categories,
  value,
  onChange,
  disabled = false,
  namePrefix = 'preset',
}: Props) {
  function selectSingle(key: Exclude<keyof ActivePresets, 'aftertaste'>, id?: string) {
    const next = { ...value };
    if (id) next[key] = id;
    else if (key !== 'narration') delete next[key];
    onChange(next);
  }

  function toggleAftertaste(id: string) {
    const current = value.aftertaste ?? [];
    const nextIds = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id].slice(0, 2);
    const next = { ...value };
    if (nextIds.length > 0) next.aftertaste = nextIds;
    else delete next.aftertaste;
    onChange(next);
  }

  return (
    <div className="preset-selector">
      {groups.map((group) => (
        <section key={group.label} className="preset-selector-group">
          <h3>{group.label}</h3>
          {group.keys.map((key) => {
            const category = categories[key];
            if (!category) return null;
            const items = Object.values(category.items);
            const aftertaste = value.aftertaste ?? [];
            return (
              <fieldset key={key}>
                <legend>{category.label}</legend>
                {descriptions[key] && <p className="settings-help">{descriptions[key]}</p>}
                <div className="preset-options">
                  {key !== 'narration' && key !== 'aftertaste' && (
                    <label className="preset-option">
                      <input
                        type="radio"
                        name={`${namePrefix}-${key}`}
                        checked={!value[key]}
                        disabled={disabled}
                        onChange={() => selectSingle(key, undefined)}
                      />
                      <span><strong>指定しない</strong></span>
                    </label>
                  )}
                  {items.map((item) => {
                    const isAftertaste = key === 'aftertaste';
                    const checked = isAftertaste
                      ? aftertaste.includes(item.id)
                      : value[key] === item.id;
                    return (
                      <label key={item.id} className="preset-option">
                        <input
                          type={isAftertaste ? 'checkbox' : 'radio'}
                          name={`${namePrefix}-${key}`}
                          value={item.id}
                          checked={checked}
                          disabled={
                            disabled ||
                            (isAftertaste && aftertaste.length >= 2 && !checked)
                          }
                          onChange={() =>
                            isAftertaste
                              ? toggleAftertaste(item.id)
                              : selectSingle(key, item.id)
                          }
                        />
                        <span>
                          <strong>{item.label}</strong>
                          <span className="preset-option-detail">{item.text}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </section>
      ))}
    </div>
  );
}
