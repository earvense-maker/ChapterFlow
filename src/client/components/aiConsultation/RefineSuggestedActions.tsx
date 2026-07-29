import type { RefineSuggestedAction } from '@shared/types';

interface Props {
  actions: RefineSuggestedAction[];
  // NOTE: 過去ターンの候補は履歴表示にする。押せるのは session の末尾 assistant
  // メッセージの候補だけで、その判定は呼び出し側が messages の並びから再現する。
  interactive: boolean;
  disabled: boolean;
  onSelect: (action: RefineSuggestedAction) => void;
}

export default function RefineSuggestedActions({
  actions,
  interactive,
  disabled,
  onSelect,
}: Props) {
  if (actions.length === 0) return null;
  if (!interactive) {
    return (
      <ul className="refine-suggested-actions history" aria-label="このときの相談候補（履歴）">
        {actions.map((action, index) => (
          <li key={`${action.label}-${index}`}>{action.label}</li>
        ))}
      </ul>
    );
  }
  return (
    <div className="refine-suggested-actions" role="group" aria-label="次の相談候補">
      {actions.map((action, index) => (
        <button
          key={`${action.label}-${index}`}
          type="button"
          className={action.responseMode === 'prepare-patch' ? 'primary' : ''}
          disabled={disabled}
          onClick={() => onSelect(action)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
