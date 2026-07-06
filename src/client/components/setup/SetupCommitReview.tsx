import { useMemo, useState } from 'react';
import type {
  Character,
  CharacterRole,
  Memory,
  MemoryImportance,
  MemoryType,
  SetupCommitPlan,
  StoryThreadRecord,
} from '@shared/types';

interface Props {
  plan: SetupCommitPlan;
  disabled?: boolean;
  onCommit: (plan: SetupCommitPlan) => void;
  onBack: () => void;
  onRecreate: () => void;
}

const ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主人公',
  deuteragonist: '相手役',
  supporting: '脇役',
  other: 'その他',
};

const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  storyFact: '事実',
  preference: '好み',
  negative: 'NG',
};

const MEMORY_IMPORTANCE_LABELS: Record<MemoryImportance, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

export default function SetupCommitReview({
  plan,
  disabled,
  onCommit,
  onBack,
  onRecreate,
}: Props) {
  const [edited, setEdited] = useState<SetupCommitPlan>(() => structuredClone(plan));
  const [situationDraft, setSituationDraft] = useState('');
  const [memoryDraft, setMemoryDraft] = useState<{
    type: MemoryType;
    importance: MemoryImportance;
    content: string;
  }>({ type: 'preference', importance: 'medium', content: '' });

  const changed = useMemo(() => !deepEqual(plan, edited), [plan, edited]);

  function updateProject(partial: Partial<SetupCommitPlan['project']>) {
    setEdited((current) => ({
      ...current,
      project: { ...current.project, ...partial },
    }));
  }

  function updateCharacter(index: number, partial: Partial<Character>) {
    setEdited((current) => {
      const characters = [...current.characters];
      characters[index] = { ...characters[index], ...partial } as Character;
      return { ...current, characters };
    });
  }

  function addCharacter() {
    setEdited((current) => ({
      ...current,
      characters: [
        ...current.characters,
        {
          characterId: `char-new-${Date.now()}`,
          name: '',
          role: 'supporting',
          description: '',
        },
      ],
    }));
  }

  function removeCharacter(index: number) {
    setEdited((current) => ({
      ...current,
      characters: current.characters.filter((_, i) => i !== index),
    }));
  }

  function updateMemory(index: number, partial: Partial<Memory>) {
    setEdited((current) => {
      const memories = [...current.memories];
      memories[index] = { ...memories[index], ...partial } as Memory;
      return { ...current, memories };
    });
  }

  function addMemory() {
    if (!memoryDraft.content.trim()) return;
    setEdited((current) => ({
      ...current,
      memories: [
        ...current.memories,
        {
          memoryId: `mem-new-${Date.now()}`,
          type: memoryDraft.type,
          content: memoryDraft.content.trim(),
          importance: memoryDraft.importance,
          relatedCharacters: [],
          relatedEpisodes: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sourceSceneId: null,
          status: 'active',
          source: 'manual',
        } satisfies Memory,
      ],
    }));
    setMemoryDraft({ type: 'preference', importance: 'medium', content: '' });
  }

  function removeMemory(index: number) {
    setEdited((current) => ({
      ...current,
      memories: current.memories.filter((_, i) => i !== index),
    }));
  }

  function addSituation() {
    const text = situationDraft.trim();
    if (!text) return;
    setEdited((current) => ({
      ...current,
      storyState: {
        ...current.storyState,
        currentSituation: [...current.storyState.currentSituation, text],
      },
    }));
    setSituationDraft('');
  }

  function updateSituation(index: number, value: string) {
    setEdited((current) => ({
      ...current,
      storyState: {
        ...current.storyState,
        currentSituation: current.storyState.currentSituation.map((item, i) =>
          i === index ? value : item
        ),
      },
    }));
  }

  function removeSituation(index: number) {
    setEdited((current) => ({
      ...current,
      storyState: {
        ...current.storyState,
        currentSituation: current.storyState.currentSituation.filter((_, i) => i !== index),
      },
    }));
  }

  function updateThread(index: number, partial: Partial<StoryThreadRecord>) {
    setEdited((current) => {
      const openThreads = [...current.storyState.openThreads];
      openThreads[index] = { ...openThreads[index], ...partial } as StoryThreadRecord;
      return {
        ...current,
        storyState: { ...current.storyState, openThreads },
      };
    });
  }

  function removeThread(index: number) {
    setEdited((current) => ({
      ...current,
      storyState: {
        ...current.storyState,
        openThreads: current.storyState.openThreads.filter((_, i) => i !== index),
      },
    }));
  }

  return (
    <div className="setup-commit-review">
      <header className="setup-commit-review-header">
        <h2>作品化前の確認</h2>
        <p>AIがまとめた内容を確認・修正してから作成してください。</p>
      </header>

      <section className="setup-commit-section">
        <h3>タイトル</h3>
        <input
          type="text"
          value={edited.project.title}
          onChange={(e) => updateProject({ title: e.target.value })}
          disabled={disabled}
        />
      </section>

      <section className="setup-commit-section">
        <h3>世界観・作品の核</h3>
        <textarea
          className="setup-commit-textarea"
          value={edited.worldText}
          onChange={(e) => setEdited((current) => ({ ...current, worldText: e.target.value }))}
          disabled={disabled}
        />
      </section>

      <section className="setup-commit-section">
        <h3>人物</h3>
        <ul className="setup-commit-edit-list">
          {edited.characters.map((character, index) => (
            <li key={character.characterId ?? index} className="setup-commit-edit-row">
              <div className="setup-commit-character-grid">
                <select
                  value={character.role}
                  onChange={(e) =>
                    updateCharacter(index, { role: e.target.value as CharacterRole })
                  }
                  disabled={disabled}
                >
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={character.name}
                  onChange={(e) => updateCharacter(index, { name: e.target.value })}
                  placeholder="名前"
                  disabled={disabled}
                />
              </div>
              <textarea
                className="setup-commit-textarea compact"
                value={character.description}
                onChange={(e) => updateCharacter(index, { description: e.target.value })}
                placeholder="説明"
                disabled={disabled}
              />
              <textarea
                className="setup-commit-textarea compact"
                value={character.speechStyle ?? ''}
                onChange={(e) => updateCharacter(index, { speechStyle: e.target.value })}
                placeholder="口調"
                disabled={disabled}
              />
              <textarea
                className="setup-commit-textarea compact"
                value={character.relationshipNotes ?? ''}
                onChange={(e) => updateCharacter(index, { relationshipNotes: e.target.value })}
                placeholder="関係性"
                disabled={disabled}
              />
              <div className="setup-commit-row-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => removeCharacter(index)}
                  disabled={disabled}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
        <button type="button" onClick={addCharacter} disabled={disabled}>
          +人物を追加
        </button>
      </section>

      <section className="setup-commit-section">
        <h3>メモリ（生成時に守る情報）</h3>
        <ul className="setup-commit-edit-list">
          {edited.memories.map((memory, index) => (
            <li key={memory.memoryId ?? index} className="setup-commit-edit-row">
              <div className="setup-commit-memory-grid">
                <select
                  value={memory.type}
                  onChange={(e) =>
                    updateMemory(index, { type: e.target.value as MemoryType })
                  }
                  disabled={disabled}
                >
                  {Object.entries(MEMORY_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  value={memory.importance}
                  onChange={(e) =>
                    updateMemory(index, { importance: e.target.value as MemoryImportance })
                  }
                  disabled={disabled}
                >
                  {Object.entries(MEMORY_IMPORTANCE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <textarea
                className="setup-commit-textarea compact"
                value={memory.content}
                onChange={(e) => updateMemory(index, { content: e.target.value })}
                disabled={disabled}
              />
              <div className="setup-commit-row-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => removeMemory(index)}
                  disabled={disabled}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="setup-commit-add-memory">
          <select
            value={memoryDraft.type}
            onChange={(e) =>
              setMemoryDraft((current) => ({ ...current, type: e.target.value as MemoryType }))
            }
            disabled={disabled}
          >
            {Object.entries(MEMORY_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={memoryDraft.importance}
            onChange={(e) =>
              setMemoryDraft((current) => ({
                ...current,
                importance: e.target.value as MemoryImportance,
              }))
            }
            disabled={disabled}
          >
            {Object.entries(MEMORY_IMPORTANCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <textarea
            className="setup-commit-textarea compact"
            value={memoryDraft.content}
            onChange={(e) =>
              setMemoryDraft((current) => ({ ...current, content: e.target.value }))
            }
            placeholder="追加するメモリの内容"
            disabled={disabled}
          />
          <button type="button" onClick={addMemory} disabled={disabled || !memoryDraft.content.trim()}>
            +追加
          </button>
        </div>
      </section>

      <section className="setup-commit-section">
        <h3>開始時の状況</h3>
        <ul className="setup-commit-edit-list">
          {edited.storyState.currentSituation.map((item, index) => (
            <li key={index} className="setup-commit-edit-row">
              <textarea
                className="setup-commit-textarea compact"
                value={item}
                onChange={(e) => updateSituation(index, e.target.value)}
                disabled={disabled}
              />
              <div className="setup-commit-row-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => removeSituation(index)}
                  disabled={disabled}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="setup-commit-add-situation">
          <textarea
            className="setup-commit-textarea compact"
            value={situationDraft}
            onChange={(e) => setSituationDraft(e.target.value)}
            placeholder="追加する状況"
            disabled={disabled}
          />
          <button type="button" onClick={addSituation} disabled={disabled || !situationDraft.trim()}>
            +追加
          </button>
        </div>
      </section>

      <section className="setup-commit-section">
        <h3>未解決の糸口</h3>
        <ul className="setup-commit-edit-list">
          {edited.storyState.openThreads.map((thread, index) => (
            <li key={thread.threadId ?? index} className="setup-commit-edit-row">
              <textarea
                className="setup-commit-textarea compact"
                value={thread.summary}
                onChange={(e) => updateThread(index, { summary: e.target.value })}
                disabled={disabled}
              />
              <div className="setup-commit-row-actions">
                <button
                  type="button"
                  className="danger"
                  onClick={() => removeThread(index)}
                  disabled={disabled}
                >
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="setup-commit-section">
        <h3>カスタムシステムプロンプト</h3>
        <textarea
          className="setup-commit-textarea"
          value={edited.customSystemPrompt}
          onChange={(e) =>
            setEdited((current) => ({ ...current, customSystemPrompt: e.target.value }))
          }
          disabled={disabled}
        />
      </section>

      <footer className="setup-commit-review-footer">
        <button type="button" onClick={onBack} disabled={disabled}>
          相談に戻る
        </button>
        <button type="button" onClick={onRecreate} disabled={disabled}>
          作り直す
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => onCommit(edited)}
          disabled={disabled}
        >
          この内容で作成
        </button>
      </footer>

      {changed && (
        <div className="setup-commit-unsaved">内容が編集されています。</div>
      )}
    </div>
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
