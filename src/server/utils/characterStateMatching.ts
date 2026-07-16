import type { Character, CharacterId, StoryCharacterState } from '../types/index.js';

export interface CharacterStateMatchDiagnostic {
  kind: 'duplicate_story_state_id' | 'duplicate_character_id' | 'ambiguous_name_or_alias';
  message: string;
}

export interface CharacterStateMatchResult {
  byCharacterId: Map<CharacterId, StoryCharacterState>;
  unmatchedStates: StoryCharacterState[];
  diagnostics: CharacterStateMatchDiagnostic[];
}

interface IndexedState {
  index: number;
  state: StoryCharacterState;
}

// NOTE: StoryState は旧データで characterId を持たないことがあるため、
// ID を最優先にしつつ名前・aliases に後方互換のフォールバックを設ける。
// 曖昧な照合は「未照合」に倒し、別人物の初期状態を抑制しない。
export function matchStoryCharacterStates(
  characters: Character[],
  states: StoryCharacterState[]
): CharacterStateMatchResult {
  const diagnostics: CharacterStateMatchDiagnostic[] = [];
  const indexedStates = states.map((state, index) => ({ state, index }));
  const ignoredStateIndexes = new Set<number>();
  const statesByCharacterId = new Map<string, IndexedState[]>();

  for (const entry of indexedStates) {
    const characterId = entry.state.characterId?.trim();
    if (!characterId) continue;
    const list = statesByCharacterId.get(characterId) ?? [];
    list.push(entry);
    statesByCharacterId.set(characterId, list);
  }

  for (const [characterId, entries] of statesByCharacterId) {
    const duplicates = sortNewestFirst(entries).slice(1);
    if (duplicates.length > 0) {
      for (const duplicate of duplicates) ignoredStateIndexes.add(duplicate.index);
      diagnostics.push({
        kind: 'duplicate_story_state_id',
        message: `characterId "${characterId}" の StoryState が重複しているため、最新の状態だけを使用しました。`,
      });
    }
  }

  const charactersById = new Map<string, Character[]>();
  for (const character of characters) {
    const characterId = character.characterId.trim();
    if (!characterId) continue;
    const list = charactersById.get(characterId) ?? [];
    list.push(character);
    charactersById.set(characterId, list);
  }

  const duplicateCharacterIds = new Set<string>();
  for (const [characterId, matchedCharacters] of charactersById) {
    if (matchedCharacters.length <= 1) continue;
    duplicateCharacterIds.add(characterId);
    diagnostics.push({
      kind: 'duplicate_character_id',
      message: `characterId "${characterId}" の人物設定が重複しているため、StoryState を自動照合しません。`,
    });
  }

  const byCharacterId = new Map<CharacterId, StoryCharacterState>();
  const matchedStateIndexes = new Set<number>();
  const matchedCharacterIds = new Set<CharacterId>();

  const assign = (character: Character, entry: IndexedState): boolean => {
    if (matchedCharacterIds.has(character.characterId) || matchedStateIndexes.has(entry.index)) {
      return false;
    }
    byCharacterId.set(character.characterId, entry.state);
    matchedCharacterIds.add(character.characterId);
    matchedStateIndexes.add(entry.index);
    return true;
  };

  // 1. characterId の確定一致。
  for (const entry of sortNewestFirst(indexedStates)) {
    if (ignoredStateIndexes.has(entry.index)) continue;
    const stateCharacterId = entry.state.characterId?.trim();
    if (!stateCharacterId || duplicateCharacterIds.has(stateCharacterId)) continue;
    const candidates = charactersById.get(stateCharacterId) ?? [];
    if (candidates.length === 1) assign(candidates[0], entry);
  }

  // 2. legacy StoryState の名前一致。候補が一人だけの場合に限る。
  for (const entry of sortNewestFirst(indexedStates)) {
    if (ignoredStateIndexes.has(entry.index) || matchedStateIndexes.has(entry.index)) continue;
    const token = normalizeComparableText(entry.state.name);
    if (!token) continue;
    const candidates = characters.filter(
      (character) =>
        Boolean(character.characterId.trim()) &&
        !duplicateCharacterIds.has(character.characterId) &&
        normalizeComparableText(character.name) === token
    );
    if (candidates.length === 1 && !matchedCharacterIds.has(candidates[0].characterId)) {
      assign(candidates[0], entry);
    } else if (candidates.length > 1) {
      diagnostics.push({
        kind: 'ambiguous_name_or_alias',
        message: `StoryState の名前 "${entry.state.name}" が複数人物に一致するため、照合しません。`,
      });
    }
  }

  // 3. aliases の後方互換フォールバック。
  for (const entry of sortNewestFirst(indexedStates)) {
    if (ignoredStateIndexes.has(entry.index) || matchedStateIndexes.has(entry.index)) continue;
    const token = normalizeComparableText(entry.state.name);
    if (!token) continue;
    const candidates = characters.filter(
      (character) =>
        Boolean(character.characterId.trim()) &&
        !duplicateCharacterIds.has(character.characterId) &&
        (character.aliases ?? []).some((alias) => normalizeComparableText(alias) === token)
    );
    if (candidates.length === 1 && !matchedCharacterIds.has(candidates[0].characterId)) {
      assign(candidates[0], entry);
    } else if (candidates.length > 1) {
      diagnostics.push({
        kind: 'ambiguous_name_or_alias',
        message: `StoryState の別名 "${entry.state.name}" が複数人物に一致するため、照合しません。`,
      });
    }
  }

  const unmatchedStates = indexedStates
    .filter(
      (entry) => !ignoredStateIndexes.has(entry.index) && !matchedStateIndexes.has(entry.index)
    )
    .map((entry) => entry.state);

  return { byCharacterId, unmatchedStates, diagnostics };
}

export function normalizeComparableText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function sortNewestFirst(entries: IndexedState[]): IndexedState[] {
  return [...entries].sort((a, b) => {
    const aTime = Date.parse(a.state.updatedAt);
    const bTime = Date.parse(b.state.updatedAt);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid && bValid && aTime !== bTime) return bTime - aTime;
    if (aValid !== bValid) return aValid ? -1 : 1;
    return a.index - b.index;
  });
}
