// NOTE: SetupWorkspace から相談ドラフト（本文候補・未決事項・キャラクター・文字列
// セクション）の編集用サブコンポーネント群を切り出したモジュール。いずれも props と
// ローカル状態だけで完結する表示コンポーネントで、親の状態には触れない（JS のスコープ上
// 触れられない）ため、移設は挙動を変えない。親が JSX で使う一覧系のみ export する。

import { useEffect, useMemo, useState } from 'react';

import CharacterTraitsEditor from '../CharacterTraitsEditor';

import {
  DRAFT_STRING_SECTION_LABELS,
  draftChangeKindLabel,
  draftItemChangeKey,
  draftStringChangeKey,
  ROLE_LABELS,
  type DraftChangeKind,
  type DraftChanges,
  type StringDraftSection,
} from './draftChanges';

import type {
  CharacterRole,
  CharacterTrait,
  SetupDraft,
  SetupDraftCandidate,
  SetupDraftCharacter,
  SetupDraftTextItem,
  SetupDraftUndecided,
} from '@shared/types';

export interface PendingDescriptor {
  id: string;
}

function DraftChangeBadge({ kind }: { kind: DraftChangeKind }) {
  return <span className="setup-draft-update-badge">{draftChangeKindLabel(kind)}</span>;
}

export function CoreConceptEditor({
  dirtyKey,
  value,
  disabled,
  locked,
  changeKind,
  onDirtyChange,
  onSave,
  onToggleLock,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  locked: boolean;
  changeKind?: DraftChangeKind;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onToggleLock: () => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const changed = draftValue.trim() !== value.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <section className={`setup-draft-section${changeKind ? ' is-recently-updated' : ''}`}>
      <div className="setup-draft-section-header">
        <h3>作品の核</h3>
        <div className="setup-draft-section-actions">
          {changeKind && <DraftChangeBadge kind={changeKind} />}
          <button type="button" onClick={onToggleLock} disabled={disabled}>
            {locked ? '固定解除' : '固定'}
          </button>
        </div>
      </div>
      <textarea
        className="setup-draft-textarea"
        value={draftValue}
        onChange={(e) => setDraftValue(e.target.value)}
        placeholder="まだ決まっていません"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(draftValue)} disabled={disabled || !changed}>
          保存
        </button>
      </div>
    </section>
  );
}

