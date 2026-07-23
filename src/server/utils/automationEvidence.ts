import type { Character } from '../types/index.js';

// Keep the persisted sourceRef representation identical to the text supplied
// to the scan model. Retries rehydrate this text for the same quote check.
export function renderAutomationEvidenceCharacters(characters: Character[]): string {
  if (characters.length === 0) return '（未設定）';
  return characters
    .map((character) =>
      [
        `id: ${character.characterId}`,
        `name: ${character.name}`,
        `role: ${character.role}`,
        `description: ${character.description}`,
        `speechStyle: ${character.speechStyle ?? ''}`,
        `relationshipNotes: ${character.relationshipNotes ?? ''}`,
        `traits: ${JSON.stringify(character.traits ?? [])}`,
      ].join('\n')
    )
    .join('\n\n');
}
