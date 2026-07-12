import type { ActivePresets } from './types.js';

export const DEFAULT_ACTIVE_PRESET_IDS = {
  genre: 'modern-drama',
  style: 'natural-dialogue',
  pov: 'third-person-close',
  pacing: 'standard',
  density: 'balanced',
  conversation: 'standard',
  relationshipPacing: 'standard',
  intimacy: 'suggestive',
} satisfies ActivePresets;