export function DraftTextList<T extends SetupDraftTextItem | SetupDraftUndecided>({
  title,
  items,
  disabled,
  changes,
  changeSection,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onMove,
  moveLabel,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  title: string;
  items: T[];
  disabled: boolean;
  changes: DraftChanges;
  changeSection: 'confirmed' | 'undecided';
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: T) => boolean;
  onSave: (item: T, value: string) => void;
  onArchive: (item: T) => void;
  onToggleLock: (item: T) => void;
  onMove?: (item: T) => void;
  moveLabel?: string;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, value: string) => void;
}) {
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>{title}</h3>
        <button type="button" onClick={onAdd} disabled={disabled}>
          +追加
        </button>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((item) => (
            <EditableTextRow
              key={item.id}
              dirtyKey={item.id}
              item={item}
              disabled={disabled}
              locked={isLocked(item)}
              changeKind={changes[draftItemChangeKey(changeSection, item.id)]}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
              onMove={onMove}
              moveLabel={moveLabel}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingTextRow
              key={pending.id}
              dirtyKey={`pending-text-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSavePending(pending.id, value)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableTextRow<T extends SetupDraftTextItem | SetupDraftUndecided>({
  dirtyKey,
  item,
  disabled,
  locked,
  changeKind,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
  onMove,
  moveLabel,
}: {
  dirtyKey: string;
  item: T;
  disabled: boolean;
  locked: boolean;
  changeKind?: DraftChangeKind;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (item: T, value: string) => void;
  onArchive: (item: T) => void;
  onToggleLock: (item: T) => void;
  onMove?: (item: T) => void;
  moveLabel?: string;
}) {
  const [value, setValue] = useState(item.text);

  useEffect(() => {
    setValue(item.text);
  }, [item.id, item.text]);

  const changed = value.trim() !== item.text.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(item, value)} disabled={disabled || !changed || !value.trim()}>
          保存
        </button>
        {onMove && moveLabel && (
          <button type="button" onClick={() => onMove(item)} disabled={disabled}>
            {moveLabel}
          </button>
        )}
        <button type="button" onClick={() => onToggleLock(item)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(item)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingTextRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const changed = value.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新しい項目"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(value)} disabled={disabled || !value.trim()}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

function PendingStringRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const changed = value.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <textarea
        className="setup-draft-textarea compact"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="新しい項目"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(value)} disabled={disabled || !value.trim()}>
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

export function DraftCandidateList({
  items,
  disabled,
  hasUnsavedDraftEdits,
  changes,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onMoveToConfirmed,
  onSend,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
  selectedIds,
  onToggleSelection,
  onMixSelected,
}: {
  items: SetupDraftCandidate[];
  disabled: boolean;
  hasUnsavedDraftEdits: boolean;
  changes: DraftChanges;
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: SetupDraftCandidate) => boolean;
  onSave: (item: SetupDraftCandidate, values: { title: string; summary: string }) => void;
  onArchive: (item: SetupDraftCandidate) => void;
  onToggleLock: (item: SetupDraftCandidate) => void;
  onMoveToConfirmed?: (item: SetupDraftCandidate) => void;
  onSend: (message: string) => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, values: { title: string; summary: string }) => void;
  selectedIds: Set<string>;
  onToggleSelection: (id: string) => void;
  onMixSelected: () => void;
}) {
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  const canSend = !disabled && !hasUnsavedDraftEdits;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>候補</h3>
        <div className="setup-draft-section-actions">
          <button type="button" onClick={onAdd} disabled={disabled}>
            +追加
          </button>
          <button type="button" onClick={() => onSend('今の方向とは少し違う候補を、もう一度いくつか出して。')} disabled={!canSend}>
            別の候補をもう一度
          </button>
        </div>
      </div>
      {selectedIds.size >= 2 && (
        <div className="setup-draft-section-mix-actions">
          <button type="button" onClick={onMixSelected} disabled={!canSend}>
            選択した候補を混ぜる
          </button>
        </div>
      )}
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((candidate) => (
            <EditableCandidateRow
              key={candidate.id}
              dirtyKey={candidate.id}
              candidate={candidate}
              disabled={disabled}
              locked={isLocked(candidate)}
              selected={selectedIds.has(candidate.id)}
              changeKind={changes[draftItemChangeKey('candidates', candidate.id)]}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
              onMoveToConfirmed={onMoveToConfirmed}
              onSend={onSend}
              onToggleSelection={onToggleSelection}
              canSend={canSend}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingCandidateRow
              key={pending.id}
              dirtyKey={`pending-candidate-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(values) => onSavePending(pending.id, values)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableCandidateRow({
  dirtyKey,
  candidate,
  disabled,
  locked,
  selected,
  changeKind,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
  onMoveToConfirmed,
  onSend,
  onToggleSelection,
  canSend,
}: {
  dirtyKey: string;
  candidate: SetupDraftCandidate;
  disabled: boolean;
  locked: boolean;
  selected: boolean;
  changeKind?: DraftChangeKind;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (item: SetupDraftCandidate, values: { title: string; summary: string }) => void;
  onArchive: (item: SetupDraftCandidate) => void;
  onToggleLock: (item: SetupDraftCandidate) => void;
  onMoveToConfirmed?: (item: SetupDraftCandidate) => void;
  onSend: (message: string) => void;
  onToggleSelection: (id: string) => void;
  canSend: boolean;
}) {
  const [title, setTitle] = useState(candidate.title);
  const [summary, setSummary] = useState(candidate.summary);

  useEffect(() => {
    setTitle(candidate.title);
    setSummary(candidate.summary);
  }, [candidate.id, candidate.title, candidate.summary]);

  const changed = title.trim() !== candidate.title.trim() || summary.trim() !== candidate.summary.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
      <label className="setup-draft-candidate-select">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelection(candidate.id)}
          disabled={disabled}
        />
      </label>
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave(candidate, { title, summary })}
          disabled={disabled || !changed || (!title.trim() && !summary.trim())}
        >
          保存
        </button>
        {onMoveToConfirmed && (
          <button type="button" onClick={() => onMoveToConfirmed(candidate)} disabled={disabled}>
            確定へ
          </button>
        )}
        <button
          type="button"
          onClick={() => onSend(`候補「${candidate.title}」で進めたい。`)}
          disabled={!canSend}
        >
          これで進める
        </button>
        <button type="button" onClick={() => onToggleLock(candidate)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(candidate)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingCandidateRow({
  dirtyKey,
  disabled,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (values: { title: string; summary: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const changed = title.trim() !== '' || summary.trim() !== '';

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="タイトル"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => onSave({ title, summary })}
          disabled={disabled || (!title.trim() && !summary.trim())}
        >
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

// NOTE: character 編集 UI で受け付ける値の共通形。greeting/dialogueExamples は
// roleplay 用途でだけ入力欄が出るが、型は常に optional で共通化する。呼び出し側は
// 値が undefined の場合は既存値をそのまま維持する（未編集扱い）判定を行う。
interface EditableCharacterValues {
  role: CharacterRole;
  name: string;
  label: string;
  description: string;
  speechStyle: string;
  relationshipNotes: string;
  traits: CharacterTrait[];
  secrets: string;
  greeting?: string;
  dialogueExamples?: string[];
}

export function DraftCharacterList({
  draft,
  disabled,
  changes,
  purpose,
  onDirtyChange,
  isLocked,
  onSave,
  onArchive,
  onToggleLock,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  draft: SetupDraft;
  disabled: boolean;
  changes: DraftChanges;
  purpose: 'novel' | 'roleplay';
  onDirtyChange: (key: string, dirty: boolean) => void;
  isLocked: (item: SetupDraftCharacter) => boolean;
  onSave: (item: SetupDraftCharacter, values: EditableCharacterValues) => void;
  onArchive: (item: SetupDraftCharacter) => void;
  onToggleLock: (item: SetupDraftCharacter) => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, values: EditableCharacterValues) => void;
}) {
  const characters = useMemo(
    () => draft.characters.filter((character) => character.status === 'active'),
    [draft.characters]
  );
  const isEmpty = characters.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>人物</h3>
        <button type="button" onClick={onAdd} disabled={disabled}>
          +追加
        </button>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {characters.map((character) => (
            <EditableCharacterRow
              key={character.id}
              dirtyKey={character.id}
              character={character}
              disabled={disabled}
              locked={isLocked(character)}
              changeKind={changes[draftItemChangeKey('characters', character.id)]}
              purpose={purpose}
              onDirtyChange={onDirtyChange}
              onSave={onSave}
              onArchive={onArchive}
              onToggleLock={onToggleLock}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingCharacterRow
              key={pending.id}
              dirtyKey={`pending-character-${pending.id}`}
              disabled={disabled}
              purpose={purpose}
              onDirtyChange={onDirtyChange}
              onSave={(values) => onSavePending(pending.id, values)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableCharacterRow({
  dirtyKey,
  character,
  disabled,
  locked,
  changeKind,
  purpose,
  onDirtyChange,
  onSave,
  onArchive,
  onToggleLock,
}: {
  dirtyKey: string;
  character: SetupDraftCharacter;
  disabled: boolean;
  locked: boolean;
  changeKind?: DraftChangeKind;
  purpose: 'novel' | 'roleplay';
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (item: SetupDraftCharacter, values: EditableCharacterValues) => void;
  onArchive: (item: SetupDraftCharacter) => void;
  onToggleLock: (item: SetupDraftCharacter) => void;
}) {
  const [role, setRole] = useState<CharacterRole>(character.role);
  const [name, setName] = useState(character.name);
  const [label, setLabel] = useState(character.label);
  const [description, setDescription] = useState(character.description);
  const [speechStyle, setSpeechStyle] = useState(character.speechStyle ?? '');
  const [relationshipNotes, setRelationshipNotes] = useState(character.relationshipNotes ?? '');
  const [traits, setTraits] = useState<CharacterTrait[]>(character.traits ?? []);
  const [secrets, setSecrets] = useState(character.secrets ?? '');
  // NOTE: dialogueExamples は行区切りテキストとして編集 → 保存時に配列へ戻す。
  // greeting は roleplay 用途のみで意味を持つが state は常時保持し UI だけ切替。
  const [greeting, setGreeting] = useState(character.greeting ?? '');
  const [dialogueExamplesText, setDialogueExamplesText] = useState(
    (character.dialogueExamples ?? []).join('\n')
  );

  useEffect(() => {
    setRole(character.role);
    setName(character.name);
    setLabel(character.label);
    setDescription(character.description);
    setSpeechStyle(character.speechStyle ?? '');
    setRelationshipNotes(character.relationshipNotes ?? '');
    setTraits(character.traits ?? []);
    setSecrets(character.secrets ?? '');
    setGreeting(character.greeting ?? '');
    setDialogueExamplesText((character.dialogueExamples ?? []).join('\n'));
  }, [
    character.id,
    character.role,
    character.name,
    character.label,
    character.description,
    character.speechStyle,
    character.relationshipNotes,
    character.traits,
    character.secrets,
    character.greeting,
    character.dialogueExamples,
  ]);

  const dialogueExamplesArray = useMemo(
    () =>
      dialogueExamplesText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 5),
    [dialogueExamplesText]
  );
  const existingDialogueExamples = character.dialogueExamples ?? [];
  const dialogueExamplesChanged =
    dialogueExamplesArray.length !== existingDialogueExamples.length ||
    dialogueExamplesArray.some((item, i) => item !== existingDialogueExamples[i]);
  const traitsChanged =
    traits.length !== (character.traits?.length ?? 0) ||
    traits.some(
      (trait, index) =>
        trait.label !== character.traits?.[index]?.label ||
        trait.text !== character.traits?.[index]?.text
    );

  const changed =
    role !== character.role ||
    name.trim() !== character.name.trim() ||
    label.trim() !== character.label.trim() ||
    description.trim() !== character.description.trim() ||
    speechStyle.trim() !== (character.speechStyle ?? '').trim() ||
    relationshipNotes.trim() !== (character.relationshipNotes ?? '').trim() ||
    secrets.trim() !== (character.secrets ?? '').trim() ||
    traitsChanged ||
    (purpose === 'roleplay' &&
      (greeting.trim() !== (character.greeting ?? '').trim() || dialogueExamplesChanged));

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
      <div className="setup-draft-character-grid">
        <select value={role} onChange={(e) => setRole(e.target.value as CharacterRole)} disabled={disabled}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名"
          disabled={disabled}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名前"
          disabled={disabled}
        />
      </div>
      <textarea
        className="setup-draft-textarea compact"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={speechStyle}
        onChange={(e) => setSpeechStyle(e.target.value)}
        placeholder="口調"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={relationshipNotes}
        onChange={(e) => setRelationshipNotes(e.target.value)}
        placeholder="関係性"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={secrets}
        onChange={(e) => setSecrets(e.target.value)}
        placeholder="見せない面（秘密、建前、外では見せない一面など）"
        disabled={disabled}
      />
      <CharacterTraitsEditor
        idPrefix={`setup-character-${character.id}`}
        value={traits}
        onChange={setTraits}
        disabled={disabled}
      />
      {purpose === 'roleplay' && (
        <>
          <textarea
            className="setup-draft-textarea compact"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="会話開始時の挨拶（1〜3文、最大500字）"
            maxLength={500}
            disabled={disabled}
          />
          <textarea
            className="setup-draft-textarea compact"
            value={dialogueExamplesText}
            onChange={(e) => setDialogueExamplesText(e.target.value)}
            placeholder="口調のセリフ例（1行1件、最大5件、各200字）"
            rows={3}
            disabled={disabled}
          />
        </>
      )}
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() =>
            onSave(character, {
              role,
              name,
              label,
              description,
              speechStyle,
              relationshipNotes,
              traits,
              secrets,
              ...(purpose === 'roleplay'
                ? { greeting, dialogueExamples: dialogueExamplesArray }
                : {}),
            })
          }
          disabled={disabled || !changed || (!label.trim() && !name.trim() && !description.trim())}
        >
          保存
        </button>
        <button type="button" onClick={() => onToggleLock(character)} disabled={disabled}>
          {locked ? '固定解除' : '固定'}
        </button>
        <button type="button" className="danger" onClick={() => onArchive(character)} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}

function PendingCharacterRow({
  dirtyKey,
  disabled,
  purpose,
  onDirtyChange,
  onSave,
  onCancel,
}: {
  dirtyKey: string;
  disabled: boolean;
  purpose: 'novel' | 'roleplay';
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (values: EditableCharacterValues) => void;
  onCancel: () => void;
}) {
  const [role, setRole] = useState<CharacterRole>('supporting');
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [speechStyle, setSpeechStyle] = useState('');
  const [relationshipNotes, setRelationshipNotes] = useState('');
  const [traits, setTraits] = useState<CharacterTrait[]>([]);
  const [secrets, setSecrets] = useState('');
  const [greeting, setGreeting] = useState('');
  const [dialogueExamplesText, setDialogueExamplesText] = useState('');

  const changed =
    role !== 'supporting' ||
    name.trim() !== '' ||
    label.trim() !== '' ||
    description.trim() !== '' ||
    speechStyle.trim() !== '' ||
    relationshipNotes.trim() !== '' ||
    traits.length > 0 ||
    secrets.trim() !== '' ||
    (purpose === 'roleplay' &&
      (greeting.trim() !== '' || dialogueExamplesText.trim() !== ''));

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className="setup-draft-edit-row pending">
      <div className="setup-draft-character-grid">
        <select value={role} onChange={(e) => setRole(e.target.value as CharacterRole)} disabled={disabled}>
          {Object.entries(ROLE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="表示名"
          disabled={disabled}
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="名前"
          disabled={disabled}
        />
      </div>
      <textarea
        className="setup-draft-textarea compact"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="説明"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={speechStyle}
        onChange={(e) => setSpeechStyle(e.target.value)}
        placeholder="口調"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={relationshipNotes}
        onChange={(e) => setRelationshipNotes(e.target.value)}
        placeholder="関係性"
        disabled={disabled}
      />
      <textarea
        className="setup-draft-textarea compact"
        value={secrets}
        onChange={(e) => setSecrets(e.target.value)}
        placeholder="見せない面（秘密、建前、外では見せない一面など）"
        disabled={disabled}
      />
      <CharacterTraitsEditor
        idPrefix={`setup-pending-character-${dirtyKey}`}
        value={traits}
        onChange={setTraits}
        disabled={disabled}
      />
      {purpose === 'roleplay' && (
        <>
          <textarea
            className="setup-draft-textarea compact"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            placeholder="会話開始時の挨拶（1〜3文、最大500字）"
            maxLength={500}
            disabled={disabled}
          />
          <textarea
            className="setup-draft-textarea compact"
            value={dialogueExamplesText}
            onChange={(e) => setDialogueExamplesText(e.target.value)}
            placeholder="口調のセリフ例（1行1件、最大5件、各200字）"
            rows={3}
            disabled={disabled}
          />
        </>
      )}
      <div className="setup-draft-row-actions">
        <button
          type="button"
          onClick={() => {
            const dialogueExamplesArray = dialogueExamplesText
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .slice(0, 5);
            onSave({
              role,
              name,
              label,
              description,
              speechStyle,
              relationshipNotes,
              traits,
              secrets,
              ...(purpose === 'roleplay'
                ? { greeting, dialogueExamples: dialogueExamplesArray }
                : {}),
            });
          }}
          disabled={disabled || (!label.trim() && !name.trim() && !description.trim())}
        >
          保存
        </button>
        <button type="button" onClick={onCancel} disabled={disabled}>
          キャンセル
        </button>
      </div>
    </li>
  );
}

export function DraftStringList({
  section,
  items,
  disabled,
  changes,
  locked,
  onDirtyChange,
  onSave,
  onRemove,
  onToggleLock,
  onAdd,
  pendingRows,
  onCancelPending,
  onSavePending,
}: {
  section: StringDraftSection;
  items: string[];
  disabled: boolean;
  changes: DraftChanges;
  locked: boolean;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onToggleLock: () => void;
  onAdd: () => void;
  pendingRows: PendingDescriptor[];
  onCancelPending: (id: string) => void;
  onSavePending: (id: string, value: string) => void;
}) {
  const title = DRAFT_STRING_SECTION_LABELS[section];
  const isEmpty = items.length === 0 && pendingRows.length === 0;
  return (
    <section className="setup-draft-section">
      <div className="setup-draft-section-header">
        <h3>{title}</h3>
        <div className="setup-draft-section-actions">
          <button type="button" onClick={onAdd} disabled={disabled}>
            +追加
          </button>
          <button type="button" onClick={onToggleLock} disabled={disabled}>
            {locked ? '固定解除' : '固定'}
          </button>
        </div>
      </div>
      {isEmpty ? (
        <p className="setup-draft-placeholder">まだありません</p>
      ) : (
        <ul className="setup-draft-edit-list">
          {items.map((item, index) => (
            <EditableStringRow
              key={`${index}-${item}`}
              dirtyKey={`${section}-${index}`}
              value={item}
              disabled={disabled}
              changeKind={changes[draftStringChangeKey(section, index)]}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSave(index, value)}
              onRemove={() => onRemove(index)}
            />
          ))}
          {pendingRows.map((pending) => (
            <PendingStringRow
              key={pending.id}
              dirtyKey={`pending-string-${section}-${pending.id}`}
              disabled={disabled}
              onDirtyChange={onDirtyChange}
              onSave={(value) => onSavePending(pending.id, value)}
              onCancel={() => onCancelPending(pending.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EditableStringRow({
  dirtyKey,
  value,
  disabled,
  changeKind,
  onDirtyChange,
  onSave,
  onRemove,
}: {
  dirtyKey: string;
  value: string;
  disabled: boolean;
  changeKind?: DraftChangeKind;
  onDirtyChange: (key: string, dirty: boolean) => void;
  onSave: (value: string) => void;
  onRemove: () => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  const changed = draftValue.trim() !== value.trim();

  useEffect(() => {
    onDirtyChange(dirtyKey, changed);
    return () => onDirtyChange(dirtyKey, false);
  }, [changed, dirtyKey, onDirtyChange]);

  return (
    <li className={`setup-draft-edit-row${changeKind ? ' is-recently-updated' : ''}`}>
      {changeKind && <DraftChangeBadge kind={changeKind} />}
      <textarea
        className="setup-draft-textarea compact"
        value={draftValue}
        onChange={(e) => setDraftValue(e.target.value)}
        disabled={disabled}
      />
      <div className="setup-draft-row-actions">
        <button type="button" onClick={() => onSave(draftValue)} disabled={disabled || !changed || !draftValue.trim()}>
          保存
        </button>
        <button type="button" className="danger" onClick={onRemove} disabled={disabled}>
          削除
        </button>
      </div>
    </li>
  );
}
