import { describe, expect, it } from 'vitest';
import { matchStoryCharacterStates } from '../../src/server/utils/characterStateMatching';
import type { Character, StoryCharacterState } from '../../src/shared/types';

function character(overrides: Partial<Character> = {}): Character {
  return {
    characterId: 'char-a',
    name: 'Alice',
    role: 'protagonist',
    description: '',
    ...overrides,
  };
}

function state(overrides: Partial<StoryCharacterState> = {}): StoryCharacterState {
  return {
    characterId: null,
    name: 'Alice',
    currentState: '',
    knowledge: [],
    relationships: [],
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('matchStoryCharacterStates', () => {
  it('matches by characterId before legacy names', () => {
    const result = matchStoryCharacterStates(
      [character({ aliases: ['Legacy Alice'] })],
      [state({ characterId: 'char-a', name: '別名', currentState: '現在地' })]
    );

    expect(result.byCharacterId.get('char-a')?.currentState).toBe('現在地');
    expect(result.unmatchedStates).toEqual([]);
  });

  it('matches normalized legacy names and aliases', () => {
    const byName = matchStoryCharacterStates(
      [character({ name: 'Ａｌｉｃｅ　Smith' })],
      [state({ name: 'alice smith', currentState: '名前照合' })]
    );
    const byAlias = matchStoryCharacterStates(
      [character({ aliases: ['旧名'] })],
      [state({ name: '旧名', currentState: '別名照合' })]
    );

    expect(byName.byCharacterId.get('char-a')?.currentState).toBe('名前照合');
    expect(byAlias.byCharacterId.get('char-a')?.currentState).toBe('別名照合');
  });

  it('leaves ambiguous aliases unmatched rather than assigning a state to the wrong character', () => {
    const result = matchStoryCharacterStates(
      [character({ characterId: 'char-a', aliases: ['主人公'] }), character({ characterId: 'char-b', aliases: ['主人公'] })],
      [state({ name: '主人公', currentState: '曖昧な状態' })]
    );

    expect(result.byCharacterId.size).toBe(0);
    expect(result.unmatchedStates).toHaveLength(1);
    expect(result.diagnostics.some((item) => item.kind === 'ambiguous_name_or_alias')).toBe(true);
  });

  it('keeps an alias ambiguous even after one of its candidates was matched by id', () => {
    const result = matchStoryCharacterStates(
      [
        character({ characterId: 'char-a', aliases: ['主人公'] }),
        character({ characterId: 'char-b', name: 'Bob', aliases: ['主人公'] }),
      ],
      [
        state({ characterId: 'char-a', name: 'Alice', currentState: 'IDで照合済み' }),
        state({ characterId: null, name: '主人公', currentState: '曖昧な状態' }),
      ]
    );

    expect(result.byCharacterId.get('char-a')?.currentState).toBe('IDで照合済み');
    expect(result.byCharacterId.has('char-b')).toBe(false);
    expect(result.unmatchedStates).toHaveLength(1);
    expect(result.diagnostics.some((item) => item.kind === 'ambiguous_name_or_alias')).toBe(true);
  });

  it('keeps the newest state when StoryState contains duplicate character ids', () => {
    const result = matchStoryCharacterStates(
      [character()],
      [
        state({ characterId: 'char-a', currentState: '古い状態', updatedAt: '2026-07-01T00:00:00.000Z' }),
        state({ characterId: 'char-a', currentState: '新しい状態', updatedAt: '2026-07-02T00:00:00.000Z' }),
      ]
    );

    expect(result.byCharacterId.get('char-a')?.currentState).toBe('新しい状態');
    expect(result.unmatchedStates).toEqual([]);
    expect(result.diagnostics.some((item) => item.kind === 'duplicate_story_state_id')).toBe(true);
  });

  it('leaves states unmatched when configured character ids are duplicated', () => {
    const result = matchStoryCharacterStates(
      [
        character({ characterId: 'duplicated', name: 'Alice' }),
        character({ characterId: 'duplicated', name: 'Bob' }),
      ],
      [state({ characterId: 'duplicated', name: 'Alice', currentState: '現在地' })]
    );

    expect(result.byCharacterId.size).toBe(0);
    expect(result.unmatchedStates).toHaveLength(1);
    expect(result.diagnostics.some((item) => item.kind === 'duplicate_character_id')).toBe(true);
  });

  it('does not use blank names as a fallback key', () => {
    const result = matchStoryCharacterStates(
      [character({ name: '' })],
      [state({ name: '', currentState: '照合してはいけない' })]
    );

    expect(result.byCharacterId.size).toBe(0);
    expect(result.unmatchedStates).toHaveLength(1);
  });
});
