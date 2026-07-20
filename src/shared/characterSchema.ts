import { ROLEPLAY_LIMITS } from './defaults.js';
import type { Character, CharacterRole, CharacterTrait } from './types.js';

export const CHARACTER_TRAIT_LIMITS = {
  count: 4,
  labelChars: 12,
  textChars: 200,
} as const;

export type LegacyCharacterInput = Omit<Character, 'traits'> & {
  traits?: unknown;
  want?: unknown;
  fear?: unknown;
};

const CHARACTER_ROLES = new Set<CharacterRole>([
  'protagonist',
  'deuteragonist',
  'supporting',
  'other',
]);

export function isValidCharacterInput(value: unknown): value is LegacyCharacterInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.characterId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.role === 'string' &&
    CHARACTER_ROLES.has(value.role as CharacterRole) &&
    optionalStringArray(value.aliases) &&
    optionalString(value.speechStyle) &&
    optionalString(value.relationshipNotes) &&
    optionalString(value.secrets) &&
    optionalString(value.want) &&
    optionalString(value.fear) &&
    optionalCharacterTraits(value.traits) &&
    optionalString(value.currentState) &&
    optionalString(value.greeting) &&
    optionalStringArray(value.dialogueExamples)
  );
}

export function normalizeCharacterTraits(value: unknown): CharacterTrait[] {
  if (!Array.isArray(value)) return [];

  const result: CharacterTrait[] = [];
  const labels = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.label !== 'string' || typeof item.text !== 'string') {
      continue;
    }
    const label = normalizeTraitLabel(item.label).slice(0, CHARACTER_TRAIT_LIMITS.labelChars);
    const text = normalizeTraitText(item.text).slice(0, CHARACTER_TRAIT_LIMITS.textChars);
    if (!label || !text || labels.has(label)) continue;
    labels.add(label);
    result.push({ label, text });
    if (result.length >= CHARACTER_TRAIT_LIMITS.count) break;
  }
  return result;
}

export function normalizeCharacterTraitsWithLegacy(
  traits: unknown,
  want: unknown,
  fear: unknown
): CharacterTrait[] {
  const result = normalizeCharacterTraits(traits);
  appendLegacyTrait(result, '望み', want);
  appendLegacyTrait(result, '恐れ', fear);
  return result;
}

export function normalizeCharacterForStorage(value: LegacyCharacterInput): Character {
  const greeting = trimToMax(value.greeting, ROLEPLAY_LIMITS.greetingChars);
  const dialogueExamples = normalizeDialogueExamples(value.dialogueExamples);
  const traits = normalizeCharacterTraitsWithLegacy(value.traits, value.want, value.fear);
  const next: Character = {
    characterId: value.characterId,
    name: value.name,
    role: value.role,
    description: value.description,
  };
  if (value.aliases !== undefined) next.aliases = value.aliases;
  if (value.speechStyle !== undefined) next.speechStyle = value.speechStyle;
  if (value.relationshipNotes !== undefined) next.relationshipNotes = value.relationshipNotes;
  if (value.secrets !== undefined) next.secrets = value.secrets;
  if (traits.length > 0) next.traits = traits;
  if (value.currentState !== undefined) next.currentState = value.currentState;
  if (greeting !== undefined) next.greeting = greeting;
  if (dialogueExamples.length > 0) next.dialogueExamples = dialogueExamples;
  return next;
}

export function normalizeCharactersForStorage(
  value: LegacyCharacterInput[]
): Character[] {
  return value.map(normalizeCharacterForStorage);
}

function appendLegacyTrait(result: CharacterTrait[], label: string, value: unknown): void {
  if (
    result.length >= CHARACTER_TRAIT_LIMITS.count ||
    result.some((trait) => trait.label === label) ||
    typeof value !== 'string'
  ) {
    return;
  }
  const text = normalizeTraitText(value).slice(0, CHARACTER_TRAIT_LIMITS.textChars);
  if (text) result.push({ label, text });
}

function normalizeDialogueExamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    if (!text) continue;
    result.push(text.slice(0, ROLEPLAY_LIMITS.dialogueExampleChars));
    if (result.length >= ROLEPLAY_LIMITS.dialogueExamplesCount) break;
  }
  return result;
}

function normalizeTraitLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeTraitText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function trimToMax(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function optionalCharacterTraits(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          isRecord(item) &&
          typeof item.label === 'string' &&
          typeof item.text === 'string'
      ))
  );
}
