import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from '../config.js';
import { ensureDir, readJsonFile, safeWriteJson } from '../utils/safeWrite.js';

interface CredentialsFile {
  [provider: string]: string;
}

const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

let cache: CredentialsFile | null = null;

export async function loadCredentials(): Promise<CredentialsFile> {
  if (cache) return cache;
  const data = await readJsonFile<CredentialsFile>(CREDENTIALS_PATH);
  cache = data ?? {};
  return cache;
}

export async function saveCredential(provider: string, apiKey: string): Promise<void> {
  await ensureDir(CONFIG_DIR);
  const credentials = await loadCredentials();
  credentials[provider] = apiKey;
  await safeWriteJson(CREDENTIALS_PATH, credentials);
  cache = credentials;
}

export function getCredential(provider: string): string | undefined {
  return cache?.[provider];
}

export async function reloadCredentials(): Promise<void> {
  cache = null;
  await loadCredentials();
}

export async function listStoredProviders(): Promise<string[]> {
  const credentials = await loadCredentials();
  return Object.keys(credentials);
}
