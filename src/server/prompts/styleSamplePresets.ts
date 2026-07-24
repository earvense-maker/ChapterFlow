import { promises as fs } from 'node:fs';
import { STYLE_SAMPLES_PATH } from '../config.js';
import type { StyleSamplePreset } from '../types/index.js';

const MAX_TEXT_CHARS = 1000;

let cache: StyleSamplePreset[] | null = null;

export async function loadStyleSamples(): Promise<StyleSamplePreset[]> {
  if (cache) return cache;
  const text = await fs.readFile(STYLE_SAMPLES_PATH, 'utf-8');
  const parsed = JSON.parse(text) as unknown;
  const items = validateStyleSamplesFile(parsed);
  cache = items;
  return cache;
}

export function validateStyleSamplesFile(value: unknown): StyleSamplePreset[] {
  if (!isPlainObject(value)) {
    throw new Error('style-samples.json: root must be an object');
  }
  const { version, items } = value as { version?: unknown; items?: unknown };
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new Error('style-samples.json: "version" must be a number');
  }
  if (!Array.isArray(items)) {
    throw new Error('style-samples.json: "items" must be an array');
  }

  const validated: StyleSamplePreset[] = [];
  const seenIds = new Set<string>();
  items.forEach((raw, index) => {
    const label = `style-samples.json: items[${index}]`;
    if (!isPlainObject(raw)) {
      throw new Error(`${label} must be an object`);
    }
    const id = requireNonEmptyString(raw.id, `${label}.id`);
    if (seenIds.has(id)) {
      throw new Error(`${label}.id "${id}" duplicates an earlier item`);
    }
    seenIds.add(id);
    const labelText = requireNonEmptyString(raw.label, `${label}.label`);
    const description = requireNonEmptyString(raw.description, `${label}.description`);
    const bodyText = requireNonEmptyString(raw.text, `${label}.text`);
    if (bodyText.length > MAX_TEXT_CHARS) {
      throw new Error(`${label}.text exceeds ${MAX_TEXT_CHARS} characters`);
    }
    validated.push({ id, label: labelText, description, text: bodyText });
  });

  return validated;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
