import { useState } from 'react';
import type { NgExpression } from '@shared/types';

interface Props {
  expressions: NgExpression[];
  disabled: boolean;
  onArchive: (expressionId: string) => void;
  onUpdateAlternatives: (expressionId: string, alternatives: string[]) => void;
  emptyMessage: string;
}

const SEPARATOR = '／';

// NOTE: 代替案は「禁止」を「置き換え」に変えるためのもの。書き換え時にモデルへ渡す
// 着地先で、無くても動くが、あると一度で通りやすい。編集は blur で保存する（入力の
// たびに PATCH すると 1 文字ごとに書き込みが走るため）。
export default function NgExpressionList({
  expressions,
  disabled,
  onArchive,
  onUpdateAlternatives,
  emptyMessage,
}: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (expressions.length === 0) {
    return <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{emptyMessage}</p>;
  }

  function commit(expression: NgExpression) {
    const draft = drafts[expression.id];
    if (draft === undefined) return;
    const next = parseAlternatives(draft);
    setDrafts((prev) => {
      const rest = { ...prev };
      delete rest[expression.id];
      return rest;
    });
    if (sameAlternatives(next, expression.alternatives ?? [])) return;
    onUpdateAlternatives(expression.id, next);
  }

  return (
    <ul className="ng-expression-list">
      {expressions.map((expression) => (
        <li key={expression.id} className="ng-expression-item">
          <div className="ng-expression-main">
            <span>「{expression.text}」</span>
            <button
              className="danger"
              onClick={() => onArchive(expression.id)}
              disabled={disabled}
            >
              削除
            </button>
          </div>
          <label className="ng-expression-alternatives">
            <span>代わりに使う表現（任意・{SEPARATOR}区切りで3件まで）</span>
            <input
              type="text"
              value={drafts[expression.id] ?? (expression.alternatives ?? []).join(SEPARATOR)}
              placeholder={`例：視線が泳ぐ${SEPARATOR}目を伏せる`}
              disabled={disabled}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [expression.id]: event.target.value }))
              }
              onBlur={() => commit(expression)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                event.currentTarget.blur();
              }}
            />
          </label>
        </li>
      ))}
    </ul>
  );
}

function parseAlternatives(value: string): string[] {
  return value
    .split(/[／/、,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function sameAlternatives(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}
