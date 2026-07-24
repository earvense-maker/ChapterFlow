import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_DIR } from '../../src/server/config';

// NOTE: credentialService はモジュールスコープにキャッシュを持つので、
// テストごとに vi.resetModules() で読み直さないと前のテストの状態が漏れる。
type CredentialService = typeof import('../../src/server/services/credentialService');

const CREDENTIALS_PATH = path.join(CONFIG_DIR, 'credentials.json');

async function freshService(): Promise<CredentialService> {
  vi.resetModules();
  return import('../../src/server/services/credentialService');
}

async function writeCredentialsFile(data: unknown): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CREDENTIALS_PATH, JSON.stringify(data), 'utf-8');
}

beforeEach(async () => {
  await fs.rm(CREDENTIALS_PATH, { force: true });
});

afterEach(async () => {
  await fs.rm(CREDENTIALS_PATH, { force: true });
});

describe('loadCredentials', () => {
  it('returns an empty object when no credentials file exists yet', async () => {
    const service = await freshService();

    expect(await service.loadCredentials()).toEqual({});
  });

  it('reads the stored providers from disk', async () => {
    await writeCredentialsFile({ gemini: 'key-gemini', openai: 'key-openai' });
    const service = await freshService();

    expect(await service.loadCredentials()).toEqual({
      gemini: 'key-gemini',
      openai: 'key-openai',
    });
  });

  it('serves later calls from the cache instead of re-reading the file', async () => {
    await writeCredentialsFile({ gemini: 'original' });
    const service = await freshService();
    await service.loadCredentials();

    await writeCredentialsFile({ gemini: 'changed-behind-our-back' });

    expect((await service.loadCredentials()).gemini).toBe('original');
  });
});

describe('saveCredential', () => {
  it('persists the key and makes it readable without another load', async () => {
    const service = await freshService();

    await service.saveCredential('gemini', 'key-gemini');

    expect(service.getCredential('gemini')).toBe('key-gemini');
    expect(JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8'))).toEqual({
      gemini: 'key-gemini',
    });
  });

  it('merges into the existing providers rather than replacing the file', async () => {
    await writeCredentialsFile({ gemini: 'key-gemini' });
    const service = await freshService();

    await service.saveCredential('deepseek', 'key-deepseek');

    // NOTE: ここが壊れると、1社のキーを保存しただけで他社のキーが消える。
    expect(JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8'))).toEqual({
      gemini: 'key-gemini',
      deepseek: 'key-deepseek',
    });
  });

  it('overwrites the key when the same provider is saved again', async () => {
    const service = await freshService();

    await service.saveCredential('gemini', 'old');
    await service.saveCredential('gemini', 'new');

    expect(service.getCredential('gemini')).toBe('new');
    expect(await service.listStoredProviders()).toEqual(['gemini']);
  });

  it('creates the config directory when it is missing', async () => {
    await fs.rm(CONFIG_DIR, { recursive: true, force: true });
    const service = await freshService();

    await service.saveCredential('xai', 'key-xai');

    expect((await fs.stat(CONFIG_DIR)).isDirectory()).toBe(true);
  });
});

describe('getCredential', () => {
  it('returns undefined before the cache has ever been populated', async () => {
    await writeCredentialsFile({ gemini: 'key-gemini' });
    const service = await freshService();

    // NOTE: getCredential は同期関数でファイルを読まない。呼び出し側が先に
    // loadCredentials / reloadCredentials を通す必要がある、という契約の確認。
    expect(service.getCredential('gemini')).toBeUndefined();

    await service.loadCredentials();
    expect(service.getCredential('gemini')).toBe('key-gemini');
  });

  it('returns undefined for a provider that was never stored', async () => {
    const service = await freshService();
    await service.loadCredentials();

    expect(service.getCredential('openrouter')).toBeUndefined();
  });
});

describe('reloadCredentials', () => {
  it('picks up a file that changed outside the process', async () => {
    await writeCredentialsFile({ gemini: 'original' });
    const service = await freshService();
    await service.loadCredentials();

    await writeCredentialsFile({ gemini: 'rotated', openai: 'added' });
    await service.reloadCredentials();

    expect(service.getCredential('gemini')).toBe('rotated');
    expect(service.getCredential('openai')).toBe('added');
  });

  it('clears entries for a provider removed from the file', async () => {
    await writeCredentialsFile({ gemini: 'key-gemini', openai: 'key-openai' });
    const service = await freshService();
    await service.loadCredentials();

    await writeCredentialsFile({ gemini: 'key-gemini' });
    await service.reloadCredentials();

    expect(service.getCredential('openai')).toBeUndefined();
    expect(await service.listStoredProviders()).toEqual(['gemini']);
  });
});

describe('listStoredProviders', () => {
  it('returns an empty list when nothing has been saved', async () => {
    const service = await freshService();

    expect(await service.listStoredProviders()).toEqual([]);
  });

  it('lists every provider that has a stored key', async () => {
    await writeCredentialsFile({ gemini: 'a', deepseek: 'b', xai: 'c' });
    const service = await freshService();

    expect((await service.listStoredProviders()).sort()).toEqual(['deepseek', 'gemini', 'xai']);
  });
});
