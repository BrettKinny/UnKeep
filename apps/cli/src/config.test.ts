import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveConfiguration, unkeepConfigDirectory } from './config.js';
import { JsonFileClientStorage } from './storage.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test('resolves flags over environment over config file', () => {
  const file = {
    endpoint: 'https://file.example',
    credential: 'file-credential',
    vaultKey: 'file-key',
  };
  const environment = {
    UNKEEP_ENDPOINT: 'https://env.example',
    UNKEEP_CREDENTIAL: 'env-credential',
    UNKEEP_VAULT_KEY: 'env-key',
  };
  expect(resolveConfiguration({}, {}, file)).toEqual(file);
  expect(resolveConfiguration({}, environment, file)).toEqual({
    endpoint: 'https://env.example',
    credential: 'env-credential',
    vaultKey: 'env-key',
  });
  expect(resolveConfiguration({
    endpoint: 'https://flag.example',
    credential: 'flag-credential',
    vaultKey: 'flag-key',
  }, environment, file)).toEqual({
    endpoint: 'https://flag.example',
    credential: 'flag-credential',
    vaultKey: 'flag-key',
  });
});

test('uses the saved SDK session as file configuration', () => {
  expect(resolveConfiguration({}, {}, {
    vault_key: 'saved-key',
    'unkeep-relay-session': {
      endpoint: 'https://saved.example',
      credential: 'saved-credential',
      instanceId: 'instance',
      deviceId: 'device',
    },
  })).toEqual({
    endpoint: 'https://saved.example',
    credential: 'saved-credential',
    vaultKey: 'saved-key',
  });
});

describe('JsonFileClientStorage', () => {
  test('persists SDK values atomically in a private config file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unkeep-cli-storage-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'nested', 'config.json');
    const storage = new JsonFileClientStorage(file);
    await storage.set('credential', 'secret');
    await storage.set('cursor', 3);
    expect(await storage.get('credential')).toBe('secret');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ credential: 'secret', cursor: 3 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await storage.delete('credential');
    expect(await storage.get('credential')).toBeNull();
  });
});

test('places state below XDG_CONFIG_HOME when configured', () => {
  expect(unkeepConfigDirectory({ XDG_CONFIG_HOME: '/tmp/example-xdg' })).toBe('/tmp/example-xdg/unkeep');
  expect(unkeepConfigDirectory({}, '/tmp/explicit-unkeep')).toBe('/tmp/explicit-unkeep');
});
