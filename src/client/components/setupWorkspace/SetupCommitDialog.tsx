import { GeneratingLabel } from '../GeneratingLabel';
import { ROLE_LABELS } from './draftChanges';
import type { CharacterRole, SetupCommitPlan } from '@shared/types';

interface Props {
  plan: SetupCommitPlan;
  error: string | null;
  committing: boolean;
  onPlanChange: (update: (current: SetupCommitPlan) => SetupCommitPlan) => void;
  onClose: () => void;
  onConfirm: () => void;
}

// NOTE: 作品化 API と revision 管理は SetupWorkspace に残し、ここは確認内容を編集する
// controlled UI に限定する。背景の inert とフォーカス復帰も親が一元管理する。
export default function SetupCommitDialog({
  plan,
  error,
  committing,
  onPlanChange,
  onClose,
  onConfirm,
}: Props) {
  return (
    <div className="setup-modal-backdrop">
      <section
        className="setup-commit-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-commit-title"
      >
        <header>
          <h2 id="setup-commit-title">作品にする内容を確認</h2>
          <p>タイトル、作品の核、人物、第1話の入り方を確認してください。作成後も作品設定から変更できます。</p>
        </header>
        {error && <div className="error-toast" role="alert">{error}</div>}
        <label>
          作品タイトル
          <input
            autoFocus
            value={plan.project.title}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                project: { ...current.project, title: event.target.value },
              }))
            }
            maxLength={100}
          />
        </label>
        <label>
          作品の核
          <textarea
            value={plan.coreConcept ?? ''}
            onChange={(event) =>
              onPlanChange((current) => ({ ...current, coreConcept: event.target.value }))
            }
            rows={3}
          />
        </label>
        <label>
          世界の土台
          <textarea
            value={plan.world.foundation}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                world: { ...current.world, foundation: event.target.value },
              }))
            }
            rows={4}
            placeholder="物語進行で変わらない法則・地理・文化など"
          />
        </label>
        <label>
          開始時点の状況
          <textarea
            value={plan.world.initialSituation}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                world: { ...current.world, initialSituation: event.target.value },
              }))
            }
            rows={4}
            placeholder="勢力関係・季節・直近の出来事など、進行で変わりうる状況"
          />
        </label>
        <label>
          第1話冒頭への希望
          <textarea
            value={plan.firstWishSuggestion ?? ''}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                firstWishSuggestion: event.target.value,
              }))
            }
            rows={3}
            maxLength={300}
          />
          <span className="settings-help">作品化後、Readerの第1話への希望として入ります。</span>
        </label>
        <div>
          <h3>人物</h3>
          {plan.characters.length === 0 ? (
            <p className="setup-draft-placeholder">人物はまだ設定されていません。</p>
          ) : (
            <ul className="setup-commit-edit-list">
              {plan.characters.map((character, index) => (
                <li className="setup-commit-edit-row" key={character.characterId}>
                  <input
                    aria-label={`人物${index + 1}の名前`}
                    value={character.name}
                    placeholder={`人物${index + 1}の名前`}
                    onChange={(event) =>
                      onPlanChange((current) => ({
                        ...current,
                        characters: current.characters.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, name: event.target.value } : item
                        ),
                      }))
                    }
                  />
                  <select
                    aria-label={`人物${index + 1}の役割`}
                    value={character.role}
                    onChange={(event) =>
                      onPlanChange((current) => ({
                        ...current,
                        characters: current.characters.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, role: event.target.value as CharacterRole }
                            : item
                        ),
                      }))
                    }
                  >
                    {Object.entries(ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="setup-commit-row-actions">
          <button type="button" onClick={onClose} disabled={committing}>
            相談に戻る
          </button>
          <button
            type="button"
            className="primary"
            onClick={onConfirm}
            disabled={committing || !plan.project.title.trim()}
          >
            {committing ? <GeneratingLabel text="作品を保存中..." /> : 'この内容で作品を作る'}
          </button>
        </div>
      </section>
    </div>
  );
}
