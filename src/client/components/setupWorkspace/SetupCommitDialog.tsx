import { useState } from 'react';

import { GeneratingLabel } from '../GeneratingLabel';
import { ROLE_LABELS } from './draftChanges';
import { DEFAULT_ROLEPLAY_USER_ACTION_POLICY } from '@shared/roleplayPersona';
import { USER_PERSONA_FIELDS } from './userPersonaFields';
import type { CharacterRole, SetupCommitPlan } from '@shared/types';

interface Props {
  plan: SetupCommitPlan;
  purpose: 'novel' | 'roleplay';
  error: string | null;
  committing: boolean;
  onPlanChange: (update: (current: SetupCommitPlan) => SetupCommitPlan) => void;
  onClose: () => void;
  onConfirm: () => void;
}

interface CommitDialogCopy {
  description: string;
  coreConcept: string;
  foundation: string;
  foundationHint: string;
  initialSituation: string;
  initialSituationHint: string;
  characters: string;
  charactersEmpty: string;
  confirm: string;
}

const DIALOG_COPY: Record<'novel' | 'roleplay', CommitDialogCopy> = {
  novel: {
    description:
      'タイトル、作品の核、人物、第1話の入り方を確認してください。作成後も作品設定から変更できます。',
    coreConcept: '作品の核',
    foundation: '世界の土台',
    foundationHint: '物語進行で変わらない法則・地理・文化など',
    initialSituation: '開始時点の状況',
    initialSituationHint: '勢力関係・季節・直近の出来事など、進行で変わりうる状況',
    characters: '人物',
    charactersEmpty: '人物はまだ設定されていません。',
    confirm: 'この内容で作品を作る',
  },
  roleplay: {
    description:
      'タイトル、キャラクターの核、初回メッセージを確認してください。作成後も作品設定から変更できます。',
    coreConcept: 'キャラクターの核',
    foundation: '会話の背景',
    foundationHint: '会話の前提として変わらない世界観や時代感',
    initialSituation: '会話開始時点の状況',
    initialSituationHint: '場面・時間帯・直前の出来事・現在の立場など',
    characters: 'キャラクター',
    charactersEmpty: 'キャラクターはまだ設定されていません。',
    confirm: 'このキャラと話し始める',
  },
};

const MAX_DIALOGUE_EXAMPLES = 5;

