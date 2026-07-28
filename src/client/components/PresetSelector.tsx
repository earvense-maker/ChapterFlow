import type { ActivePresets } from '@shared/types';

export type PresetCategory = {
  label: string;
  items: Record<string, { id: string; label: string; text: string }>;
};

export type PresetSelectorMode = 'novel' | 'roleplay';

interface Props {
  categories: Record<string, PresetCategory>;
  value: ActivePresets;
  onChange: (value: ActivePresets) => void;
  disabled?: boolean;
  namePrefix?: string;
  // NOTE: 小説とロールプレイでカテゴリ群も語彙も別。既定は小説（既存呼び出しの後方互換）。
  mode?: PresetSelectorMode;
}

type SingleKey = Exclude<keyof ActivePresets, 'aftertaste' | 'rpMood'>;
type MultiKey = Extract<keyof ActivePresets, 'aftertaste' | 'rpMood'>;

interface ModeConfig {
  groups: ReadonlyArray<{ label: string; keys: readonly (keyof ActivePresets)[] }>;
  // NOTE: 「指定しない」を出さない必須カテゴリ。未選択だと出力の形が定まらないもの。
  requiredKey: keyof ActivePresets;
  // NOTE: 複数選択（最大2件）のカテゴリ。
  multiKey: MultiKey;
}

const MODE_CONFIG: Record<PresetSelectorMode, ModeConfig> = {
  novel: {
    groups: [
      { label: '境界設定', keys: ['painLevel', 'intimacy'] },
      { label: '語りと構成', keys: ['narration', 'sceneProgression', 'chapterEnding'] },
      { label: '読み味', keys: ['aftertaste', 'emotionDisplay'] },
    ],
    requiredKey: 'narration',
    multiKey: 'aftertaste',
  },
  roleplay: {
    groups: [
      { label: '境界設定', keys: ['rpPainLevel', 'rpIntimacy'] },
      { label: '応答のつくり', keys: ['rpResponseStyle', 'rpInitiative'] },
      { label: '関係と空気', keys: ['rpDistance', 'rpMood', 'rpEmotionDisplay'] },
    ],
    requiredKey: 'rpResponseStyle',
    multiKey: 'rpMood',
  },
};

const descriptions: Partial<Record<keyof ActivePresets, string>> = {
  intimacy:
    '性的な場面をどう扱うかを選びます。指定しない場合、プロンプトには何も追加されません。',
  painLevel:
    '登場人物にどこまで辛いことが起きてよいかを選びます。安心して読みたいか、容赦ない展開を望むかの契約です。',
  rpIntimacy:
    '性的な場面をどう扱うかを選びます。指定しない場合、プロンプトには何も追加されません。',
  rpPainLevel:
    '会話がどこまで痛いところへ踏み込んでよいかを選びます。安心して話したいか、突き放されてもよいかの契約です。',
  rpResponseStyle:
    'キャラクターの応答をどう組み立てるかを選びます。ここだけは必ずどれか1つが適用されます。',
  rpMood: '会話に通す空気を最大2つまで選べます。',
};

export default function PresetSelector({
  categories,
  value,
  onChange,
  disabled = false,
  namePrefix = 'preset',
  mode = 'novel',
}: Props) {
  const config = MODE_CONFIG[mode];

  function selectSingle(key: SingleKey, id?: string) {
    const next = { ...value };
    if (id) next[key] = id;
    else if (key !== config.requiredKey) delete next[key];
    onChange(next);
  }

  function toggleMulti(id: string) {
    const current = value[config.multiKey] ?? [];
    const nextIds = current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id].slice(0, 2);
    const next = { ...value };
    if (nextIds.length > 0) next[config.multiKey] = nextIds;
    else delete next[config.multiKey];
    onChange(next);
  }

  return (
    <div className="preset-selector">
      {config.groups.map((group) => (
        <section key={group.label} className="preset-selector-group">
          <h3>{group.label}</h3>
          {group.keys.map((key) => {
            const category = categories[key];
            if (!category) return null;
            const items = Object.values(category.items);
            const isMulti = key === config.multiKey;
            const selectedMulti = value[config.multiKey] ?? [];
            return (
              <fieldset key={key}>
                <legend>{category.label}</legend>
                {descriptions[key] && <p className="settings-help">{descriptions[key]}</p>}
                <div className="preset-options">
                  {key !== config.requiredKey && !isMulti && (
                    <label className="preset-option">
                      <input
                        type="radio"
                        name={`${namePrefix}-${key}`}
                        checked={!value[key]}
                        disabled={disabled}
                        onChange={() => selectSingle(key as SingleKey, undefined)}
                      />
                      <span><strong>指定しない</strong></span>
                    </label>
                  )}
                  {items.map((item) => {
                    const checked = isMulti
                      ? selectedMulti.includes(item.id)
                      : value[key] === item.id;
                    return (
                      <label key={item.id} className="preset-option">
                        <input
                          type={isMulti ? 'checkbox' : 'radio'}
                          name={`${namePrefix}-${key}`}
                          value={item.id}
                          checked={checked}
                          disabled={
                            disabled ||
                            (isMulti && selectedMulti.length >= 2 && !checked)
                          }
                          onChange={() =>
                            isMulti ? toggleMulti(item.id) : selectSingle(key as SingleKey, item.id)
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