// NOTE: 作品化 API と revision 管理は SetupWorkspace に残し、ここは確認内容を編集する
// controlled UI に限定する。背景の inert とフォーカス復帰も親が一元管理する。
export default function SetupCommitDialog({
  plan,
  purpose,
  error,
  committing,
  onPlanChange,
  onClose,
  onConfirm,
}: Props) {
  const copy = DIALOG_COPY[purpose];
  // NOTE: セリフ例は「1行1件の配列」だが、編集中は改行や空行を保ちたいので生テキストを
  // ローカルに持ち、plan には行分割した配列を書き戻す（draftEditors と同じ扱い）。
  // characterId はモデル出力由来で重複しうるので、キーには行インデックスを使う。
  const [dialogueDrafts, setDialogueDrafts] = useState<Record<number, string>>({});
  const dialogueText = (index: number, examples: string[] | undefined) =>
    dialogueDrafts[index] ?? (examples ?? []).join('\n');
  // NOTE: 会話開始時の相手はどのキャラでも選べるので、1体でも greeting が空なら知らせる。
  const missingGreeting =
    purpose === 'roleplay' && plan.characters.some((character) => !character.greeting?.trim());

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
          <p>{copy.description}</p>
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
          {copy.coreConcept}
          <textarea
            value={plan.coreConcept ?? ''}
            onChange={(event) =>
              onPlanChange((current) => ({ ...current, coreConcept: event.target.value }))
            }
            rows={3}
          />
        </label>
        <label>
          {copy.foundation}
          <textarea
            value={plan.world.foundation}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                world: { ...current.world, foundation: event.target.value },
              }))
            }
            rows={4}
            placeholder={copy.foundationHint}
          />
        </label>
        <label>
          {copy.initialSituation}
          <textarea
            value={plan.world.initialSituation}
            onChange={(event) =>
              onPlanChange((current) => ({
                ...current,
                world: { ...current.world, initialSituation: event.target.value },
              }))
            }
            rows={4}
            placeholder={copy.initialSituationHint}
          />
        </label>
        {/* NOTE: firstWishSuggestion は novel 専用。roleplay ではサーバー側が必ず空にするため
            （setupCommitService）、欄を出すと入力しても捨てられる。設計書 1.5 のとおり隠す。 */}
        {purpose === 'novel' && (
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
        )}
        <div>
          <h3>{copy.characters}</h3>
          {missingGreeting && (
            <p className="settings-help" role="status">
              初回メッセージが空のキャラクターがいます。そのキャラクターを選ぶと、相手から話しかけずに会話が始まります。
            </p>
          )}
          {plan.characters.length === 0 ? (
            <p className="setup-draft-placeholder">{copy.charactersEmpty}</p>
          ) : (
            <ul className="setup-commit-edit-list">
              {plan.characters.map((character, index) => (
                // NOTE: characterId はモデル出力そのままなので重複しうる。index を混ぜて衝突を防ぐ。
                <li className="setup-commit-edit-row" key={`${character.characterId}-${index}`}>
                  <input
                    aria-label={`${copy.characters}${index + 1}の名前`}
                    value={character.name}
                    placeholder={`${copy.characters}${index + 1}の名前`}
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
                    aria-label={`${copy.characters}${index + 1}の役割`}
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
                  {/* NOTE: roleplay の体験を決めるのは初回メッセージと口調の few-shot なので、
                      作品化前に必ず目を通せるようここで確認・編集できるようにする。 */}
                  {purpose === 'roleplay' && (
                    <>
                      <textarea
                        aria-label={`${copy.characters}${index + 1}の初回メッセージ`}
                        value={character.greeting ?? ''}
                        placeholder="会話開始時にキャラクターから発する1〜3文の挨拶"
                        rows={2}
                        maxLength={500}
                        onChange={(event) =>
                          onPlanChange((current) => ({
                            ...current,
                            characters: current.characters.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, greeting: event.target.value } : item
                            ),
                          }))
                        }
                      />
                      <textarea
                        aria-label={`${copy.characters}${index + 1}のセリフ例`}
                        value={dialogueText(index, character.dialogueExamples)}
                        placeholder={`口調のセリフ例（1行1件、最大${MAX_DIALOGUE_EXAMPLES}件）`}
                        rows={3}
                        onChange={(event) => {
                          const text = event.target.value;
                          setDialogueDrafts((current) => ({ ...current, [index]: text }));
                          const examples = text
                            .split('\n')
                            .map((line) => line.trim())
                            .filter((line) => line.length > 0)
                            .slice(0, MAX_DIALOGUE_EXAMPLES);
                          onPlanChange((current) => ({
                            ...current,
                            characters: current.characters.map((item, itemIndex) =>
                              itemIndex === index
                                ? {
                                    ...item,
                                    dialogueExamples: examples.length > 0 ? examples : undefined,
                                  }
                                : item
                            ),
                          }));
                        }}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {/* NOTE: 相談で決めた「あなた」は作品の既定ペルソナとして保存され、新しい会話の
            初期値になる。会話ごとに変えられるので、ここでは人物像だけを確認する。 */}
        {purpose === 'roleplay' && (
          <div>
            <h3>あなた（ユーザー）</h3>
            <p className="settings-help">
              会話であなたが誰として話すか。新しい会話を始めるときの初期値になります。作成後も作品設定から変更できます。
            </p>
            {/* NOTE: 同じダイアログにキャラの「名前」欄も並ぶので、ラベルを「あなた・」で
                区別する（読み上げでもどちらの名前か分かるようにする）。 */}
            {USER_PERSONA_FIELDS.map((field) => (
              <label key={field.key}>
                あなた・{field.label}
                <textarea
                  value={plan.defaultUserPersona?.[field.key] ?? ''}
                  placeholder={field.placeholder}
                  maxLength={field.maxLength}
                  rows={field.rows ?? 1}
                  onChange={(event) =>
                    onPlanChange((current) => ({
                      ...current,
                      defaultUserPersona: {
                        actionPolicy:
                          current.defaultUserPersona?.actionPolicy ??
                          DEFAULT_ROLEPLAY_USER_ACTION_POLICY,
                        ...current.defaultUserPersona,
                        [field.key]: event.target.value,
                      },
                    }))
                  }
                />
              </label>
            ))}
          </div>
        )}
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
            {committing ? <GeneratingLabel text="作品を保存中..." /> : copy.confirm}
          </button>
        </div>
      </section>
    </div>
  );
}
